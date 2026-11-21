import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual, randomUUID, createHmac, randomBytes } from 'node:crypto'
import type { Socket } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import {
  MAX_SIGNALING_MESSAGE_SIZE,
  isClientSignalingMessageV2,
  type ClientSignalingMessageV2,
  type ServerSignalingMessageV2,
  type SignalingIceConfig,
  type SignalingRosterPeerV2
} from '../../src/shared/p2p-wire.ts'
import {
  validateDisplayName,
  validateGroupId,
  validateInviteCode
} from '../../src/shared/p2p.ts'

export interface SignalingGroupConfig {
  groupId: string
  token: string
  name?: string
  ownerPeerId?: string | null
  ownerSecret?: string | null
}

export interface SignalingOptions {
  host: string
  port: number
  groups?: SignalingGroupConfig[]
  emptyGroupTtlMs?: number
  pongTimeoutMs?: number
  duplicateProbeTimeoutMs?: number
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

const upgradeGroupIdMap = new WeakMap<WebSocket, string>()
const socketSessions = new WeakMap<WebSocket, SocketSession>()

interface SocketSession {
  peerId: string | null
  sessionId: string | null
  displayName: string
  ws: WebSocket
  lastPong: number
  lastAppActivity: number
  supportsAppHeartbeat: boolean
  pendingAppProbes: Map<string, () => void>
  tokens: number
  lastTokenUpdate: number
  joinedGroupIds: Set<string>
  upgradeGroupId: string
  isRegistering?: boolean
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
  ownerPeerId: string | null
  ownerSecretBuffer: Buffer | null
  isDynamic: boolean
  emptySince: number | null
  epoch: string
  revision: number
  nextJoinOrder: number
  members: Map<string, GroupMember> // peerId -> GroupMember
}

function safeTimingEqual(a: Buffer, b: Buffer): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
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
      const tokenCheck = validateInviteCode(g.token)
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
      groupDefinitions.push({
        groupId: groupCheck.value,
        token: tokenCheck.value,
        name: g.name,
        ownerPeerId: g.ownerPeerId ?? null,
        ownerSecret: g.ownerSecret ?? null
      })
    }
  }

  // Group runtime map
  const groupMap = new Map<string, GroupRuntimeState>()
  const DEFAULT_EMPTY_GROUP_TTL_MS = 5 * 60 * 1000
  const emptyGroupTtlMs =
    options.emptyGroupTtlMs !== undefined && Number.isFinite(options.emptyGroupTtlMs)
      ? Math.max(0, Math.floor(options.emptyGroupTtlMs))
      : DEFAULT_EMPTY_GROUP_TTL_MS
  const DEFAULT_PONG_TIMEOUT_MS = 6000
  const pongTimeoutMs =
    options.pongTimeoutMs !== undefined && Number.isFinite(options.pongTimeoutMs)
      ? Math.max(50, Math.floor(options.pongTimeoutMs))
      : DEFAULT_PONG_TIMEOUT_MS
  const DEFAULT_DUPLICATE_PROBE_TIMEOUT_MS = 1000
  const duplicateProbeTimeoutMs =
    options.duplicateProbeTimeoutMs !== undefined && Number.isFinite(options.duplicateProbeTimeoutMs)
      ? Math.max(50, Math.floor(options.duplicateProbeTimeoutMs))
      : DEFAULT_DUPLICATE_PROBE_TIMEOUT_MS

  for (const g of groupDefinitions) {
    const tokenBuffer = Buffer.from(g.token, 'utf-8')
    const ownerSecretBuffer = g.ownerSecret ? Buffer.from(g.ownerSecret, 'utf-8') : null
    groupMap.set(g.groupId, {
      groupId: g.groupId,
      token: g.token,
      tokenBuffer,
      ownerPeerId: g.ownerPeerId ?? null,
      ownerSecretBuffer,
      isDynamic: false,
      emptySince: null,
      epoch: randomUUID(),
      revision: 1,
      nextJoinOrder: 1,
      members: new Map()
    })
  }

  function updateGroupEmptyState(group: GroupRuntimeState): void {
    if (!group.isDynamic) return
    if (group.members.size === 0) {
      if (group.emptySince === null) {
        group.emptySince = Date.now()
      }
    } else {
      group.emptySince = null
    }
  }

  function sweepEmptyDynamicGroups(): void {
    const now = Date.now()
    for (const [groupId, group] of groupMap.entries()) {
      if (
        group.isDynamic &&
        group.members.size === 0 &&
        group.emptySince !== null &&
        now - group.emptySince >= emptyGroupTtlMs
      ) {
        groupMap.delete(groupId)
      }
    }
  }

  // Active sockets and registration map
  const activeSocketsByPeerId = new Map<string, WebSocket>() // peerId -> WebSocket
  const sockets = new Set<WebSocket>()
  let isClosing = false

  function generateUniqueInviteCode(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = randomBytes(16).toString('base64url') // 22 chars
      let exists = false
      for (const g of groupMap.values()) {
        if (g.token === code) {
          exists = true
          break
        }
      }
      if (!exists) return code
    }
    throw new Error('Failed to generate unique invite code')
  }

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
          {
            urls: `turn:${options.turnHost}:3478?transport=udp`,
            username,
            credential
          },
          {
            urls: `turn:${options.turnHost}:3478?transport=tcp`,
            username,
            credential
          }
        ]
      }
    }

    if (options.turnUrl && options.turnUsername && options.turnCredential) {
      const servers = []
      if (options.stunUrl) {
        servers.push({ urls: options.stunUrl })
      }
      servers.push({
        urls: options.turnUrl,
        username: options.turnUsername,
        credential: options.turnCredential
      })
      return {
        expiresAt: Date.now() + 3600000,
        servers
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

  function broadcastGroupRosterV2(group: GroupRuntimeState, exceptPeerId?: string): void {
    const msg: ServerSignalingMessageV2 = {
      v: 2,
      type: 'roster',
      groupId: group.groupId,
      epoch: group.epoch,
      revision: group.revision,
      peers: getRosterV2(group),
      ownerPeerId: group.ownerPeerId
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

  function sendToWs(ws: WebSocket, msg: ServerSignalingMessageV2): void {
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
          updateGroupEmptyState(group)
          group.revision++
          broadcastGroupRosterV2(group)
        }
      }
    }
    session.joinedGroupIds.clear()
  }

  function evictDeadSocket(targetWs: WebSocket, expectedPeerId?: string): void {
    sockets.delete(targetWs)
    const targetSess = socketSessions.get(targetWs)
    if (targetSess) {
      removeSocketFromAllGroups(targetSess)
    } else if (expectedPeerId && activeSocketsByPeerId.get(expectedPeerId) === targetWs) {
      activeSocketsByPeerId.delete(expectedPeerId)
    }
    try {
      targetWs.terminate()
    } catch {
      // ignore
    }
  }

  function probeSocketAlive(targetWs: WebSocket, timeoutMs: number): Promise<boolean> {
    if (targetWs.readyState !== WebSocket.OPEN) {
      return Promise.resolve(false)
    }
    const targetSess = socketSessions.get(targetWs)
    if (targetSess?.supportsAppHeartbeat) {
      // End-to-end JSON ping/pong probe: reverse proxies (Render/Cloudflare/Nginx)
      // can answer WebSocket-level control pings locally, but cannot forge an app pong.
      const probeId = randomUUID()
      return new Promise((resolve) => {
        let settled = false
        const finish = (alive: boolean) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          targetSess.pendingAppProbes.delete(probeId)
          targetWs.off('close', onDead)
          targetWs.off('error', onDead)
          resolve(alive)
        }
        const onDead = () => finish(false)
        const timer = setTimeout(() => finish(false), timeoutMs)
        targetSess.pendingAppProbes.set(probeId, () => finish(true))
        targetWs.on('close', onDead)
        targetWs.on('error', onDead)
        try {
          sendToWs(targetWs, { v: 2, type: 'ping', id: probeId })
        } catch {
          finish(false)
        }
      })
    }

    return new Promise((resolve) => {
      let settled = false
      const finish = (alive: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        targetWs.off('pong', onPong)
        targetWs.off('close', onDead)
        targetWs.off('error', onDead)
        resolve(alive)
      }
      const onPong = () => finish(true)
      const onDead = () => finish(false)
      const timer = setTimeout(() => finish(false), timeoutMs)
      targetWs.on('pong', onPong)
      targetWs.on('close', onDead)
      targetWs.on('error', onDead)
      try {
        targetWs.ping()
      } catch {
        finish(false)
      }
    })
  }

  function sweepStaleSockets(): void {
    const now = Date.now()
    for (const ws of Array.from(sockets)) {
      const sess = socketSessions.get(ws)
      if (ws.readyState === WebSocket.OPEN) {
        if (sess) {
          const lastAlive = sess.supportsAppHeartbeat ? sess.lastAppActivity : sess.lastPong
          if (now - lastAlive > pongTimeoutMs) {
            evictDeadSocket(ws, sess.peerId || undefined)
            continue
          }
          if (sess.supportsAppHeartbeat) {
            sendToWs(ws, { v: 2, type: 'ping' })
          }
        }
        try {
          ws.ping()
        } catch {
          evictDeadSocket(ws, sess?.peerId || undefined)
        }
      } else if (ws.readyState !== WebSocket.CONNECTING) {
        evictDeadSocket(ws, sess?.peerId || undefined)
      }
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

    let matchedGroupId: string | null = null
    if (providedToken === 'create-group') {
      matchedGroupId = '__multiplex__'
    } else {
      const codeCheck = validateInviteCode(providedToken)
      if (!codeCheck.valid) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }

      for (const group of groupMap.values()) {
        if (
          safeTimingEqual(providedBuffer, group.tokenBuffer) ||
          (group.ownerSecretBuffer && safeTimingEqual(providedBuffer, group.ownerSecretBuffer))
        ) {
          matchedGroupId = group.groupId
          break
        }
      }

      if (!matchedGroupId) {
        // Valid invite code format: allow upgrade as multiplexed connection so peers
        // can join newly created or dynamically re-seeded groups
        matchedGroupId = '__multiplex__'
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      upgradeGroupIdMap.set(ws, matchedGroupId!)
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws: WebSocket) => {
    const upgradeGroupId = upgradeGroupIdMap.get(ws)
    if (!upgradeGroupId) {
      ws.close(1008, 'Missing upgrade group identity')
      return
    }
    upgradeGroupIdMap.delete(ws)

    sockets.add(ws)

    const nowInit = Date.now()
    const session: SocketSession = {
      peerId: null,
      sessionId: null,
      displayName: '',
      ws,
      lastPong: nowInit,
      lastAppActivity: nowInit,
      supportsAppHeartbeat: false,
      pendingAppProbes: new Map(),
      tokens: 40,
      lastTokenUpdate: nowInit,
      joinedGroupIds: new Set(),
      upgradeGroupId
    }
    socketSessions.set(ws, session)

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

      if (isClientSignalingMessageV2(parsed)) {
        const nowMsg = Date.now()
        session.lastPong = nowMsg
        session.lastAppActivity = nowMsg
        handleClientMessageV2(session, parsed)
        return
      }

      ws.close(1008, 'Invalid message format')
    })

    function handleClientMessageV2(sess: SocketSession, msg: ClientSignalingMessageV2): void {
      if (!sess.peerId) {
        if (sess.isRegistering) {
          return
        }
        if (msg.type !== 'register') {
          ws.close(1008, 'Must register first')
          return
        }

        const nameCheck = validateDisplayName(msg.displayName)
        if (!nameCheck.valid) {
          ws.close(1008, 'Invalid display name')
          return
        }

        const completeRegistration = (regPeerId: string, displayName: string): void => {
          clearTimeout(joinTimer)
          const sessionId = randomUUID()
          sess.peerId = regPeerId
          sess.sessionId = sessionId
          sess.displayName = displayName

          activeSocketsByPeerId.set(regPeerId, ws)

          const welcome: ServerSignalingMessageV2 = {
            v: 2,
            type: 'welcome',
            sessionId,
            iceConfig: generateIceConfig(sessionId)
          }
          sendToWs(ws, welcome)
        }

        const existingWs = activeSocketsByPeerId.get(msg.peerId)
        if (existingWs) {
          const existingSess = socketSessions.get(existingWs)
          const existingLastAlive = existingSess
            ? (existingSess.supportsAppHeartbeat ? existingSess.lastAppActivity : existingSess.lastPong)
            : 0
          const isAlreadyStale =
            existingWs.readyState !== WebSocket.OPEN ||
            !existingSess ||
            Date.now() - existingLastAlive > pongTimeoutMs

          if (isAlreadyStale) {
            evictDeadSocket(existingWs, msg.peerId)
            completeRegistration(msg.peerId, nameCheck.value)
            return
          }

          // Probe existing socket with a live WebSocket ping to distinguish a genuine active
          // duplicate session from a half-open zombie socket left behind by a network switch.
          sess.isRegistering = true
          void probeSocketAlive(existingWs, duplicateProbeTimeoutMs).then((alive) => {
            sess.isRegistering = false
            if (isClosing || ws.readyState !== WebSocket.OPEN) {
              return
            }
            if (alive) {
              sendToWs(ws, {
                v: 2,
                type: 'error',
                code: 'DUPLICATE_PEER_ID',
                message: 'Peer ID is already active on this endpoint'
              })
              ws.close(1008, 'Duplicate peer ID')
              return
            }

            const currentActive = activeSocketsByPeerId.get(msg.peerId)
            if (currentActive === existingWs) {
              evictDeadSocket(existingWs, msg.peerId)
            } else if (currentActive && currentActive !== ws) {
              sendToWs(ws, {
                v: 2,
                type: 'error',
                code: 'DUPLICATE_PEER_ID',
                message: 'Peer ID is already active on this endpoint'
              })
              ws.close(1008, 'Duplicate peer ID')
              return
            }

            completeRegistration(msg.peerId, nameCheck.value)
          })
          return
        }

        completeRegistration(msg.peerId, nameCheck.value)
        return
      }

      // Registered V2 session
      const peerId = sess.peerId
      const sessionId = sess.sessionId!

      switch (msg.type) {
        case 'create-group': {
          const groupCheck = validateGroupId(msg.groupId)
          if (!groupCheck.valid) {
            sendToWs(ws, {
              v: 2,
              type: 'error',
              groupId: msg.groupId,
              code: 'INVALID_INPUT',
              message: groupCheck.error
            })
            return
          }
          const secretCheck = validateInviteCode(msg.ownerSecret)
          if (!secretCheck.valid) {
            sendToWs(ws, {
              v: 2,
              type: 'error',
              groupId: msg.groupId,
              code: 'INVALID_INPUT',
              message: 'Invalid ownerSecret'
            })
            return
          }

          sweepEmptyDynamicGroups()

          if (groupMap.has(msg.groupId)) {
            sendToWs(ws, {
              v: 2,
              type: 'error',
              groupId: msg.groupId,
              code: 'GROUP_EXISTS',
              message: 'Group ID already exists'
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

          const inviteCode = generateUniqueInviteCode()
          const tokenBuffer = Buffer.from(inviteCode, 'utf-8')
          const ownerSecretBuffer = Buffer.from(msg.ownerSecret, 'utf-8')

          const newGroup: GroupRuntimeState = {
            groupId: msg.groupId,
            token: inviteCode,
            tokenBuffer,
            ownerPeerId: peerId,
            ownerSecretBuffer,
            isDynamic: true,
            emptySince: null,
            epoch: randomUUID(),
            revision: 1,
            nextJoinOrder: 1,
            members: new Map()
          }
          groupMap.set(msg.groupId, newGroup)

          const membershipId = randomUUID()
          const joinOrder = newGroup.nextJoinOrder++
          const member: GroupMember = {
            membershipId,
            peerId,
            sessionId,
            joinOrder,
            displayName: sess.displayName,
            supernodeEligible: Boolean(msg.supernodeEligible),
            ws
          }
          newGroup.members.set(peerId, member)
          sess.joinedGroupIds.add(msg.groupId)
          newGroup.revision++

          sendToWs(ws, {
            v: 2,
            type: 'group-joined',
            groupId: newGroup.groupId,
            membershipId,
            epoch: newGroup.epoch,
            revision: newGroup.revision,
            peers: getRosterV2(newGroup),
            ownerPeerId: peerId,
            inviteCode
          })
          return
        }

        case 'join-group': {
          sweepEmptyDynamicGroups()
          let group: GroupRuntimeState | undefined
          const providedTokenBuffer = Buffer.from(msg.token, 'utf-8')

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

          if (msg.groupId && msg.groupId.length > 0) {
            group = groupMap.get(msg.groupId)
            if (!group) {
              // Check if owner is auto-reseeding the group across server restart
              if (
                msg.ownerSecret &&
                validateGroupId(msg.groupId).valid &&
                validateInviteCode(msg.token).valid &&
                validateInviteCode(msg.ownerSecret).valid
              ) {
                let tokenCollision = false
                for (const existingGroup of groupMap.values()) {
                  if (safeTimingEqual(providedTokenBuffer, existingGroup.tokenBuffer)) {
                    tokenCollision = true
                    break
                  }
                }
                if (!tokenCollision) {
                  group = {
                    groupId: msg.groupId,
                    token: msg.token,
                    tokenBuffer: Buffer.from(msg.token, 'utf-8'),
                    ownerPeerId: peerId,
                    ownerSecretBuffer: Buffer.from(msg.ownerSecret, 'utf-8'),
                    isDynamic: true,
                    emptySince: null,
                    epoch: randomUUID(),
                    revision: 1,
                    nextJoinOrder: 1,
                    members: new Map()
                  }
                  groupMap.set(msg.groupId, group)
                } else {
                  sendToWs(ws, {
                    v: 2,
                    type: 'error',
                    groupId: msg.groupId,
                    code: 'AUTH_FAILED',
                    message: 'Token already in use'
                  })
                  return
                }
              }

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
            }

            // Verify token match or owner secret match
            const tokenMatch = safeTimingEqual(providedTokenBuffer, group.tokenBuffer)
            const ownerMatch = Boolean(
              msg.ownerSecret &&
                group.ownerSecretBuffer &&
                safeTimingEqual(Buffer.from(msg.ownerSecret, 'utf-8'), group.ownerSecretBuffer)
            )

            if (!tokenMatch && !ownerMatch) {
              sendToWs(ws, {
                v: 2,
                type: 'error',
                groupId: msg.groupId,
                code: 'AUTH_FAILED',
                message: 'Invalid group token'
              })
              return
            }
          } else {
            // Code-only join: find group matching tokenBuffer
            for (const g of groupMap.values()) {
              if (safeTimingEqual(providedTokenBuffer, g.tokenBuffer)) {
                group = g
                break
              }
            }

            if (!group) {
              sendToWs(ws, {
                v: 2,
                type: 'error',
                code: 'AUTH_FAILED',
                message: 'Invalid invite code'
              })
              return
            }
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
              peers: getRosterV2(group),
              ownerPeerId: group.ownerPeerId,
              inviteCode: group.token
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

          // If owner joins with ownerSecret, update ownerPeerId once capacity verified
          if (
            msg.ownerSecret &&
            group.ownerSecretBuffer &&
            safeTimingEqual(Buffer.from(msg.ownerSecret, 'utf-8'), group.ownerSecretBuffer)
          ) {
            group.ownerPeerId = peerId
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
          updateGroupEmptyState(group)
          sess.joinedGroupIds.add(group.groupId)
          group.revision++

          sendToWs(ws, {
            v: 2,
            type: 'group-joined',
            groupId: group.groupId,
            membershipId,
            epoch: group.epoch,
            revision: group.revision,
            peers: getRosterV2(group),
            ownerPeerId: group.ownerPeerId,
            inviteCode: group.token
          })

          broadcastGroupRosterV2(group, peerId)
          return
        }

        case 'rotate-invite': {
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

          if (
            group.ownerPeerId !== peerId ||
            !group.ownerSecretBuffer ||
            !safeTimingEqual(Buffer.from(msg.ownerSecret, 'utf-8'), group.ownerSecretBuffer)
          ) {
            sendToWs(ws, {
              v: 2,
              type: 'error',
              groupId: msg.groupId,
              code: 'FORBIDDEN',
              message: 'Only the group owner can rotate the invite code'
            })
            return
          }

          const newCode = generateUniqueInviteCode()
          group.token = newCode
          group.tokenBuffer = Buffer.from(newCode, 'utf-8')

          const rotatedMsg: ServerSignalingMessageV2 = {
            v: 2,
            type: 'invite-rotated',
            groupId: group.groupId,
            inviteCode: newCode
          }
          const rotatedData = Buffer.from(JSON.stringify(rotatedMsg), 'utf-8')
          for (const m of group.members.values()) {
            if (m.ws.readyState === WebSocket.OPEN) {
              m.ws.send(rotatedData)
            }
          }
          return
        }

        case 'remove-member': {
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

          if (
            group.ownerPeerId !== peerId ||
            !group.ownerSecretBuffer ||
            !safeTimingEqual(Buffer.from(msg.ownerSecret, 'utf-8'), group.ownerSecretBuffer) ||
            msg.targetPeerId === peerId
          ) {
            sendToWs(ws, {
              v: 2,
              type: 'error',
              groupId: msg.groupId,
              code: 'FORBIDDEN',
              message: 'Not authorized to remove member'
            })
            return
          }

          const targetMember = group.members.get(msg.targetPeerId)
          if (targetMember) {
            group.members.delete(msg.targetPeerId)
            updateGroupEmptyState(group)
            const targetSession = socketSessions.get(targetMember.ws)
            if (targetSession) {
              targetSession.joinedGroupIds.delete(group.groupId)
            }
            sendToWs(targetMember.ws, {
              v: 2,
              type: 'group-kicked',
              groupId: group.groupId,
              reason: 'Removed by group owner'
            })
            group.revision++
            broadcastGroupRosterV2(group)
          }
          return
        }

        case 'delete-group': {
          sweepEmptyDynamicGroups()
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

          if (
            !group.isDynamic ||
            group.ownerPeerId !== peerId ||
            !group.ownerSecretBuffer ||
            !safeTimingEqual(Buffer.from(msg.ownerSecret, 'utf-8'), group.ownerSecretBuffer)
          ) {
            sendToWs(ws, {
              v: 2,
              type: 'error',
              groupId: msg.groupId,
              code: 'FORBIDDEN',
              message: 'Not authorized to delete group'
            })
            return
          }

          groupMap.delete(group.groupId)

          for (const [memberPeerId, member] of group.members.entries()) {
            const memberSession = socketSessions.get(member.ws)
            if (memberSession) {
              memberSession.joinedGroupIds.delete(group.groupId)
            }
            if (memberPeerId !== peerId) {
              sendToWs(member.ws, {
                v: 2,
                type: 'group-kicked',
                groupId: group.groupId,
                reason: 'Group deleted by owner'
              })
            }
          }
          sess.joinedGroupIds.delete(group.groupId)

          sendToWs(ws, {
            v: 2,
            type: 'group-deleted',
            groupId: group.groupId
          })
          return
        }

        case 'leave-group': {
          const group = groupMap.get(msg.groupId)
          if (group && sess.joinedGroupIds.has(msg.groupId)) {
            sess.joinedGroupIds.delete(msg.groupId)
            const m = group.members.get(peerId)
            if (m && m.ws === ws) {
              group.members.delete(peerId)
              updateGroupEmptyState(group)
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

        case 'ping': {
          sess.supportsAppHeartbeat = true
          sendToWs(ws, {
            v: 2,
            type: 'pong',
            ...(msg.id !== undefined ? { id: msg.id } : {})
          })
          return
        }

        case 'pong': {
          sess.supportsAppHeartbeat = true
          if (msg.id) {
            const cb = sess.pendingAppProbes.get(msg.id)
            if (cb) {
              sess.pendingAppProbes.delete(msg.id)
              cb()
            }
          }
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
    sweepStaleSockets()

    for (const group of groupMap.values()) {
      let expiredCount = 0
      for (const [peerId, member] of group.members.entries()) {
        if (member.ws.readyState !== WebSocket.OPEN) {
          group.members.delete(peerId)
          expiredCount++
        }
      }
      if (expiredCount > 0) {
        updateGroupEmptyState(group)
        group.revision++
        broadcastGroupRosterV2(group)
      } else if (group.members.size > 0) {
        broadcastGroupRosterV2(group)
      }
    }

    sweepEmptyDynamicGroups()
  }, 2000)
  heartbeatTimer.unref()

  let gcSweepTimer: NodeJS.Timeout | null = null
  if (emptyGroupTtlMs < 2000) {
    gcSweepTimer = setInterval(() => {
      if (!isClosing) {
        sweepEmptyDynamicGroups()
      }
    }, Math.max(25, Math.floor(emptyGroupTtlMs / 2)))
    gcSweepTimer.unref()
  }

  let pongSweepTimer: NodeJS.Timeout | null = null
  if (pongTimeoutMs < 2000) {
    pongSweepTimer = setInterval(() => {
      if (!isClosing) {
        sweepStaleSockets()
      }
    }, Math.max(25, Math.floor(pongTimeoutMs / 2)))
    pongSweepTimer.unref()
  }

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
      if (gcSweepTimer) {
        clearInterval(gcSweepTimer)
      }
      if (pongSweepTimer) {
        clearInterval(pongSweepTimer)
      }

      for (const ws of sockets) {
        try {
          ws.terminate()
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
