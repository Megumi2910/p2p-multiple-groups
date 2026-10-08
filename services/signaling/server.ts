import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual, randomUUID, createHmac } from 'node:crypto'
import type { Socket } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import {
  MAX_SIGNALING_MESSAGE_SIZE,
  isClientSignalingMessage,
  type ClientSignalingMessage,
  type ServerSignalingMessage,
  type SignalingIceConfig,
  type SignalingRosterPeer
} from '../../src/shared/p2p-wire.ts'
import { validateDisplayName, validateRoomId } from '../../src/shared/p2p.ts'

export interface SignalingOptions {
  host: string
  port: number
  roomId: string
  token: string
  turnHost?: string
  turnSecret?: string
  stunUrl?: string
  turnUrl?: string
  turnUsername?: string
  turnCredential?: string
}

interface PeerSession {
  peerId: string
  sessionId: string
  joinOrder: number
  displayName: string
  supernodeEligible: boolean
  ws: WebSocket
  lastPong: number
  // Rate limiter token bucket: max burst 40, replenish 20 tokens per sec
  tokens: number
  lastTokenUpdate: number
}

export interface SignalingServerInstance {
  address: { host: string; port: number }
  close(): Promise<void>
}

export async function createSignalingServer(options: SignalingOptions): Promise<SignalingServerInstance> {
  const roomCheck = validateRoomId(options.roomId)
  if (!roomCheck.valid) {
    throw new Error(`Invalid roomId: ${roomCheck.error}`)
  }
  const configuredRoomId = roomCheck.value
  const expectedTokenBuffer = Buffer.from(options.token, 'utf-8')

  const epoch = randomUUID()
  let revision = 1
  let nextJoinOrder = 1
  const peers = new Map<string, PeerSession>() // peerId -> PeerSession
  const sockets = new Set<WebSocket>()
  let isClosing = false

  function generateIceConfig(sessionId: string): SignalingIceConfig {
    if (options.turnHost && options.turnSecret) {
      const expirySec = Math.floor(Date.now() / 1000) + 3600
      const username = `${expirySec}:${sessionId}`
      const hmac = createHmac('sha1', options.turnSecret)
      hmac.update(username)
      const credential = hmac.digest('base64')

      return {
        expiresAt: expirySec * 1000,
        servers: [
          { urls: `stun:${options.turnHost}:3478` },
          { urls: `turns:${options.turnHost}:5349?transport=tcp`, username, credential }
        ]
      }
    }
    if (options.turnUrl && options.turnUsername && options.turnCredential) {
      const stunUrl = options.stunUrl || 'stun:stun.relay.metered.ca:80'
      return {
        expiresAt: Date.now() + 3600000,
        servers: [
          { urls: stunUrl },
          {
            urls: options.turnUrl,
            username: options.turnUsername,
            credential: options.turnCredential
          }
        ]
      }
    }
    if (options.stunUrl) {
      return {
        expiresAt: Date.now() + 3600000,
        servers: [{ urls: options.stunUrl }]
      }
    }
    return {
      expiresAt: Date.now() + 3600000,
      servers: []
    }
  }

  function getRoster(): SignalingRosterPeer[] {
    return Array.from(peers.values()).map((p) => ({
      peerId: p.peerId,
      sessionId: p.sessionId,
      joinOrder: p.joinOrder,
      displayName: p.displayName,
      supernodeEligible: p.supernodeEligible
    }))
  }

  function broadcast(msg: ServerSignalingMessage, exceptPeerId?: string): void {
    const data = Buffer.from(JSON.stringify(msg), 'utf-8')
    for (const [peerId, peer] of peers.entries()) {
      if (peerId !== exceptPeerId && peer.ws.readyState === WebSocket.OPEN) {
        if (peer.ws.bufferedAmount < 1048576) {
          peer.ws.send(data)
        } else {
          // Outbound backlog > 1 MiB, close socket
          peer.ws.close(1008, 'Backlog exceeded')
        }
      }
    }
  }

  function sendToPeer(peer: PeerSession, msg: ServerSignalingMessage): void {
    if (peer.ws.readyState === WebSocket.OPEN) {
      if (peer.ws.bufferedAmount < 1048576) {
        peer.ws.send(Buffer.from(JSON.stringify(msg), 'utf-8'))
      } else {
        peer.ws.close(1008, 'Backlog exceeded')
      }
    }
  }

  function removePeer(peerId: string): void {
    const session = peers.get(peerId)
    if (session) {
      peers.delete(peerId)
      revision++
      broadcast({
        v: 1,
        type: 'roster',
        epoch,
        revision,
        peers: getRoster()
      })
    }
  }

  const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  })

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })

  httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (isClosing) {
      socket.destroy()
      return
    }

    const parsedUrl = new URL(req.url || '', `http://${options.host || '127.0.0.1'}`)
    if (parsedUrl.pathname !== '/signal') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    // Never accept token in URL queries
    if (parsedUrl.search) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    const authHeader = req.headers['authorization']
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    const providedToken = authHeader.slice('Bearer '.length).trim()
    const providedBuffer = Buffer.from(providedToken, 'utf-8')

    if (
      providedBuffer.length !== expectedTokenBuffer.length ||
      !timingSafeEqual(providedBuffer, expectedTokenBuffer)
    ) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws: WebSocket) => {
    sockets.add(ws)
    let currentPeerId: string | null = null
    let joined = false

    // Initial message deadline: 5 seconds
    const joinTimer = setTimeout(() => {
      if (!joined) {
        ws.close(1008, 'Join timeout')
      }
    }, 5000)

    const sessionState: {
      tokens: number
      lastTokenUpdate: number
    } = {
      tokens: 40,
      lastTokenUpdate: Date.now()
    }

    function checkRateLimit(): boolean {
      const now = Date.now()
      const elapsed = (now - sessionState.lastTokenUpdate) / 1000
      sessionState.lastTokenUpdate = now
      sessionState.tokens = Math.min(40, sessionState.tokens + elapsed * 20)
      if (sessionState.tokens < 1) {
        return false
      }
      sessionState.tokens -= 1
      return true
    }

    ws.on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        ws.close(1003, 'Binary frames not supported')
        return
      }

      if (raw.length > MAX_SIGNALING_MESSAGE_SIZE) {
        ws.close(1009, 'Message too large')
        return
      }

      if (!checkRateLimit()) {
        ws.close(1008, 'Rate limit exceeded')
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw.toString('utf-8'))
      } catch {
        ws.close(1008, 'Invalid JSON')
        return
      }

      if (!isClientSignalingMessage(parsed)) {
        ws.close(1008, 'Invalid message format')
        return
      }

      const msg = parsed as ClientSignalingMessage

      if (!joined) {
        if (msg.type !== 'join') {
          ws.close(1008, 'Must join first')
          return
        }

        if (msg.roomId !== configuredRoomId) {
          const err: ServerSignalingMessage = {
            v: 1,
            type: 'error',
            code: 'ROOM_MISMATCH',
            message: 'Room ID mismatch'
          }
          ws.send(JSON.stringify(err))
          ws.close(1008, 'Room mismatch')
          return
        }

        if (peers.has(msg.peerId)) {
          const err: ServerSignalingMessage = {
            v: 1,
            type: 'error',
            code: 'DUPLICATE_PEER_ID',
            message: 'Peer ID is already active in room'
          }
          ws.send(JSON.stringify(err))
          ws.close(1008, 'Duplicate peer ID')
          return
        }

        if (peers.size >= 16) {
          const err: ServerSignalingMessage = {
            v: 1,
            type: 'error',
            code: 'ROOM_FULL',
            message: 'Room capacity reached (16 peers max)'
          }
          ws.send(JSON.stringify(err))
          ws.close(1008, 'Room full')
          return
        }

        const nameCheck = validateDisplayName(msg.displayName)
        if (!nameCheck.valid) {
          ws.close(1008, 'Invalid display name')
          return
        }

        clearTimeout(joinTimer)
        joined = true
        currentPeerId = msg.peerId

        const sessionId = randomUUID()
        const joinOrder = nextJoinOrder++
        const peerSession: PeerSession = {
          peerId: msg.peerId,
          sessionId,
          joinOrder,
          displayName: nameCheck.value,
          supernodeEligible: Boolean(msg.supernodeEligible),
          ws,
          lastPong: Date.now(),
          tokens: sessionState.tokens,
          lastTokenUpdate: sessionState.lastTokenUpdate
        }

        peers.set(msg.peerId, peerSession)

        // Send Welcome with iceConfig
        const welcome: ServerSignalingMessage = {
          v: 1,
          type: 'welcome',
          sessionId,
          epoch,
          iceConfig: generateIceConfig(sessionId)
        }
        sendToPeer(peerSession, welcome)

        // Broadcast updated roster
        revision++
        broadcast({
          v: 1,
          type: 'roster',
          epoch,
          revision,
          peers: getRoster()
        })
        return
      }

      // Already joined
      const session = peers.get(currentPeerId!)
      if (!session) return

      switch (msg.type) {
        case 'eligibility': {
          if (session.supernodeEligible !== msg.supernodeEligible) {
            session.supernodeEligible = msg.supernodeEligible
            revision++
            broadcast({
              v: 1,
              type: 'roster',
              epoch,
              revision,
              peers: getRoster()
            })
          }
          break
        }
        case 'leave': {
          removePeer(currentPeerId!)
          ws.close(1000, 'Normal leave')
          break
        }
        case 'ice-config': {
          sendToPeer(session, {
            v: 1,
            type: 'ice-config',
            iceConfig: generateIceConfig(session.sessionId)
          })
          break
        }
        case 'signal': {
          const target = peers.get(msg.targetPeerId)
          if (target && target.sessionId === msg.targetSessionId) {
            sendToPeer(target, {
              v: 1,
              type: 'signal',
              fromPeerId: session.peerId,
              fromSessionId: session.sessionId,
              connectionId: msg.connectionId,
              kind: msg.kind,
              payload: msg.payload
            })
          }
          break
        }
      }
    })

    ws.on('pong', () => {
      if (currentPeerId) {
        const session = peers.get(currentPeerId)
        if (session) {
          session.lastPong = Date.now()
        }
      }
    })

    ws.on('close', (code, reason) => {
      clearTimeout(joinTimer)
      sockets.delete(ws)
      if (currentPeerId) {
        removePeer(currentPeerId)
      }
    })
    ws.on('error', () => {
      clearTimeout(joinTimer)
      sockets.delete(ws)
      if (currentPeerId) {
        removePeer(currentPeerId)
      }
    })
  })

  // Heartbeat & roster freshness timer: run every 2s
  const heartbeatTimer = setInterval(() => {
    if (isClosing) return
    const now = Date.now()
    // Ping all active sessions and evict if >8s without pong
    for (const [peerId, peer] of peers.entries()) {
      if (now - peer.lastPong > 8000) {
        peer.ws.terminate()
        removePeer(peerId)
      } else if (peer.ws.readyState === WebSocket.OPEN) {
        try {
          peer.ws.ping()
        } catch {
          // ignore
        }
      }
    }

    // Send current roster every 2 seconds to renew freshness
    if (peers.size > 0) {
      broadcast({
        v: 1,
        type: 'roster',
        epoch,
        revision,
        peers: getRoster()
      })
    }
  }, 2000)

  // Start HTTP listening
  const { promise: listenPromise, resolve: resolveListen, reject: rejectListen } = Promise.withResolvers<void>()

  httpServer.listen(options.port, options.host, () => {
    resolveListen()
  })

  httpServer.on('error', (err) => {
    rejectListen(err)
  })

  await listenPromise

  const addressInfo = httpServer.address()
  const actualPort = typeof addressInfo === 'object' && addressInfo ? addressInfo.port : options.port
  const actualHost = typeof addressInfo === 'object' && addressInfo ? addressInfo.address : options.host

  return {
    address: { host: actualHost, port: actualPort },
    async close() {
      if (isClosing) return
      isClosing = true
      clearInterval(heartbeatTimer)

      for (const ws of sockets) {
        try {
          ws.close(1001, 'Server shutting down')
        } catch {
          // ignore
        }
      }
      sockets.clear()
      peers.clear()

      const { promise: wssPromise, resolve: resolveWss } = Promise.withResolvers<void>()
      wss.close(() => {
        resolveWss()
      })
      await wssPromise

      const { promise: httpPromise, resolve: resolveHttp } = Promise.withResolvers<void>()
      httpServer.close(() => {
        resolveHttp()
      })
      await httpPromise
    }
  }
}
