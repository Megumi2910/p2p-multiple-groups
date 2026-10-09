import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual, randomUUID, createHmac } from 'node:crypto'
import type { Socket } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import {
  MAX_SIGNALING_MESSAGE_SIZE,
  isClientSignalingMessage,
  isClientSignalingMessageV2,
  type ClientSignalingMessage,
  type ClientSignalingMessageV2,
  type ServerSignalingMessage,
  type ServerSignalingMessageV2,
  type SignalingIceConfig,
  type SignalingRosterPeer,
  type SignalingRosterPeerV2,
  type GroupJoinedMessage
} from '../../src/shared/p2p-wire.ts'
import {
  validateDisplayName,
  validateGroupId,
  validateRoomId,
  validateToken
} from '../../src/shared/p2p.ts'

export interface SignalingGroupConfig {
  groupId: string
  token: string
}

export interface SignalingOptions {
  host: string
  port: number
  groups?: SignalingGroupConfig[]
  roomId?: string
  token?: string
  turnHost?: string
  turnSecret?: string
  stunUrl?: string
  turnUrl?: string
  turnUsername?: string
  turnCredential?: string
}

export interface SignalingServerInstance {
  address: { host: string; port: number }
  close(): Promise<void>
}

interface SocketSession {
  peerId: string | null
  sessionId: string | null
  displayName: string
  ws: WebSocket
  lastPong: number
  tokens: number
  lastTokenUpdate: number
  joinedGroupIds: Set<string>
  v1RoomId: string | null
}

interface GroupMember {
  membershipId: string
  peerId: string
  sessionId: string
  joinOrder: number
  displayName: string
  supernodeEligible: boolean
  ws: WebSocket
}

interface GroupRuntimeState {
  groupId: string
  token: string
  tokenBuffer: Buffer
  epoch: string
  revision: number
  nextJoinOrder: number
  members: Map<string, GroupMember> // peerId -> GroupMember
}

export async function createSignalingServer(options: SignalingOptions): Promise<SignalingServerInstance> {
  // Validate and initialize group configurations
  const groupDefinitions: SignalingGroupConfig[] = []

  if (options.groups && options.groups.length > 0) {
    const seenIds = new Set<string>()
    const seenTokens = new Set<string>()

    for (let i = 0; i < options.groups.length; i++) {
      const g = options.groups[i]
      const groupCheck = validateGroupId(g.groupId)
      if (!groupCheck.valid) {
        throw new Error(`Invalid groupId at index ${i}: ${groupCheck.error}`)
      }
      const tokenCheck = validateToken(g.token)
      if (!tokenCheck.valid) {
        throw new Error(`Invalid token for group "${g.groupId}": ${tokenCheck.error}`)
      }
      if (seenIds.has(groupCheck.value)) {
        throw new Error(`Duplicate groupId: "${groupCheck.value}"`)
      }
      if (seenTokens.has(tokenCheck.value)) {
        throw new Error('Duplicate token in group configuration; tokens must be distinct across groups')
      }
      seenIds.add(groupCheck.value)
      seenTokens.add(tokenCheck.value)
      groupDefinitions.push({ groupId: groupCheck.value, token: tokenCheck.value })
    }
  } else if (options.roomId && options.token) {
    const roomCheck = validateRoomId(options.roomId)
    if (!roomCheck.valid) {
      throw new Error(`Invalid roomId: ${roomCheck.error}`)
    }
    const tokenCheck = validateToken(options.token)
    if (!tokenCheck.valid) {
      throw new Error(`Invalid token: ${tokenCheck.error}`)
    }
    groupDefinitions.push({ groupId: roomCheck.value, token: tokenCheck.value })
  } else {
    throw new Error('Signaling server requires at least one group configuration')
  }

  // Group runtime map
  const groupMap = new Map<string, GroupRuntimeState>()
  const validTokenBuffers: Buffer[] = []

  for (const g of groupDefinitions) {
    const tokenBuffer = Buffer.from(g.token, 'utf-8')
    validTokenBuffers.push(tokenBuffer)
    groupMap.set(g.groupId, {
      groupId: g.groupId,
      token: g.token,
      tokenBuffer,
      epoch: randomUUID(),
      revision: 1,
      nextJoinOrder: 1,
      members: new Map()
    })
  }

  // Active sockets and registration map
  const activeSocketsByPeerId = new Map<string, WebSocket>() // peerId -> WebSocket
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

  function getRosterV2(group: GroupRuntimeState): SignalingRosterPeerV2[] {
    return Array.from(group.members.values()).map((m) => ({
      peerId: m.peerId,
      sessionId: m.sessionId,
      membershipId: m.membershipId,
      joinOrder: m.joinOrder,
      displayName: m.displayName,
      supernodeEligible: m.supernodeEligible
    }))
  }

  function getRosterV1(group: GroupRuntimeState): SignalingRosterPeer[] {
    return Array.from(group.members.values()).map((m) => ({
      peerId: m.peerId,
      sessionId: m.sessionId,
      joinOrder: m.joinOrder,
      displayName: m.displayName,
      supernodeEligible: m.supernodeEligible
    }))
  }

  function broadcastGroupRosterV2(group: GroupRuntimeState, exceptPeerId?: string): void {
    const msg: ServerSignalingMessageV2 = {
      v: 2,
      type: 'roster',
      groupId: group.groupId,
      epoch: group.epoch,
      revision: group.revision,
      peers: getRosterV2(group)
    }
    const data = Buffer.from(JSON.stringify(msg), 'utf-8')
    for (const [peerId, member] of group.members.entries()) {
      if (peerId !== exceptPeerId && member.ws.readyState === WebSocket.OPEN) {
        if (member.ws.bufferedAmount < 1048576) {
          member.ws.send(data)
        } else {
          member.ws.close(1008, 'Backlog exceeded')
        }
      }
    }
  }

  function broadcastGroupRosterV1(group: GroupRuntimeState, exceptPeerId?: string): void {
    const msg: ServerSignalingMessage = {
      v: 1,
      type: 'roster',
      epoch: group.epoch,
      revision: group.revision,
      peers: getRosterV1(group)
    }
    const data = Buffer.from(JSON.stringify(msg), 'utf-8')
    for (const [peerId, member] of group.members.entries()) {
      if (peerId !== exceptPeerId && member.ws.readyState === WebSocket.OPEN) {
        if (member.ws.bufferedAmount < 1048576) {
          member.ws.send(data)
        } else {
          member.ws.close(1008, 'Backlog exceeded')
        }
      }
    }
  }

  function sendToWs(ws: WebSocket, msg: ServerSignalingMessageV2 | ServerSignalingMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount < 1048576) {
        ws.send(Buffer.from(JSON.stringify(msg), 'utf-8'))
      } else {
        ws.close(1008, 'Backlog exceeded')
      }
    }
  }

  function removeSocketFromAllGroups(session: SocketSession): void {
    if (!session.peerId) return
    const peerId = session.peerId

    if (activeSocketsByPeerId.get(peerId) === session.ws) {
      activeSocketsByPeerId.delete(peerId)
    }

    for (const groupId of session.joinedGroupIds) {
      const group = groupMap.get(groupId)
      if (group) {
        const member = group.members.get(peerId)
        if (member && member.ws === session.ws) {
          group.members.delete(peerId)
          group.revision++
          broadcastGroupRosterV2(group)
        }
      }
    }
    session.joinedGroupIds.clear()

    if (session.v1RoomId) {
      const group = groupMap.get(session.v1RoomId)
      if (group) {
        const member = group.members.get(peerId)
        if (member && member.ws === session.ws) {
          group.members.delete(peerId)
          group.revision++
          broadcastGroupRosterV1(group)
        }
      }
      session.v1RoomId = null
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

    // Never accept tokens in URL queries
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

    // Verify token matches at least one configured group token using timingSafeEqual
    let isAuthorized = false
    for (const validBuffer of validTokenBuffers) {
      if (
        providedBuffer.length === validBuffer.length &&
        timingSafeEqual(providedBuffer, validBuffer)
      ) {
        isAuthorized = true
        break
      }
    }

    if (!isAuthorized) {
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

    const session: SocketSession = {
      peerId: null,
      sessionId: null,
      displayName: '',
      ws,
      lastPong: Date.now(),
      tokens: 40,
      lastTokenUpdate: Date.now(),
      joinedGroupIds: new Set(),
      v1RoomId: null
    }

    // Initial message deadline: 5 seconds
    const joinTimer = setTimeout(() => {
      if (!session.peerId) {
        ws.close(1008, 'Join timeout')
      }
    }, 5000)

    function checkRateLimit(): boolean {
      const now = Date.now()
      const elapsed = (now - session.lastTokenUpdate) / 1000
      session.lastTokenUpdate = now
      session.tokens = Math.min(40, session.tokens + elapsed * 20)
      if (session.tokens < 1) {
        return false
      }
      session.tokens -= 1
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

      // Check for V2 message format
      if (isClientSignalingMessageV2(parsed)) {
        handleClientMessageV2(session, parsed)
        return
      }

      // Temporary V1 message support for existing engine during Phase 2
      if (isClientSignalingMessage(parsed)) {
        handleClientMessageV1(session, parsed)
        return
      }

      ws.close(1008, 'Invalid message format')
    })

    function handleClientMessageV2(sess: SocketSession, msg: ClientSignalingMessageV2): void {
      if (!sess.peerId) {
        if (msg.type !== 'register') {
          ws.close(1008, 'Must register first')
          return
        }

        const nameCheck = validateDisplayName(msg.displayName)
        if (!nameCheck.valid) {
          ws.close(1008, 'Invalid display name')
          return
        }

        if (activeSocketsByPeerId.has(msg.peerId)) {
          sendToWs(ws, {
            v: 2,
            type: 'error',
            code: 'DUPLICATE_PEER_ID',
            message: 'Peer ID is already active on this endpoint'
          })
          ws.close(1008, 'Duplicate peer ID')
          return
        }

        clearTimeout(joinTimer)
        const sessionId = randomUUID()
        sess.peerId = msg.peerId
        sess.sessionId = sessionId
        sess.displayName = nameCheck.value

        activeSocketsByPeerId.set(msg.peerId, ws)

        const welcome: ServerSignalingMessageV2 = {
          v: 2,
          type: 'welcome',
          sessionId,
          iceConfig: generateIceConfig(sessionId)
        }
        sendToWs(ws, welcome)
        return
      }

      // Registered V2 session
      const peerId = sess.peerId
      const sessionId = sess.sessionId!

      switch (msg.type) {
        case 'join-group': {
          const group = groupMap.get(msg.groupId)
          if (!group) {
            sendToWs(ws, {
              v: 2,
              type: 'error',
              groupId: msg.groupId,
              code: 'NOT_FOUND',
              message: 'Group not found'
            })
            return
          }

          const providedTokenBuffer = Buffer.from(msg.token, 'utf-8')
          if (
            providedTokenBuffer.length !== group.tokenBuffer.length ||
            !timingSafeEqual(providedTokenBuffer, group.tokenBuffer)
          ) {
            sendToWs(ws, {
              v: 2,
              type: 'error',
              groupId: msg.groupId,
              code: 'AUTH_FAILED',
              message: 'Invalid group token'
            })
            return
          }

          if (sess.joinedGroupIds.size >= 32) {
            sendToWs(ws, {
              v: 2,
              type: 'error',
              groupId: msg.groupId,
              code: 'LIMIT_EXCEEDED',
              message: 'Maximum 32 group memberships per connection'
            })
            return
          }

          // Idempotent duplicate join
          const existing = group.members.get(peerId)
          if (existing && existing.ws === ws) {
            sendToWs(ws, {
              v: 2,
              type: 'group-joined',
              groupId: group.groupId,
              membershipId: existing.membershipId,
              epoch: group.epoch,
              revision: group.revision,
              peers: getRosterV2(group)
            })
            return
          }

          if (group.members.size >= 16) {
            sendToWs(ws, {
              v: 2,
              type: 'error',
              groupId: msg.groupId,
              code: 'GROUP_FULL',
              message: 'Group capacity reached (16 peers max)'
            })
            return
          }

          const membershipId = randomUUID()
          const joinOrder = group.nextJoinOrder++
          const member: GroupMember = {
            membershipId,
            peerId,
            sessionId,
            joinOrder,
            displayName: sess.displayName,
            supernodeEligible: Boolean(msg.supernodeEligible),
            ws
          }

          group.members.set(peerId, member)
          sess.joinedGroupIds.add(msg.groupId)
          group.revision++

          sendToWs(ws, {
            v: 2,
            type: 'group-joined',
            groupId: group.groupId,
            membershipId,
            epoch: group.epoch,
            revision: group.revision,
            peers: getRosterV2(group)
          })

          broadcastGroupRosterV2(group, peerId)
          return
        }

        case 'leave-group': {
          const group = groupMap.get(msg.groupId)
          if (group && sess.joinedGroupIds.has(msg.groupId)) {
            sess.joinedGroupIds.delete(msg.groupId)
            const m = group.members.get(peerId)
            if (m && m.ws === ws) {
              group.members.delete(peerId)
              sendToWs(ws, {
                v: 2,
                type: 'group-left',
                groupId: msg.groupId
              })
              group.revision++
              broadcastGroupRosterV2(group)
            }
          }
          return
        }

        case 'eligibility': {
          const group = groupMap.get(msg.groupId)
          if (group && sess.joinedGroupIds.has(msg.groupId)) {
            const member = group.members.get(peerId)
            if (member && member.supernodeEligible !== msg.supernodeEligible) {
              member.supernodeEligible = msg.supernodeEligible
              group.revision++
              broadcastGroupRosterV2(group)
            }
          }
          return
        }

        case 'profile': {
          const nameCheck = validateDisplayName(msg.displayName)
          if (!nameCheck.valid) return
          sess.displayName = nameCheck.value

          for (const groupId of sess.joinedGroupIds) {
            const group = groupMap.get(groupId)
            if (group) {
              const member = group.members.get(peerId)
              if (member) {
                member.displayName = nameCheck.value
                group.revision++
                broadcastGroupRosterV2(group)
              }
            }
          }
          return
        }

        case 'ice-config': {
          sendToWs(ws, {
            v: 2,
            type: 'ice-config',
            iceConfig: generateIceConfig(sessionId)
          })
          return
        }

        case 'signal': {
          const group = groupMap.get(msg.groupId)
          if (!group || !sess.joinedGroupIds.has(msg.groupId)) return

          const targetMember = group.members.get(msg.targetPeerId)
          if (targetMember && targetMember.sessionId === msg.targetSessionId) {
            sendToWs(targetMember.ws, {
              v: 2,
              type: 'signal',
              groupId: msg.groupId,
              fromPeerId: peerId,
              fromSessionId: sessionId,
              connectionId: msg.connectionId,
              kind: msg.kind,
              payload: msg.payload
            })
          }
          return
        }
      }
    }

    function handleClientMessageV1(sess: SocketSession, msg: ClientSignalingMessage): void {
      if (!sess.peerId) {
        if (msg.type !== 'join') {
          ws.close(1008, 'Must join first')
          return
        }

        const group = groupMap.get(msg.roomId)
        if (!group) {
          sendToWs(ws, {
            v: 1,
            type: 'error',
            code: 'ROOM_MISMATCH',
            message: 'Room ID mismatch'
          } as ServerSignalingMessage)
          ws.close(1008, 'Room mismatch')
          return
        }

        if (activeSocketsByPeerId.has(msg.peerId)) {
          sendToWs(ws, {
            v: 1,
            type: 'error',
            code: 'DUPLICATE_PEER_ID',
            message: 'Peer ID is already active in room'
          } as ServerSignalingMessage)
          ws.close(1008, 'Duplicate peer ID')
          return
        }

        if (group.members.size >= 16) {
          sendToWs(ws, {
            v: 1,
            type: 'error',
            code: 'ROOM_FULL',
            message: 'Room capacity reached (16 peers max)'
          } as ServerSignalingMessage)
          ws.close(1008, 'Room full')
          return
        }

        const nameCheck = validateDisplayName(msg.displayName)
        if (!nameCheck.valid) {
          ws.close(1008, 'Invalid display name')
          return
        }

        clearTimeout(joinTimer)
        const sessionId = randomUUID()
        sess.peerId = msg.peerId
        sess.sessionId = sessionId
        sess.displayName = nameCheck.value
        sess.v1RoomId = group.groupId

        activeSocketsByPeerId.set(msg.peerId, ws)

        const member: GroupMember = {
          membershipId: randomUUID(),
          peerId: msg.peerId,
          sessionId,
          joinOrder: group.nextJoinOrder++,
          displayName: nameCheck.value,
          supernodeEligible: Boolean(msg.supernodeEligible),
          ws
        }
        group.members.set(msg.peerId, member)

        group.revision++
        sendToWs(ws, {
          v: 1,
          type: 'welcome',
          sessionId,
          epoch: group.epoch,
          iceConfig: generateIceConfig(sessionId)
        } as ServerSignalingMessage)

        broadcastGroupRosterV1(group)
        return
      }

      // Already joined v1 session
      const group = groupMap.get(sess.v1RoomId || '')
      if (!group) return
      const peerId = sess.peerId
      const member = group.members.get(peerId)
      if (!member) return

      switch (msg.type) {
        case 'eligibility': {
          if (member.supernodeEligible !== msg.supernodeEligible) {
            member.supernodeEligible = msg.supernodeEligible
            group.revision++
            broadcastGroupRosterV1(group)
          }
          break
        }
        case 'leave': {
          group.members.delete(peerId)
          group.revision++
          broadcastGroupRosterV1(group)
          ws.close(1000, 'Normal leave')
          break
        }
        case 'ice-config': {
          sendToWs(ws, {
            v: 1,
            type: 'ice-config',
            iceConfig: generateIceConfig(sess.sessionId!)
          } as ServerSignalingMessage)
          break
        }
        case 'signal': {
          const target = group.members.get(msg.targetPeerId)
          if (target && target.sessionId === msg.targetSessionId) {
            sendToWs(target.ws, {
              v: 1,
              type: 'signal',
              fromPeerId: peerId,
              fromSessionId: sess.sessionId!,
              connectionId: msg.connectionId,
              kind: msg.kind,
              payload: msg.payload
            } as ServerSignalingMessage)
          }
          break
        }
      }
    }

    ws.on('pong', () => {
      session.lastPong = Date.now()
    })

    ws.on('close', () => {
      clearTimeout(joinTimer)
      sockets.delete(ws)
      removeSocketFromAllGroups(session)
    })

    ws.on('error', () => {
      clearTimeout(joinTimer)
      sockets.delete(ws)
      removeSocketFromAllGroups(session)
    })
  })

  // Heartbeat & roster freshness timer: run every 2s
  const heartbeatTimer = setInterval(() => {
    if (isClosing) return
    const now = Date.now()
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping()
      }
    }

    for (const group of groupMap.values()) {
      let expiredCount = 0
      for (const [peerId, member] of group.members.entries()) {
        const socketSession = activeSocketsByPeerId.get(peerId)
        if (member.ws.readyState !== WebSocket.OPEN) {
          group.members.delete(peerId)
          expiredCount++
        }
      }
      if (expiredCount > 0) {
        group.revision++
        broadcastGroupRosterV2(group)
        broadcastGroupRosterV1(group)
      }
    }
  }, 2000)

  const { promise: listenPromise, resolve: resolveListen, reject: rejectListen } = Promise.withResolvers<void>()

  httpServer.listen(options.port, options.host, () => {
    resolveListen()
  })
  httpServer.on('error', (err) => {
    rejectListen(err)
  })

  await listenPromise

  const addr = httpServer.address()
  const actualPort = typeof addr === 'object' && addr ? addr.port : options.port
  const actualHost = typeof addr === 'object' && addr ? addr.address : options.host

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
      for (const group of groupMap.values()) {
        group.members.clear()
      }
      activeSocketsByPeerId.clear()

      const { promise: wssPromise, resolve: resolveWss } = Promise.withResolvers<void>()
      wss.close(() => {
        resolveWss()
      })
      await wssPromise

      const { promise: httpPromise, resolve: resolveHttp } = Promise.withResolvers<void>()
      if (typeof httpServer.closeAllConnections === 'function') {
        httpServer.closeAllConnections()
      }
      httpServer.close(() => {
        resolveHttp()
      })
      await httpPromise
    }
  }
}
