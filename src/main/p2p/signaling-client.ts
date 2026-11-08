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
  onRoster?: (groupId: string, epoch: string, revision: number, peers: SignalingRosterPeerV2[], ownerPeerId?: string | null) => void
  onGroupLeft?: (groupId: string) => void
  onGroupKicked?: (groupId: string, reason: string) => void
  onInviteRotated?: (groupId: string, inviteCode: string) => void
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
  ownerSecret?: string
  isCreate?: boolean
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
  private readonly pendingRotations = new Map<string, { resolve: (code: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>()
  private readonly pendingRemovals = new Map<string, { resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>()

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

  async createGroup(groupId: string, ownerSecret: string, eligible: boolean): Promise<GroupJoinedMessage> {
    if (this.isDisposed) {
      throw new Error('Signaling client is disposed')
    }

    let group = this.desiredGroups.get(groupId)
    if (group) {
      group.token = 'create-group'
      group.ownerSecret = ownerSecret
      group.isCreate = true
      group.supernodeEligible = eligible
      group.status = 'joining'
    } else {
      group = {
        groupId,
        token: 'create-group',
        ownerSecret,
        isCreate: true,
        supernodeEligible: eligible,
        status: 'joining',
        lastMembershipId: null,
        lastRoster: [],
        lastEpoch: null,
        lastRevision: 1
      }
      this.desiredGroups.set(groupId, group)
    }

    const existingPending = this.pendingJoins.get(groupId)
    if (existingPending) {
      clearTimeout(existingPending.timer)
      this.pendingJoins.delete(groupId)
      existingPending.reject(new Error('Superseded by new create request'))
    }

    const { promise, resolve, reject } = Promise.withResolvers<GroupJoinedMessage>()

    const timer = setTimeout(() => {
      this.pendingJoins.delete(groupId)
      this.desiredGroups.delete(groupId)
      reject(new Error(`Timeout (10s) waiting to create group "${groupId}"`))
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
        type: 'create-group',
        groupId,
        ownerSecret,
        supernodeEligible: eligible
      })
    }

    return promise
  }

  async joinGroup(groupId: string, token: string, eligible: boolean, ownerSecret?: string): Promise<GroupJoinedMessage> {
    if (this.isDisposed) {
      throw new Error('Signaling client is disposed')
    }

    const isCodeOnly = groupId === ''
    const lookupKey = isCodeOnly ? `__code__:${token}` : groupId

    let group = this.desiredGroups.get(lookupKey)
    if (group) {
      group.token = token
      group.ownerSecret = ownerSecret
      group.supernodeEligible = eligible
      if (group.status === 'auth_failed') {
        group.status = 'joining'
        this.triedUpgradeTokens.delete(token)
      }
    } else {
      group = {
        groupId,
        token,
        ownerSecret,
        supernodeEligible: eligible,
        status: 'joining',
        lastMembershipId: null,
        lastRoster: [],
        lastEpoch: null,
        lastRevision: 1
      }
      this.desiredGroups.set(lookupKey, group)
    }

    // Cancel any pending join for this key
    const existingPending = this.pendingJoins.get(lookupKey)
    if (existingPending) {
      clearTimeout(existingPending.timer)
      this.pendingJoins.delete(lookupKey)
      existingPending.reject(new Error('Superseded by new join request'))
    }

    const { promise, resolve, reject } = Promise.withResolvers<GroupJoinedMessage>()

    const timer = setTimeout(() => {
      this.pendingJoins.delete(lookupKey)
      if (isCodeOnly) {
        this.desiredGroups.delete(lookupKey)
      }
      reject(new Error(`Timeout (10s) waiting to join group ${groupId ? `"${groupId}"` : 'with invite code'}`))
    }, 10000)
    this.pendingJoins.set(lookupKey, {
      groupId,
      resolve,
      reject,
      timer
    })

    if (!this.currentSocket || this.currentSocket.readyState === WebSocket.CLOSED) {
      this.connect()
    } else if (this.isConnectedAndRegistered()) {
      if (isCodeOnly) {
        this.enqueue({
          v: 2,
          type: 'join-group',
          token,
          supernodeEligible: group.supernodeEligible
        })
      } else {
        this.enqueue({
          v: 2,
          type: 'join-group',
          groupId,
          token,
          ownerSecret,
          supernodeEligible: group.supernodeEligible
        })
      }
    }

    return promise
  }

  async rotateInvite(groupId: string, ownerSecret: string): Promise<string> {
    if (this.isDisposed) throw new Error('Signaling client is disposed')
    if (!this.isConnectedAndRegistered()) {
      throw new Error('Not connected to signaling server')
    }

    const existing = this.pendingRotations.get(groupId)
    if (existing) {
      clearTimeout(existing.timer)
      this.pendingRotations.delete(groupId)
      existing.reject(new Error('Superseded by new rotate request'))
    }

    const { promise, resolve, reject } = Promise.withResolvers<string>()
    const timer = setTimeout(() => {
      this.pendingRotations.delete(groupId)
      reject(new Error(`Timeout (10s) waiting to rotate invite for group "${groupId}"`))
    }, 10000)
    this.pendingRotations.set(groupId, { resolve, reject, timer })
    this.enqueue({
      v: 2,
      type: 'rotate-invite',
      groupId,
      ownerSecret
    })

    return promise
  }

  async removeMember(groupId: string, targetPeerId: string, ownerSecret: string): Promise<void> {
    if (this.isDisposed) throw new Error('Signaling client is disposed')
    if (!this.isConnectedAndRegistered()) {
      throw new Error('Not connected to signaling server')
    }

    const key = `${groupId}:${targetPeerId}`
    const existing = this.pendingRemovals.get(key)
    if (existing) {
      clearTimeout(existing.timer)
      this.pendingRemovals.delete(key)
      existing.reject(new Error('Superseded by new remove request'))
    }

    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const timer = setTimeout(() => {
      this.pendingRemovals.delete(key)
      // Resolve after timeout to remain robust
      resolve()
    }, 2000)
    this.pendingRemovals.set(key, { resolve, reject, timer })
    this.enqueue({
      v: 2,
      type: 'remove-member',
      groupId,
      targetPeerId,
      ownerSecret
    })

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
        for (const [key, group] of this.desiredGroups.entries()) {
          if (group.status !== 'auth_failed') {
            if (group.isCreate) {
              this.enqueue({
                v: 2,
                type: 'create-group',
                groupId: group.groupId,
                ownerSecret: group.ownerSecret || '',
                supernodeEligible: group.supernodeEligible
              })
            } else if (key.startsWith('__code__:')) {
              this.enqueue({
                v: 2,
                type: 'join-group',
                token: group.token,
                supernodeEligible: group.supernodeEligible
              })
            } else {
              this.enqueue({
                v: 2,
                type: 'join-group',
                groupId: group.groupId,
                token: group.token,
                ownerSecret: group.ownerSecret,
                supernodeEligible: group.supernodeEligible
              })
            }
          }
        }
        break
      }

      case 'group-joined': {
        let pending = this.pendingJoins.get(msg.groupId)
        let desired = this.desiredGroups.get(msg.groupId)

        if (!pending) {
          const codeKey = msg.inviteCode ? `__code__:${msg.inviteCode}` : ''
          let foundKey = ''
          if (codeKey && this.pendingJoins.has(codeKey)) {
            foundKey = codeKey
          } else {
            for (const key of this.pendingJoins.keys()) {
              if (key.startsWith('__code__:')) {
                foundKey = key
                break
              }
            }
          }

          if (foundKey) {
            pending = this.pendingJoins.get(foundKey)
            this.pendingJoins.delete(foundKey)
            const codeGroup = this.desiredGroups.get(foundKey)
            if (codeGroup) {
              this.desiredGroups.delete(foundKey)
              desired = {
                groupId: msg.groupId,
                token: msg.inviteCode || codeGroup.token,
                ownerSecret: codeGroup.ownerSecret,
                supernodeEligible: codeGroup.supernodeEligible,
                status: 'joined',
                lastMembershipId: msg.membershipId,
                lastRoster: msg.peers,
                lastEpoch: msg.epoch,
                lastRevision: msg.revision
              }
              this.desiredGroups.set(msg.groupId, desired)
            }
          }
        }

        if (desired) {
          desired.status = 'joined'
          desired.isCreate = false
          if (msg.inviteCode) {
            desired.token = msg.inviteCode
          }
          desired.lastMembershipId = msg.membershipId
          desired.lastRoster = msg.peers
          desired.lastEpoch = msg.epoch
          desired.lastRevision = msg.revision
        }

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

        // Check if any pending removal was satisfied by this roster update
        for (const [key, rem] of this.pendingRemovals.entries()) {
          if (key.startsWith(`${msg.groupId}:`)) {
            const targetPeerId = key.slice(`${msg.groupId}:`.length)
            if (!msg.peers.some((p) => p.peerId === targetPeerId)) {
              clearTimeout(rem.timer)
              this.pendingRemovals.delete(key)
              rem.resolve()
            }
          }
        }

        this.callbacks.onRoster?.(msg.groupId, msg.epoch, msg.revision, msg.peers, msg.ownerPeerId)
        break
      }

      case 'invite-rotated': {
        const group = this.desiredGroups.get(msg.groupId)
        if (group) {
          group.token = msg.inviteCode
        }

        const pendingRot = this.pendingRotations.get(msg.groupId)
        if (pendingRot) {
          clearTimeout(pendingRot.timer)
          this.pendingRotations.delete(msg.groupId)
          pendingRot.resolve(msg.inviteCode)
        }

        this.callbacks.onInviteRotated?.(msg.groupId, msg.inviteCode)
        break
      }

      case 'group-kicked': {
        this.desiredGroups.delete(msg.groupId)
        this.callbacks.onGroupKicked?.(msg.groupId, msg.reason)
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
            if (group.isCreate) {
              this.desiredGroups.delete(msg.groupId)
            } else {
              group.status = msg.code === 'AUTH_FAILED' ? 'auth_failed' : 'error'
              group.lastError = `${msg.code}: ${msg.message}`
            }
          }

          const pending = this.pendingJoins.get(msg.groupId)
          if (pending) {
            clearTimeout(pending.timer)
            this.pendingJoins.delete(msg.groupId)
            pending.reject(new Error(`${msg.code}: ${msg.message}`))
          } else {
            // Also reject and clean up pending code-only join if any
            for (const [key, p] of this.pendingJoins.entries()) {
              if (key.startsWith('__code__:')) {
                clearTimeout(p.timer)
                this.pendingJoins.delete(key)
                this.desiredGroups.delete(key)
                p.reject(new Error(`${msg.code}: ${msg.message}`))
                break
              }
            }
          }
          const pendingRot = this.pendingRotations.get(msg.groupId)
          if (pendingRot) {
            clearTimeout(pendingRot.timer)
            this.pendingRotations.delete(msg.groupId)
            pendingRot.reject(new Error(`${msg.code}: ${msg.message}`))
          }

          for (const [key, rem] of this.pendingRemovals.entries()) {
            if (key.startsWith(`${msg.groupId}:`)) {
              clearTimeout(rem.timer)
              this.pendingRemovals.delete(key)
              rem.reject(new Error(`${msg.code}: ${msg.message}`))
            }
          }
        } else {
          // Global error (e.g. AUTH_FAILED on code-only join or DUPLICATE_PEER_ID)
          for (const [key, pending] of this.pendingJoins.entries()) {
            if (key.startsWith('__code__:')) {
              clearTimeout(pending.timer)
              this.pendingJoins.delete(key)
              this.desiredGroups.delete(key)
              pending.reject(new Error(`${msg.code}: ${msg.message}`))
            } else if (msg.code === 'DUPLICATE_PEER_ID') {
              clearTimeout(pending.timer)
              pending.reject(new Error(`${msg.code}: ${msg.message}`))
              this.pendingJoins.delete(key)
            }
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
      ws.terminate()
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

    for (const pending of this.pendingRotations.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Signaling client disposed'))
    }
    this.pendingRotations.clear()

    for (const pending of this.pendingRemovals.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Signaling client disposed'))
    }
    this.pendingRemovals.clear()

    this.closeSocket(this.currentSocket)
    this.currentSocket = null
    this.currentSessionId = null
    this.isRegistered = false

    this.callbacks.onStatusChange?.('disconnected', 'Disconnected')
  }
}
