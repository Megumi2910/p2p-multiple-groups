import WebSocket from 'ws'
import type { RTCDataChannel } from 'werift'
import { performance } from 'node:perf_hooks'
import {
  type ConnectOptions,
  type P2pCandidatePath,
  type P2pLinkState,
  type P2pNetworkState,
  type P2pRecoveryEvent,
  type P2pRole,
  type P2pRosterMember,
  type P2pState,
  validateConnectOptions
} from '../../shared/p2p.ts'
import {
  isServerSignalingMessage,
  type OverlayControlMessage,
  type OverlayPingMessage,
  type OverlayPongMessage,
  type ServerSignalingMessage,
  type SignalingRosterPeer,
  type OverlayCatalogBeginMessage,
  type OverlayCatalogBatchMessage,
  type OverlayCatalogEndMessage
} from '../../shared/p2p-wire.ts'
import type { P2pSearchResult } from '../../shared/p2p.ts'
import { randomUUID } from 'node:crypto'
import { LibraryManager } from './library.ts'
import { SupernodeIndexManager, SearchResultsTracker } from './search-index.ts'
import { TransferManager } from './transfers.ts'
import { createPeerStore, type PeerStore } from './peer-store.ts'
import { TransportManager } from './transport.ts'
import {
  calculatePeerRole,
  electSupernodes,
  RecoveryEventRingBuffer,
  selectSupernodesForPeer
} from './election.ts'

export interface PeerEngine {
  getState(): P2pState
  subscribe(listener: (state: P2pState) => void): () => void
  connect(options: ConnectOptions): Promise<void>
  disconnect(): Promise<void>
  setSupernodeEligible(eligible: boolean): Promise<void>
  addFiles(paths: readonly string[]): Promise<void>
  rescanLibrary(): Promise<void>
  removeFile(fileId: string): Promise<void>
  search(query: string): Promise<void>
  download(resultId: string, destination: string): Promise<void>
  cancelTransfer(transferId: string): Promise<void>
  resolveSearchResult(resultId: string): P2pSearchResult | undefined
  getAuthorizedFile(fileId: string): Promise<{ path: string; size: number; sha256: string }>
  dispose(): Promise<void>
}

export async function createPeerEngine(options: { dataDirectory: string }): Promise<PeerEngine> {
  const store: PeerStore = await createPeerStore(options.dataDirectory)
  const persisted = store.get()

  const recoveryRing = new RecoveryEventRingBuffer(100)
  const subscribers = new Set<(state: P2pState) => void>()
  let stateRevision = 1
  let isDisposed = false

  // Active network state
  let currentStatus: P2pNetworkState['status'] = 'disconnected'
  let currentSessionId: string | null = null
  let currentEpoch: string | null = null
  let currentMembershipRevision = 0
  let currentRole: P2pRole = 'ordinary'
  let currentPrimaryId: string | null = null
  let currentStandbyId: string | null = null
  let currentMessage: string | null = null
  let currentMembers: P2pRosterMember[] = []
  let lastRosterTimestamp = 0

  // Recovery tracking
  let lossDetectedTimestamp: number | null = null
  let activeElectedSupernodes: string[] = []

  // Link responsiveness tracking: peerId -> timestamp of last pong
  const linkPongs = new Map<string, number>()

  // Signaling socket and reconnect timer
  let signalingWs: WebSocket | null = null
  let activeConnectOptions: ConnectOptions | null = null
  let reconnectTimer: NodeJS.Timeout | null = null
  let reconnectAttempts = 0
  let isExplicitlyDisconnected = true
  // Outbound signaling pacer to prevent tripping server rate limiter
  const outboundSignalingQueue: string[] = []
  let signalingDrainTimer: NodeJS.Timeout | null = null
  let clientTokens = 30
  let lastClientTokenUpdate = Date.now()

  function processSignalingQueue(): void {
    if (!signalingWs || signalingWs.readyState !== WebSocket.OPEN) {
      if (signalingDrainTimer) {
        clearInterval(signalingDrainTimer)
        signalingDrainTimer = null
      }
      return
    }
    const now = Date.now()
    const elapsed = (now - lastClientTokenUpdate) / 1000
    lastClientTokenUpdate = now
    clientTokens = Math.min(30, clientTokens + elapsed * 18)

    while (outboundSignalingQueue.length > 0 && clientTokens >= 1) {
      const msgStr = outboundSignalingQueue.shift()!
      clientTokens -= 1
      try {
        signalingWs.send(msgStr)
      } catch {
        // ignore send error
      }
    }

    if (outboundSignalingQueue.length === 0 && signalingDrainTimer) {
      clearInterval(signalingDrainTimer)
      signalingDrainTimer = null
    }
  }

  function enqueueSignaling(msgStr: string): void {
    outboundSignalingQueue.push(msgStr)
    processSignalingQueue()
    if (outboundSignalingQueue.length > 0 && !signalingDrainTimer) {
      signalingDrainTimer = setInterval(processSignalingQueue, 40)
    }
  }
  // Library and search managers
  const library = new LibraryManager()
  const supernodeIndex = new SupernodeIndexManager()
  const searchResults = new SearchResultsTracker()
  const transfers = new TransferManager({
    onStateChange: () => publishState(),
    getAuthorizedFile: (fileId) => library.getAuthorizedFile(fileId),
    getPeerPath: (peerId) => transport.getLinkState(peerId)?.path || 'unknown'
  })

  let currentSearchQueryId: string | null = null
  let currentSearchQueryText = ''
  let currentSearchStatus: 'idle' | 'searching' | 'complete' | 'partial' | 'error' = 'idle'
  let currentSearchMessage: string | null = null
  let searchTimeoutTimer: NodeJS.Timeout | undefined

  void library.loadStoredFiles(persisted.sharedFiles)

  library.subscribe(() => {
    publishState()
  })

  function announceCatalogue(): void {
    if (isDisposed || isExplicitlyDisconnected) return
    const p = store.get()
    const gen = library.getGeneration()

    if (currentRole === 'supernode') {
      if (currentSessionId) {
        supernodeIndex.updateLocalCatalogue(
          p.peerId,
          currentSessionId,
          gen,
          library.getSharedMetadata()
        )
        library.setAcknowledgedGeneration(gen)
      }
      return
    }

    if (currentRole === 'ordinary' && currentPrimaryId && currentEpoch) {
      const targetId = currentPrimaryId
      const batches = library.createBatches()
      const allEntries = library.getSharedMetadata()

      const sendBatches = () => {
        const begin: OverlayCatalogBeginMessage = {
          v: 1,
          type: 'catalog-begin',
          epoch: currentEpoch!,
          revision: currentMembershipRevision,
          generation: gen,
          count: allEntries.length
        }
        transport.sendControl(targetId, begin)

        for (const batch of batches) {
          const batchMsg: OverlayCatalogBatchMessage = {
            v: 1,
            type: 'catalog-batch',
            epoch: currentEpoch!,
            revision: currentMembershipRevision,
            generation: gen,
            entries: batch
          }
          transport.sendControl(targetId, batchMsg)
        }

        const end: OverlayCatalogEndMessage = {
          v: 1,
          type: 'catalog-end',
          epoch: currentEpoch!,
          revision: currentMembershipRevision,
          generation: gen
        }
        transport.sendControl(targetId, end)
      }

      if (transport.getLinkState(targetId)?.state === 'open') {
        sendBatches()
      } else {
        const checkTimer = setInterval(() => {
          if (transport.getLinkState(targetId)?.state === 'open') {
            clearInterval(checkTimer)
            sendBatches()
          }
        }, 50)
        setTimeout(() => clearInterval(checkTimer), 5000)
      }
    }
  }
  let transport: TransportManager

  const hooks: {
    controlMessage: ((fromPeerId: string, message: OverlayControlMessage) => void) | null
    fileChannel: ((fromPeerId: string, transferId: string, channel: unknown) => void) | null
  } = {
    controlMessage: (fromPeerId, msg) => {
      switch (msg.type) {
        case 'catalog-begin': {
          if (currentRole === 'supernode') {
            const senderSession = currentMembers.find((m) => m.peerId === fromPeerId)?.sessionId || ''
            const instantAck = supernodeIndex.handleCatalogBegin(fromPeerId, senderSession, msg)
            if (instantAck) {
              transport.sendControl(fromPeerId, {
                v: 1,
                type: 'catalog-ack',
                epoch: currentEpoch || '',
                revision: currentMembershipRevision,
                generation: msg.generation
              })
            }
          }
          break
        }
        case 'catalog-batch': {
          if (currentRole === 'supernode') {
            supernodeIndex.handleCatalogBatch(fromPeerId, msg)
          }
          break
        }
        case 'catalog-end': {
          if (currentRole === 'supernode') {
            const senderSession = currentMembers.find((m) => m.peerId === fromPeerId)?.sessionId || ''
            const swapped = supernodeIndex.handleCatalogEnd(fromPeerId, senderSession, msg)
            if (swapped) {
              transport.sendControl(fromPeerId, {
                v: 1,
                type: 'catalog-ack',
                epoch: currentEpoch || '',
                revision: currentMembershipRevision,
                generation: msg.generation
              })
            }
          }
          break
        }
        case 'catalog-ack': {
          if (msg.generation === library.getGeneration()) {
            library.setAcknowledgedGeneration(msg.generation)
            recoveryRing.add(
              'index-ready',
              [fromPeerId],
              currentEpoch,
              currentMembershipRevision,
              null,
              'Catalogue indexed and acknowledged by supernode'
            )
            publishState()
          }
          break
        }
        case 'search': {
          if (currentRole === 'supernode') {
            const res = supernodeIndex.search(msg.query, fromPeerId, msg.queryId)
            const batches = supernodeIndex.splitResultBatches(res.entries)
            const hasForward = msg.ttl > 0 && activeElectedSupernodes.some((id) => id !== store.get().peerId && id !== fromPeerId)

            if (batches.length === 0) {
              transport.sendControl(fromPeerId, {
                v: 1,
                type: 'search-results',
                epoch: currentEpoch || '',
                revision: currentMembershipRevision,
                queryId: msg.queryId,
                originPeerId: fromPeerId,
                entries: [],
                done: !hasForward,
                partial: false
              })
            } else {
              batches.forEach((batch, idx) => {
                transport.sendControl(fromPeerId, {
                  v: 1,
                  type: 'search-results',
                  epoch: currentEpoch || '',
                  revision: currentMembershipRevision,
                  queryId: msg.queryId,
                  originPeerId: fromPeerId,
                  entries: batch,
                  done: idx === batches.length - 1 && !hasForward,
                  partial: false
                })
              })
            }

            if (msg.ttl > 0) {
              const otherSupernode = activeElectedSupernodes.find(
                (id) => id !== store.get().peerId && id !== fromPeerId
              )
              if (otherSupernode) {
                transport.sendControl(otherSupernode, {
                  v: 1,
                  type: 'search-forward',
                  epoch: currentEpoch || '',
                  revision: currentMembershipRevision,
                  queryId: msg.queryId,
                  query: msg.query,
                  originPeerId: fromPeerId,
                  ttl: 0
                })
              }
            }
          }
          break
        }
        case 'search-forward': {
          if (currentRole === 'supernode') {
            const res = supernodeIndex.search(msg.query, msg.originPeerId, msg.queryId)
            const batches = supernodeIndex.splitResultBatches(res.entries)
            const target = transport.getLinkState(msg.originPeerId)?.state === 'open' ? msg.originPeerId : fromPeerId

            if (batches.length === 0) {
              transport.sendControl(target, {
                v: 1,
                type: 'search-results',
                epoch: currentEpoch || '',
                revision: currentMembershipRevision,
                queryId: msg.queryId,
                originPeerId: msg.originPeerId,
                entries: [],
                done: true,
                partial: false
              })
            } else {
              batches.forEach((batch, idx) => {
                transport.sendControl(target, {
                  v: 1,
                  type: 'search-results',
                  epoch: currentEpoch || '',
                  revision: currentMembershipRevision,
                  queryId: msg.queryId,
                  originPeerId: msg.originPeerId,
                  entries: batch,
                  done: idx === batches.length - 1,
                  partial: false
                })
              })
            }
          }
          break
        }
        case 'search-results': {
          const myPeerId = store.get().peerId
          if (msg.originPeerId === myPeerId) {
            if (msg.queryId === currentSearchQueryId) {
              searchResults.addBatch(msg.queryId, msg.entries, (id) => {
                const member = currentMembers.find((m) => m.peerId === id)
                return member ? member.displayName : `Peer-${id.slice(0, 6)}`
              })
              if (msg.done) {
                currentSearchStatus = 'complete'
              }
              publishState()
            }
          } else if (currentRole === 'supernode') {
            transport.sendControl(msg.originPeerId, msg)
          }
          break
        }
      }
    },
    fileChannel: (fromPeerId, transferId, channel) => {
      void transfers.handleIncomingChannel(fromPeerId, transferId, channel as RTCDataChannel)
    }
  }
  transport = new TransportManager({
    onControlMessage: (fromPeerId, msg) => {
      if (msg.type === 'ping') {
        const pong: OverlayPongMessage = {
          v: 1,
          type: 'pong',
          epoch: msg.epoch,
          revision: msg.revision
        }
        transport.sendControl(fromPeerId, pong)
        return
      }
      if (msg.type === 'pong') {
        linkPongs.set(fromPeerId, Date.now())
        return
      }

      hooks.controlMessage?.(fromPeerId, msg)
    },
    onFileChannel: (fromPeerId, transferId, channel) => {
      hooks.fileChannel?.(fromPeerId, transferId, channel)
    },
    onLinkStateChange: (peerId, state, path) => {
      if (state === 'open') {
        linkPongs.set(peerId, Date.now())
        if (peerId === currentPrimaryId) {
          announceCatalogue()
        }
      }
      publishState()
    },
    onSendSignal: (sig) => {
      enqueueSignaling(
        JSON.stringify({
          v: 1,
          type: 'signal',
          targetPeerId: sig.targetPeerId,
          targetSessionId: sig.targetSessionId,
          connectionId: sig.connectionId,
          kind: sig.kind,
          payload: sig.payload
        })
      )
    }
  })

  function buildStateSnapshot(): P2pState {
    const p = store.get()
    return {
      revision: stateRevision,
      network: {
        status: currentStatus,
        peerId: p.peerId,
        sessionId: currentSessionId,
        displayName: p.displayName,
        supernodeEligible: p.supernodeEligible,
        signalingUrl: activeConnectOptions ? activeConnectOptions.signalingUrl : p.signalingUrl,
        roomId: activeConnectOptions ? activeConnectOptions.roomId : p.roomId,
        role: currentRole,
        epoch: currentEpoch,
        membershipRevision: currentMembershipRevision,
        primaryPeerId: currentPrimaryId,
        standbyPeerId: currentStandbyId,
        members: [...currentMembers],
        links: transport.getAllLinks(),
        message: currentMessage
      },
      library: library.getState(),
      search: {
        queryId: currentSearchQueryId,
        query: currentSearchQueryText,
        status: currentSearchStatus,
        results: searchResults.getResults(),
        message: currentSearchMessage
      },
      transfers: transfers.getTransfers(),
      recoveryEvents: recoveryRing.getAll()
    }
  }

  function publishState(): void {
    stateRevision++
    const snapshot = buildStateSnapshot()
    for (const listener of subscribers) {
      try {
        listener(snapshot)
      } catch {
        // ignore subscriber errors
      }
    }
  }

  function scheduleReconnect(): void {
    if (isExplicitlyDisconnected || isDisposed) return
    if (reconnectTimer) return

    const intervals = [1000, 2000, 4000, 8000, 15000]
    const base = intervals[Math.min(reconnectAttempts, intervals.length - 1)]
    const jitter = Math.floor(Math.random() * 500)
    const delay = base + jitter
    reconnectAttempts++

    currentStatus = 'recovering'
    currentMessage = `Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${reconnectAttempts})...`
    publishState()

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (!isExplicitlyDisconnected && !isDisposed && activeConnectOptions) {
        doConnect(activeConnectOptions).catch(() => {})
      }
    }, delay)
  }

  async function doConnect(opts: ConnectOptions): Promise<void> {
    if (signalingWs) {
      try {
        signalingWs.close()
      } catch {
        // ignore
      }
      signalingWs = null
    }

    currentStatus = 'connecting'
    currentMessage = 'Connecting to signaling helper...'
    publishState()
    if (signalingDrainTimer) {
      clearInterval(signalingDrainTimer)
      signalingDrainTimer = null
    }
    outboundSignalingQueue.length = 0
    clientTokens = 30
    lastClientTokenUpdate = Date.now()

    const { promise, resolve, reject } = Promise.withResolvers<void>()
    let connected = false

    try {
      const ws = new WebSocket(opts.signalingUrl, {
        headers: { Authorization: `Bearer ${opts.token}` }
      })
      signalingWs = ws

      ws.on('open', () => {
        connected = true
        reconnectAttempts = 0
        currentStatus = 'connected'
        currentMessage = 'Connected to signaling helper. Joining room...'
        publishState()

        const p = store.get()
        ws.send(
          JSON.stringify({
            v: 1,
            type: 'join',
            roomId: opts.roomId,
            peerId: p.peerId,
            displayName: opts.displayName,
            supernodeEligible: p.supernodeEligible
          })
        )
      })

      ws.on('message', (data: Buffer) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(data.toString('utf-8'))
        } catch {
          return
        }

        if (!isServerSignalingMessage(parsed)) return
        const msg = parsed as ServerSignalingMessage

        if (msg.type === 'welcome') {
          currentSessionId = msg.sessionId
          currentEpoch = msg.epoch
          transport.setSignalingContext(
            msg.epoch,
            1,
            store.get().peerId,
            msg.sessionId,
            msg.iceConfig,
            opts.relayOnly
          )
          resolve()
          publishState()
          return
        }

        if (msg.type === 'roster') {
          handleRosterUpdate(msg.epoch, msg.revision, msg.peers)
          return
        }

        if (msg.type === 'signal') {
          void transport.handleSignal(
            msg.fromPeerId,
            msg.fromSessionId,
            msg.connectionId,
            msg.kind,
            msg.payload
          )
          return
        }

        if (msg.type === 'error') {
          currentStatus = 'error'
          currentMessage = `${msg.code}: ${msg.message}`
          publishState()
          if (!connected) {
            reject(new Error(`${msg.code}: ${msg.message}`))
          }
        }
      })

      ws.on('close', () => {
        if (!connected) {
          reject(new Error('Signaling connection failed'))
        }
        if (!isExplicitlyDisconnected && !isDisposed) {
          scheduleReconnect()
        }
      })

      ws.on('error', (err) => {
        if (!connected) {
          reject(err)
        }
      })
    } catch (err) {
      reject(err)
    }

    return promise
  }

  function handleRosterUpdate(epoch: string, revision: number, peers: SignalingRosterPeer[]): void {
    if (epoch !== currentEpoch) {
      currentEpoch = epoch
    }
    currentMembershipRevision = revision
    lastRosterTimestamp = Date.now()

    const localPeerId = store.get().peerId
    const election = electSupernodes(peers)
    const newElectedIds = election.electedSupernodes.map((s) => s.peerId)

    // Detect lost supernodes
    const lostSupernodes = activeElectedSupernodes.filter((id) => !newElectedIds.includes(id))
    if (lostSupernodes.length > 0) {
      lossDetectedTimestamp = performance.now()
      recoveryRing.add(
        'supernode-lost',
        lostSupernodes,
        epoch,
        revision,
        null,
        `Lost supernode(s): ${lostSupernodes.join(', ')}`
      )
    }
    activeElectedSupernodes = newElectedIds

    // Compute own role
    const prevRole = currentRole
    const newRole = calculatePeerRole(localPeerId, election.electedSupernodes)
    currentRole = newRole

    if (prevRole !== newRole) {
      recoveryRing.add(
        'role-changed',
        [localPeerId],
        epoch,
        revision,
        null,
        `Role changed from ${prevRole} to ${newRole}`
      )
    }

    // Compute primary and standby
    const prevPrimary = currentPrimaryId
    if (newRole === 'ordinary') {
      const selected = selectSupernodesForPeer(localPeerId, election.electedSupernodes)
      currentPrimaryId = selected.primary ? selected.primary.peerId : null
      currentStandbyId = selected.standby ? selected.standby.peerId : null
    } else {
      currentPrimaryId = null
      currentStandbyId = null
    }

    if (currentPrimaryId !== prevPrimary && currentPrimaryId !== null) {
      let durationMs: number | null = null
      if (lossDetectedTimestamp !== null) {
        durationMs = Math.round(performance.now() - lossDetectedTimestamp)
        lossDetectedTimestamp = null
      }

      recoveryRing.add(
        'route-changed',
        currentPrimaryId ? [currentPrimaryId] : [],
        epoch,
        revision,
        durationMs,
        `Primary serving route updated to ${currentPrimaryId}`
      )
    }

    // Prune departed members from supernode index before updating roster
    const activeIds = new Set(peers.map((p) => p.peerId))
    for (const member of currentMembers) {
      if (!activeIds.has(member.peerId)) {
        supernodeIndex.removeOwner(member.peerId)
      }
    }

    // Update roster members with calculated roles
    currentMembers = peers.map((p) => ({
      peerId: p.peerId,
      sessionId: p.sessionId,
      joinOrder: p.joinOrder,
      displayName: p.displayName,
      supernodeEligible: p.supernodeEligible,
      role: calculatePeerRole(p.peerId, election.electedSupernodes)
    }))

    // Update status message
    if (election.electedSupernodes.length === 0) {
      currentMessage = 'No eligible supernode available in network.'
    } else if (newRole === 'supernode') {
      currentMessage = `Operating as active supernode (${election.electedSupernodes.length} total).`
    } else {
      currentMessage = `Connected to supernode ${currentPrimaryId || 'none'}.`
    }

    // Update transport roster
    transport.updateRoster(peers)
    announceCatalogue()
    publishState()
  }
  // Periodic heartbeat & freshness monitor: every 2 seconds
  const monitorTimer = setInterval(() => {
    if (isDisposed || isExplicitlyDisconnected) return

    const now = Date.now()

    // 1. Roster freshness check: >6s without roster update -> degraded
    if (lastRosterTimestamp > 0 && now - lastRosterTimestamp > 6000) {
      if (currentStatus === 'connected') {
        currentStatus = 'degraded'
        currentMessage = 'Membership unavailable (no heartbeat from signaling helper).'
        recoveryRing.add(
          'membership-unavailable',
          [],
          currentEpoch,
          currentMembershipRevision,
          null,
          'Signaling roster expired (>6s without update)'
        )
        publishState()
      }
    }

    // 2. Control link heartbeat & failover for ordinary peers
    if (currentRole === 'ordinary' && currentPrimaryId) {
      const primaryPing = transport.sendControl(currentPrimaryId, {
        v: 1,
        type: 'ping',
        epoch: currentEpoch || '',
        revision: currentMembershipRevision
      })

      const lastPong = linkPongs.get(currentPrimaryId) || 0
      const unresponsive = !primaryPing || (lastPong > 0 && now - lastPong > 6000)

      if (unresponsive && currentStandbyId) {
        // Failover to standby supernode
        const failedPrimary = currentPrimaryId
        currentPrimaryId = currentStandbyId
        currentStandbyId = failedPrimary

        recoveryRing.add(
          'route-changed',
          [currentPrimaryId],
          currentEpoch,
          currentMembershipRevision,
          null,
          `Primary route unresponsive, switched to standby: ${currentPrimaryId}`
        )
        publishState()
      }
    }
  }, 2000)

  return {
    getState: () => buildStateSnapshot(),

    subscribe: (listener: (state: P2pState) => void) => {
      subscribers.add(listener)
      return () => {
        subscribers.delete(listener)
      }
    },

    connect: async (opts: ConnectOptions) => {
      const check = validateConnectOptions(opts)
      if (!check.valid) {
        throw new Error(`Invalid connect options: ${check.error}`)
      }
      activeConnectOptions = check.value
      isExplicitlyDisconnected = false
      reconnectAttempts = 0

      await store.setDisplayName(opts.displayName)
      await store.setSupernodeEligible(opts.supernodeEligible)
      await store.setConnectionParams(opts.signalingUrl, opts.roomId)

      await doConnect(check.value)
    },

    disconnect: async () => {
      isExplicitlyDisconnected = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (signalingDrainTimer) {
        clearInterval(signalingDrainTimer)
        signalingDrainTimer = null
      }
      outboundSignalingQueue.length = 0
      if (signalingWs) {
        try {
          signalingWs.send(JSON.stringify({ v: 1, type: 'leave' }))
          signalingWs.close()
        } catch {
          // ignore
        }
        signalingWs = null
      }
      await transfers.dispose()
      await transport.dispose()
      currentStatus = 'disconnected'
      currentSessionId = null
      currentEpoch = null
      currentMembershipRevision = 0
      currentPrimaryId = null
      currentStandbyId = null
      currentMembers = []
      currentMessage = 'Disconnected.'
      publishState()
    },

    setSupernodeEligible: async (eligible: boolean) => {
      await store.setSupernodeEligible(eligible)
      if (signalingWs && signalingWs.readyState === WebSocket.OPEN) {
        signalingWs.send(
          JSON.stringify({
            v: 1,
            type: 'eligibility',
            supernodeEligible: eligible
          })
        )
      }
      publishState()
    },

    addFiles: async (paths: readonly string[]) => {
      const added = await library.addFiles(paths)
      for (const item of added) {
        await store.addSharedFile(item)
      }
      announceCatalogue()
    },

    rescanLibrary: async () => {
      await library.rescan()
      announceCatalogue()
    },

    removeFile: async (fileId: string) => {
      library.removeFile(fileId)
      await store.removeSharedFile(fileId)
      announceCatalogue()
    },

    search: async (queryText: string) => {
      const trimmed = queryText.trim()
      if (trimmed.length < 1 || trimmed.length > 120) {
        throw new Error('Query must be 1 to 120 characters')
      }
      currentSearchQueryText = trimmed
      currentSearchQueryId = randomUUID()
      currentSearchStatus = 'searching'
      currentSearchMessage = null
      searchResults.startNewSearch(currentSearchQueryId, trimmed)
      publishState()

      clearTimeout(searchTimeoutTimer)
      searchTimeoutTimer = undefined
      searchTimeoutTimer = setTimeout(() => {
        if (currentSearchStatus === 'searching') {
          currentSearchStatus = 'complete'
          publishState()
        }
      }, 8000)

      if (currentRole === 'supernode') {
        const localRes = supernodeIndex.search(trimmed, store.get().peerId, currentSearchQueryId)
        searchResults.addBatch(currentSearchQueryId, localRes.entries, (id) => {
          const m = currentMembers.find((x) => x.peerId === id)
          return m ? m.displayName : `Peer-${id.slice(0, 6)}`
        })

        const otherSupernode = activeElectedSupernodes.find((id) => id !== store.get().peerId)
        if (otherSupernode) {
          transport.sendControl(otherSupernode, {
            v: 1,
            type: 'search-forward',
            epoch: currentEpoch || '',
            revision: currentMembershipRevision,
            queryId: currentSearchQueryId,
            query: trimmed,
            originPeerId: store.get().peerId,
            ttl: 0
          })
        } else {
          currentSearchStatus = 'complete'
        }
        publishState()
      } else if (currentRole === 'ordinary' && currentPrimaryId) {
        const targetId = currentPrimaryId
        const queryId = currentSearchQueryId
        const sendSearch = () => {
          transport.sendControl(targetId, {
            v: 1,
            type: 'search',
            epoch: currentEpoch || '',
            revision: currentMembershipRevision,
            queryId,
            query: trimmed,
            ttl: 1
          })
        }

        if (transport.getLinkState(targetId)?.state === 'open') {
          sendSearch()
        } else {
          const checkTimer = setInterval(() => {
            if (transport.getLinkState(targetId)?.state === 'open') {
              clearInterval(checkTimer)
              sendSearch()
            }
          }, 50)
          setTimeout(() => clearInterval(checkTimer), 5000)
        }
      } else {
        currentSearchStatus = 'error'
        currentSearchMessage = 'No supernode available to route search'
        publishState()
      }
    },

    download: async (resultId: string, destination: string) => {
      const result = searchResults.resolveResult(resultId)
      if (!result) {
        throw new Error('NOT_FOUND')
      }
      const transferId = randomUUID()
      await transfers.startDownload({
        transferId,
        fileId: result.file.fileId,
        fileName: result.file.name,
        size: result.file.size,
        sha256: result.file.sha256,
        peerId: result.ownerPeerId,
        peerName: result.ownerName,
        destination,
        openChannel: () => transport.openFileChannel(result.ownerPeerId, transferId)
      })
    },

    cancelTransfer: async (transferId: string) => {
      await transfers.cancelTransfer(transferId)
    },

    resolveSearchResult: (resultId: string) => {
      return searchResults.resolveResult(resultId)
    },

    getAuthorizedFile: async (fileId: string) => {
      return library.getAuthorizedFile(fileId)
    },
    dispose: async () => {
      if (isDisposed) return
      isDisposed = true
      clearInterval(monitorTimer)
      if (searchTimeoutTimer) {
        clearTimeout(searchTimeoutTimer)
        searchTimeoutTimer = undefined
      }
      supernodeIndex.clear()
      searchResults.clear()
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (signalingDrainTimer) {
        clearInterval(signalingDrainTimer)
        signalingDrainTimer = null
      }
      outboundSignalingQueue.length = 0
      if (signalingWs) {
        try {
          signalingWs.close()
        } catch {
          // ignore
        }
        signalingWs = null
      }
      await transfers.dispose()
      await transport.dispose()
      subscribers.clear()
    }
  }
}
