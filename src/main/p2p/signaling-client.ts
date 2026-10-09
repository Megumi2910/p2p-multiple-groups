import WebSocket from 'ws'
import {
  isServerSignalingMessageV2,
  type ServerSignalingMessageV2,
  type ClientSignalingMessageV2,
  type SignalingIceConfig,
  type SignalingRosterPeerV2,
  type GroupJoinedMessage
} from '../../shared/p2p-wire.ts'

export interface SignalingClientCallbacks {
  onGroupJoined?: (msg: GroupJoinedMessage) => void
  onRoster?: (groupId: string, epoch: string, revision: number, peers: SignalingRosterPeerV2[]) => void
  onGroupLeft?: (groupId: string) => void
  onSignal?: (msg: Extract<ServerSignalingMessageV2, { type: 'signal' }>) => void
  onError?: (groupId: string | undefined, code: string, message: string) => void
  onStatusChange?: (
    status: 'disconnected' | 'connecting' | 'connected' | 'recovering' | 'error',
    message: string | null
  ) => void
  onIceConfig?: (iceConfig: SignalingIceConfig) => void
}

export interface SignalingClientOptions {
  signalingUrl: string
  peerId: string
  displayName: string
  callbacks: SignalingClientCallbacks
}

interface DesiredGroup {
  groupId: string
  token: string
  supernodeEligible: boolean
  status: 'joining' | 'joined' | 'auth_failed' | 'error'
  lastMembershipId: string | null
  lastRoster: SignalingRosterPeerV2[]
  lastEpoch: string | null
  lastRevision: number
  lastError?: string | null
}

interface PendingJoin {
  groupId: string
  resolve: (msg: GroupJoinedMessage) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

interface PendingLeave {
  groupId: string
  resolve: () => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export class SignalingClient {
  private readonly signalingUrl: string
  private readonly peerId: string
  private displayName: string
  private readonly callbacks: SignalingClientCallbacks

  private isDisposed = false
  private currentSocket: WebSocket | null = null
  private socketGeneration = 0
  private currentSessionId: string | null = null
  private isRegistered = false

  // Pacing token bucket: max 30 tokens, 18 tokens per second
  private clientTokens = 30
  private lastTokenUpdate = Date.now()
  private readonly outboundQueue: string[] = []
  private drainTimer: NodeJS.Timeout | null = null

  // Reconnection backoff
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  private triedUpgradeTokens = new Set<string>()

  // Group memberships
  private readonly desiredGroups = new Map<string, DesiredGroup>()
  private readonly pendingJoins = new Map<string, PendingJoin>()
  private readonly pendingLeaves = new Map<string, PendingLeave>()

  constructor(options: SignalingClientOptions) {
    this.signalingUrl = options.signalingUrl
    this.peerId = options.peerId
    this.displayName = options.displayName
    this.callbacks = options.callbacks
  }

  getSessionId(): string | null {
    return this.currentSessionId
  }

  setDisplayName(name: string): void {
    if (this.displayName === name) return
    this.displayName = name
    if (this.isConnectedAndRegistered()) {
      this.enqueue({
        v: 2,
        type: 'profile',
        displayName: name
      })
    }
  }

  setEligibility(groupId: string, eligible: boolean): void {
    const group = this.desiredGroups.get(groupId)
    if (!group) return
    group.supernodeEligible = eligible
    if (this.isConnectedAndRegistered() && group.status === 'joined') {
      this.enqueue({
        v: 2,
        type: 'eligibility',
        groupId,
        supernodeEligible: eligible
      })
    }
  }

  sendSignal(msg: {
    groupId: string
    targetPeerId: string
    targetSessionId: string
    connectionId: string
    kind: 'request-offer' | 'offer' | 'answer' | 'candidate'
    payload: unknown
  }): void {
    if (!this.isConnectedAndRegistered()) return
    const group = this.desiredGroups.get(msg.groupId)
    if (!group || group.status !== 'joined') return

    this.enqueue({
      v: 2,
      type: 'signal',
      groupId: msg.groupId,
      targetPeerId: msg.targetPeerId,
      targetSessionId: msg.targetSessionId,
      connectionId: msg.connectionId,
      kind: msg.kind,
      payload: msg.payload
    })
  }

  requestIceConfig(): void {
    if (!this.isConnectedAndRegistered()) return
    this.enqueue({
      v: 2,
      type: 'ice-config'
    })
  }

  async joinGroup(groupId: string, token: string, eligible: boolean): Promise<GroupJoinedMessage> {
    if (this.isDisposed) {
      throw new Error('Signaling client is disposed')
    }

    let group = this.desiredGroups.get(groupId)
    if (group) {
      group.token = token
      group.supernodeEligible = eligible
      if (group.status === 'auth_failed') {
        group.status = 'joining'
        this.triedUpgradeTokens.delete(token)
      }
    } else {
      group = {
        groupId,
        token,
        supernodeEligible: eligible,
        status: 'joining',
        lastMembershipId: null,
        lastRoster: [],
        lastEpoch: null,
        lastRevision: 1
      }
      this.desiredGroups.set(groupId, group)
    }

    // Cancel any pending join for this group
    const existingPending = this.pendingJoins.get(groupId)
    if (existingPending) {
      clearTimeout(existingPending.timer)
      this.pendingJoins.delete(groupId)
      existingPending.reject(new Error('Superseded by new join request'))
    }

    const { promise, resolve, reject } = Promise.withResolvers<GroupJoinedMessage>()

    const timer = setTimeout(() => {
      this.pendingJoins.delete(groupId)
      reject(new Error(`Timeout (10s) waiting to join group "${groupId}"`))
    }, 10000)

    this.pendingJoins.set(groupId, {
      groupId,
      resolve,
      reject,
      timer
    })

    if (!this.currentSocket || this.currentSocket.readyState === WebSocket.CLOSED) {
      this.connect()
    } else if (this.isConnectedAndRegistered()) {
      this.enqueue({
        v: 2,
        type: 'join-group',
        groupId,
        token: group.token,
        supernodeEligible: group.supernodeEligible
      })
    }

    return promise
  }

  async leaveGroup(groupId: string): Promise<void> {
    if (this.isDisposed) return

    // Cancel pending join if any
    const pendingJoin = this.pendingJoins.get(groupId)
    if (pendingJoin) {
      clearTimeout(pendingJoin.timer)
      this.pendingJoins.delete(groupId)
      pendingJoin.reject(new Error('Cancelled: group was left'))
    }

    const group = this.desiredGroups.get(groupId)
    if (!group) return

    const wasJoined = group.status === 'joined'
    this.desiredGroups.delete(groupId)

    if (!this.isConnectedAndRegistered() || !wasJoined) {
      this.callbacks.onGroupLeft?.(groupId)
      return
    }

    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const timer = setTimeout(() => {
      this.pendingLeaves.delete(groupId)
      // Resolve safely on timeout
      this.callbacks.onGroupLeft?.(groupId)
      resolve()
    }, 10000)

    this.pendingLeaves.set(groupId, {
      groupId,
      resolve,
      reject,
      timer
    })

    this.enqueue({
      v: 2,
      type: 'leave-group',
      groupId
    })

    return promise
  }

  private isConnectedAndRegistered(): boolean {
    return Boolean(
      this.currentSocket &&
      this.currentSocket.readyState === WebSocket.OPEN &&
      this.isRegistered &&
      this.currentSessionId
    )
  }

  private selectUpgradeBearerToken(): { token: string; groupId: string } | null {
    for (const group of this.desiredGroups.values()) {
      if (group.status !== 'auth_failed') {
        return { token: group.token, groupId: group.groupId }
      }
    }
    return null
  }

  private connect(): void {
    if (this.isDisposed) return
    if (this.currentSocket && (this.currentSocket.readyState === WebSocket.OPEN || this.currentSocket.readyState === WebSocket.CONNECTING)) {
      return
    }

    const bearerChoice = this.selectUpgradeBearerToken()
    if (!bearerChoice) {
      this.callbacks.onStatusChange?.('error', 'No valid group credentials available for endpoint')
      return
    }

    const generation = ++this.socketGeneration
    this.isRegistered = false
    this.currentSessionId = null
    this.triedUpgradeTokens.add(bearerChoice.token)

    this.callbacks.onStatusChange?.('connecting', 'Connecting to signaling server...')

    let ws: WebSocket
    try {
      ws = new WebSocket(this.signalingUrl, {
        headers: { Authorization: `Bearer ${bearerChoice.token}` }
      })
      this.currentSocket = ws
    } catch (err) {
      this.handleSocketFailure(generation, err instanceof Error ? err : new Error(String(err)))
      return
    }

    ws.on('open', () => {
      if (this.socketGeneration !== generation) {
        ws.close()
        return
      }

      this.reconnectAttempts = 0
      this.callbacks.onStatusChange?.('connected', 'Connected. Registering identity...')

      // Send Register message immediately
      this.enqueue({
        v: 2,
        type: 'register',
        peerId: this.peerId,
        displayName: this.displayName
      })
    })

    ws.on('message', (raw: Buffer) => {
      if (this.socketGeneration !== generation) return

      let parsed: unknown
      try {
        parsed = JSON.parse(raw.toString('utf-8'))
      } catch {
        return
      }

      if (!isServerSignalingMessageV2(parsed)) return
      this.handleServerMessage(generation, parsed)
    })

    ws.on('close', () => {
      if (this.socketGeneration !== generation) return
      this.handleSocketFailure(generation, new Error('Signaling connection closed'))
    })

    ws.on('error', (err: Error) => {
      if (this.socketGeneration !== generation) return
      this.handleSocketFailure(generation, err)
    })

    ws.on('unexpected-response', (_req, res) => {
      if (this.socketGeneration !== generation) return

      if (res.statusCode === 401) {
        // Current upgrade token rejected
        const failedGroup = this.desiredGroups.get(bearerChoice.groupId)
        if (failedGroup) {
          failedGroup.status = 'auth_failed'
          failedGroup.lastError = 'AUTH_FAILED: Invalid group credentials'
          const pending = this.pendingJoins.get(failedGroup.groupId)
          if (pending) {
            clearTimeout(pending.timer)
            this.pendingJoins.delete(failedGroup.groupId)
            pending.reject(new Error('AUTH_FAILED: Invalid group credentials'))
          }
          this.callbacks.onError?.(failedGroup.groupId, 'AUTH_FAILED', 'Invalid group credentials')
        }

        // Try next available group token immediately
        const nextChoice = this.selectUpgradeBearerToken()
        if (nextChoice && !this.triedUpgradeTokens.has(nextChoice.token)) {
          this.closeSocket(ws)
          this.connect()
          return
        }

        // All desired credentials exhausted
        this.closeSocket(ws)
        this.callbacks.onStatusChange?.('error', 'All group credentials rejected with 401 Unauthorized')
        return
      }

      this.handleSocketFailure(generation, new Error(`HTTP ${res.statusCode}: Unexpected signaling response`))
    })
  }

  private handleServerMessage(generation: number, msg: ServerSignalingMessageV2): void {
    if (this.socketGeneration !== generation) return

    switch (msg.type) {
      case 'welcome': {
        this.currentSessionId = msg.sessionId
        this.isRegistered = true
        this.callbacks.onStatusChange?.('connected', 'Registered with signaling server')
        if (msg.iceConfig) {
          this.callbacks.onIceConfig?.(msg.iceConfig)
        }

        // Rejoin all desired groups on this session
        for (const group of this.desiredGroups.values()) {
          if (group.status !== 'auth_failed') {
            this.enqueue({
              v: 2,
              type: 'join-group',
              groupId: group.groupId,
              token: group.token,
              supernodeEligible: group.supernodeEligible
            })
          }
        }
        break
      }

      case 'group-joined': {
        const group = this.desiredGroups.get(msg.groupId)
        if (group) {
          group.status = 'joined'
          group.lastMembershipId = msg.membershipId
          group.lastRoster = msg.peers
          group.lastEpoch = msg.epoch
          group.lastRevision = msg.revision
        }

        const pending = this.pendingJoins.get(msg.groupId)
        if (pending) {
          clearTimeout(pending.timer)
          this.pendingJoins.delete(msg.groupId)
          pending.resolve(msg)
        }

        this.callbacks.onGroupJoined?.(msg)
        break
      }

      case 'roster': {
        const group = this.desiredGroups.get(msg.groupId)
        if (group) {
          group.lastRoster = msg.peers
          group.lastEpoch = msg.epoch
          group.lastRevision = msg.revision
        }

        this.callbacks.onRoster?.(msg.groupId, msg.epoch, msg.revision, msg.peers)
        break
      }

      case 'group-left': {
        const pending = this.pendingLeaves.get(msg.groupId)
        if (pending) {
          clearTimeout(pending.timer)
          this.pendingLeaves.delete(msg.groupId)
          pending.resolve()
        }

        this.callbacks.onGroupLeft?.(msg.groupId)
        break
      }

      case 'ice-config': {
        this.callbacks.onIceConfig?.(msg.iceConfig)
        break
      }

      case 'signal': {
        this.callbacks.onSignal?.(msg)
        break
      }

      case 'error': {
        if (msg.groupId) {
          const group = this.desiredGroups.get(msg.groupId)
          if (group) {
            group.status = msg.code === 'AUTH_FAILED' ? 'auth_failed' : 'error'
            group.lastError = `${msg.code}: ${msg.message}`
          }

          const pending = this.pendingJoins.get(msg.groupId)
          if (pending) {
            clearTimeout(pending.timer)
            this.pendingJoins.delete(msg.groupId)
            pending.reject(new Error(`${msg.code}: ${msg.message}`))
          }
        } else {
          // Global error (e.g. duplicate peer ID on register)
          if (msg.code === 'DUPLICATE_PEER_ID') {
            for (const pending of this.pendingJoins.values()) {
              clearTimeout(pending.timer)
              pending.reject(new Error(`${msg.code}: ${msg.message}`))
            }
            this.pendingJoins.clear()
          }
        }

        this.callbacks.onError?.(msg.groupId, msg.code, msg.message)
        break
      }
    }
  }

  private handleSocketFailure(generation: number, _error: Error): void {
    if (this.socketGeneration !== generation || this.isDisposed) return

    this.isRegistered = false
    this.currentSessionId = null
    this.closeSocket(this.currentSocket)
    this.currentSocket = null

    // Mark joined groups as reconnecting (not auth_failed)
    for (const group of this.desiredGroups.values()) {
      if (group.status === 'joined') {
        group.status = 'joining'
      }
    }

    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.isDisposed || this.reconnectTimer) return
    if (this.desiredGroups.size === 0) {
      this.callbacks.onStatusChange?.('disconnected', 'Disconnected')
      return
    }

    const backoffIntervals = [1000, 2000, 4000, 8000, 15000]
    const base = backoffIntervals[Math.min(this.reconnectAttempts, backoffIntervals.length - 1)]
    const jitter = Math.floor(Math.random() * 500)
    const delay = base + jitter
    this.reconnectAttempts++

    this.callbacks.onStatusChange?.(
      'recovering',
      `Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})...`
    )

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.isDisposed) {
        this.connect()
      }
    }, delay)
  }

  private enqueue(msg: ClientSignalingMessageV2): void {
    const raw = JSON.stringify(msg)
    this.outboundQueue.push(raw)
    this.processPacingQueue()
    if (this.outboundQueue.length > 0 && !this.drainTimer) {
      this.drainTimer = setInterval(() => this.processPacingQueue(), 40)
    }
  }

  private processPacingQueue(): void {
    if (!this.currentSocket || this.currentSocket.readyState !== WebSocket.OPEN) {
      if (this.drainTimer) {
        clearInterval(this.drainTimer)
        this.drainTimer = null
      }
      return
    }

    const now = Date.now()
    const elapsed = (now - this.lastTokenUpdate) / 1000
    this.lastTokenUpdate = now
    this.clientTokens = Math.min(30, this.clientTokens + elapsed * 18)

    while (this.outboundQueue.length > 0 && this.clientTokens >= 1) {
      const raw = this.outboundQueue.shift()!
      this.clientTokens -= 1
      try {
        this.currentSocket.send(raw)
      } catch {
        // ignore send error
      }
    }

    if (this.outboundQueue.length === 0 && this.drainTimer) {
      clearInterval(this.drainTimer)
      this.drainTimer = null
    }
  }

  private closeSocket(ws: WebSocket | null): void {
    if (!ws) return
    try {
      ws.close()
    } catch {
      // ignore
    }
  }

  dispose(): void {
    if (this.isDisposed) return
    this.isDisposed = true

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.drainTimer) {
      clearInterval(this.drainTimer)
      this.drainTimer = null
    }

    this.outboundQueue.length = 0

    // Reject all pending operations
    for (const pending of this.pendingJoins.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Signaling client disposed'))
    }
    this.pendingJoins.clear()

    for (const pending of this.pendingLeaves.values()) {
      clearTimeout(pending.timer)
      pending.resolve()
    }
    this.pendingLeaves.clear()

    this.closeSocket(this.currentSocket)
    this.currentSocket = null
    this.currentSessionId = null
    this.isRegistered = false

    this.callbacks.onStatusChange?.('disconnected', 'Disconnected')
  }
}
