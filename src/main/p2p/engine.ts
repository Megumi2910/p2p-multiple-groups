import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  makeGroupKey,
  validateDisplayName,
  validateJoinGroupOptions,
  type ActionResult,
  type ConnectOptions,
  type GroupInvitation,
  type GroupKey,
  type JoinGroupOptions,
  type MultiGroupLibraryFile,
  type MultiGroupNetworkState,
  type MultiGroupP2pState,
  type MultiGroupRosterMember,
  type MultiGroupSearchResult,
  type MultiGroupTransfer,
  type P2pCandidatePath,
  type P2pErrorCode,
  type P2pGroupCatalogState,
  type P2pGroupState,
  type P2pLinkState,
  type P2pNetworkState,
  type P2pNetworkStatus,
  type P2pRecoveryEvent,
  type P2pRole,
  type P2pRosterMember,
  type P2pSearchResult,
  type P2pState,
  type P2pTransfer
} from '../../shared/p2p.ts'
import {
  isServerSignalingMessageV2,
  MAX_CATALOG_BATCH_ENTRIES,
  MAX_SEARCH_QUERY_LENGTH,
  type GroupJoinedMessage,
  type OverlayCatalogAckMessageV2,
  type OverlayCatalogBatchMessageV2,
  type OverlayCatalogBeginMessageV2,
  type OverlayCatalogEndMessageV2,
  type OverlayControlMessage,
  type OverlayControlMessageV2,
  type OverlaySearchMessageV2,
  type ServerSignalingMessageV2,
  type SignalingIceConfig,
  type SignalingRosterPeerV2
} from '../../shared/p2p-wire.ts'
import { LibraryManager } from './library.ts'
import { SupernodeIndexManager, SearchResultsTracker } from './search-index.ts'
import { TransferManager, type TransferAuthorizationContext } from './transfers.ts'
import { createCredentialStore } from './credential-store.ts'
import {
  createMultiGroupPeerStore,
  type MultiGroupPeerStore,
  type PersistedGroupV2
} from './peer-store.ts'
import { TransportManager, type TransportEvents } from './transport.ts'
import { SignalingClient } from './signaling-client.ts'
import {
  calculatePeerRole,
  electSupernodes,
  RecoveryEventRingBuffer,
  selectSupernodesForPeer
} from './election.ts'

export interface CreatePeerEngineOptions {
  dataDirectory: string
  transportFactory?: (signalingUrl: string, events: TransportEvents) => TransportManager
}

export interface PeerEngine {
  getState(): MultiGroupP2pState & P2pState
  subscribe(listener: (state: MultiGroupP2pState & P2pState) => void): () => void
  joinGroup(options: JoinGroupOptions): Promise<ActionResult>
  resumeGroup(groupKey: GroupKey): Promise<ActionResult>
  leaveGroup(groupKey: GroupKey): Promise<ActionResult>
  setGroupAutoJoin(groupKey: GroupKey, autoJoin: boolean): Promise<ActionResult>
  forgetGroup(groupKey: GroupKey): Promise<ActionResult>
  disconnectAll(): Promise<ActionResult>
  setSupernodeEligible(groupKey: GroupKey, eligible: boolean): Promise<ActionResult>
  setRelayOnly(relayOnly: boolean): Promise<ActionResult>
  addFiles(groupKey: GroupKey | null, paths: readonly string[]): Promise<ActionResult>
  rescanLibrary(): Promise<ActionResult>
  removeFile(fileId: string): Promise<ActionResult>
  setFileGroups(fileId: string, groupKeys: GroupKey[]): Promise<ActionResult>
  search(groupKey: GroupKey, queryText: string): Promise<ActionResult>
  download(groupKey: GroupKey, resultId: string, destination: string): Promise<ActionResult>
  cancelTransfer(transferId: string): Promise<ActionResult>
  resolveSearchResult(groupKey: GroupKey, resultId: string): MultiGroupSearchResult | undefined
  getAuthorizedFile(fileId: string): Promise<{ path: string; size: number; sha256: string }>
  dispose(): Promise<void>

  // Backward compatibility signatures for existing tests and fixtures
  connect(options: ConnectOptions): Promise<void>
  disconnect(): Promise<void>
  setSupernodeEligible(eligible: boolean): Promise<void>
  addFiles(paths: readonly string[]): Promise<void>
  search(query: string): Promise<void>
  download(resultId: string, destination: string): Promise<void>
  resolveSearchResult(resultId: string): P2pSearchResult | undefined
}

interface GroupRuntime {
  groupKey: GroupKey
  groupId: string
  signalingUrl: string
  autoJoin: boolean
  supernodeEligible: boolean
  credentialStatus: 'memory' | 'stored' | 'required'

  status: P2pNetworkStatus
  role: P2pRole
  epoch: string | null
  membershipRevision: number
  membershipId: string | null
  primaryPeerId: string | null
  standbyPeerId: string | null
  message: string | null
  members: MultiGroupRosterMember[]
  activeElectedSupernodes: string[]
  lossDetectedTimestamp: number | null

  supernodeIndex: SupernodeIndexManager
  searchResults: SearchResultsTracker
  recoveryRing: RecoveryEventRingBuffer

  searchQueryId: string | null
  searchQueryText: string
  searchStatus: 'idle' | 'searching' | 'complete' | 'partial' | 'error'
  searchMessage: string | null
  searchTimeoutTimer?: NodeJS.Timeout

  advertisedGeneration: number
  acknowledgedGeneration: number | null
  lastRosterRenewedAt: number
  isJoined: boolean
}

export async function createPeerEngine(
  optsOrDir: string | CreatePeerEngineOptions
): Promise<PeerEngine> {
  const options: CreatePeerEngineOptions =
    typeof optsOrDir === 'string' ? { dataDirectory: optsOrDir } : optsOrDir

  const store: MultiGroupPeerStore = await createMultiGroupPeerStore(options.dataDirectory)
  const persisted = store.get()

  const library = new LibraryManager()
  let isDisposed = false
  let stateRevision = 1
  let relayOnly = persisted.relayOnly

  const subscribers = new Set<(state: MultiGroupP2pState & P2pState) => void>()
  const groups = new Map<GroupKey, GroupRuntime>()
  const memoryCredentials = new Map<GroupKey, string>()

  const endpointClients = new Map<string, SignalingClient>()
  const endpointTransports = new Map<string, TransportManager>()

  // Load stored shared files into library
  await library.loadStoredFiles(persisted.sharedFiles.map((f) => ({ fileId: f.fileId, path: f.path, groupKeys: f.groupKeys })))

  const isTransferAuthorized = (context: TransferAuthorizationContext): boolean => {
    if (!context.groupKey) {
      return true
    }
    const runtime = groups.get(context.groupKey)
    if (!runtime || !runtime.isJoined) return false
    if (context.epoch && runtime.epoch && runtime.epoch !== context.epoch) return false

    if (context.direction === 'upload') {
      if (context.ownerMembershipId && runtime.membershipId && context.ownerMembershipId !== runtime.membershipId) {
        return false
      }
      if (context.requesterPeerId) {
        const isMember = runtime.members.some(
          (m) =>
            m.peerId === context.requesterPeerId &&
            (!context.requesterMembershipId || m.membershipId === context.requesterMembershipId)
        )
        if (!isMember) return false
      }
      const sf = store.get().sharedFiles.find((f) => f.fileId === context.fileId)
      if (!sf || !sf.groupKeys.includes(context.groupKey)) {
        return false
      }
      return true
    } else {
      if (context.requesterMembershipId && runtime.membershipId && context.requesterMembershipId !== runtime.membershipId) {
        return false
      }
      if (context.ownerPeerId) {
        const isMember = runtime.members.some(
          (m) =>
            m.peerId === context.ownerPeerId &&
            (!context.ownerMembershipId || m.membershipId === context.ownerMembershipId)
        )
        if (!isMember) return false
      }
      return true
    }
  }

  const transfers = new TransferManager({
    onStateChange: () => publishState(),
    isAuthorized: (context) => isTransferAuthorized(context),
    getAuthorizedFile: async (context) => {
      if (!isTransferAuthorized(context)) {
        throw new Error('NOT_FOUND')
      }
      return library.getAuthorizedFile(context.groupKey, context.fileId)
    },
    getPeerPath: (peerId) => {
      for (const t of endpointTransports.values()) {
        const link = t.getLinkState(peerId)
        if (link) return link.path
      }
      return 'unknown'
    }
  })
  const credentialStore = createCredentialStore({ dataDirectory: options.dataDirectory })

  // Initialize group runtimes from persisted store and load remembered credentials
  for (const g of persisted.groups) {
    const token = await credentialStore.getCredential(g.groupKey)
    if (token) {
      memoryCredentials.set(g.groupKey, token)
      createGroupRuntime(g.groupKey, g.groupId, g.signalingUrl, g.supernodeEligible, g.autoJoin, 'stored')
      if (g.autoJoin) {
        queueMicrotask(() => {
          void engineInstance.resumeGroup(g.groupKey)
        })
      }
    } else {
      createGroupRuntime(g.groupKey, g.groupId, g.signalingUrl, g.supernodeEligible, g.autoJoin, 'required')
    }
  }
  function createGroupRuntime(
    groupKey: GroupKey,
    groupId: string,
    signalingUrl: string,
    supernodeEligible: boolean,
    autoJoin: boolean,
    credentialStatus: 'memory' | 'stored' | 'required'
  ): GroupRuntime {
    const existing = groups.get(groupKey)
    if (existing) return existing

    const runtime: GroupRuntime = {
      groupKey,
      groupId,
      signalingUrl,
      autoJoin,
      supernodeEligible,
      credentialStatus,
      status: 'disconnected',
      role: 'ordinary',
      epoch: null,
      membershipRevision: 0,
      membershipId: null,
      primaryPeerId: null,
      standbyPeerId: null,
      message: 'Not connected',
      members: [],
      activeElectedSupernodes: [],
      lossDetectedTimestamp: null,
      supernodeIndex: new SupernodeIndexManager(),
      searchResults: new SearchResultsTracker(),
      recoveryRing: new RecoveryEventRingBuffer(100),
      searchQueryId: null,
      searchQueryText: '',
      searchStatus: 'idle',
      searchMessage: null,
      advertisedGeneration: 1,
      acknowledgedGeneration: null,
      lastRosterRenewedAt: 0,
      isJoined: false
    }

    groups.set(groupKey, runtime)
    return runtime
  }

  function publishState(): void {
    stateRevision++
    const snapshot = buildCombinedSnapshot()
    for (const listener of subscribers) {
      try {
        listener(snapshot)
      } catch {
        // ignore subscriber errors
      }
    }
  }

  let announcePending = false
  function scheduleAnnounceAll(): void {
    if (isDisposed) return
    if (announcePending) return
    announcePending = true
    queueMicrotask(() => {
      announcePending = false
      if (isDisposed) return
      for (const runtime of groups.values()) {
        if (runtime.isJoined) {
          announceCatalogue(runtime)
        }
      }
    })
  }

  library.subscribe(() => {
    publishState()
  })

  library.subscribeMetadata(() => {
    scheduleAnnounceAll()
  })

  function getOrCreateEndpoint(signalingUrl: string): { client: SignalingClient; transport: TransportManager } {
    let client = endpointClients.get(signalingUrl)
    let transport = endpointTransports.get(signalingUrl)

    if (client && transport) {
      return { client, transport }
    }

    const currentIdentity = store.get()

    const transportEvents: TransportEvents = {
      onControlMessage: (fromPeerId, msg) => {
        handleControlMessage(signalingUrl, fromPeerId, msg)
      },
      onFileChannel: (groupId, fromPeerId, fromSessionId, transferId, channel) => {
        const key = makeGroupKey(signalingUrl, groupId)
        const runtime = groups.get(key)
        const channelGroupContext = runtime
          ? {
              groupKey: key,
              groupId,
              epoch: runtime.epoch || '',
              localMembershipId: runtime.membershipId || '',
              remoteSessionId: fromSessionId,
              remoteMembershipId: runtime.members.find((m) => m.peerId === fromPeerId)?.membershipId || ''
            }
          : undefined
        void transfers.handleIncomingChannel(fromPeerId, transferId, channel, channelGroupContext)
      },
      onLinkStateChange: (peerId, state, path) => {
        handleLinkStateChange(signalingUrl, peerId, state, path)
      },
      onSendSignal: (sig) => {
        const c = endpointClients.get(signalingUrl)
        if (c && sig.groupId) {
          c.sendSignal({
            groupId: sig.groupId,
            targetPeerId: sig.targetPeerId,
            targetSessionId: sig.targetSessionId,
            connectionId: sig.connectionId,
            kind: sig.kind,
            payload: sig.payload
          })
        }
      }
    }

    if (!transport) {
      transport = options.transportFactory
        ? options.transportFactory(signalingUrl, transportEvents)
        : new TransportManager(transportEvents)
      endpointTransports.set(signalingUrl, transport)
    }

    if (!client) {
      client = new SignalingClient({
        signalingUrl,
        peerId: currentIdentity.peerId,
        displayName: currentIdentity.displayName,
        callbacks: {
          onGroupJoined: (msg) => {
            handleGroupJoined(signalingUrl, msg)
          },
          onRoster: (groupId, epoch, revision, peers) => {
            handleRosterUpdate(signalingUrl, groupId, epoch, revision, peers)
          },
          onGroupLeft: (groupId) => {
            handleGroupLeft(signalingUrl, groupId)
          },
          onSignal: (msg) => {
            const t = endpointTransports.get(signalingUrl)
            if (t) {
              void t.handleSignal(msg.groupId, msg.fromPeerId, msg.fromSessionId, msg.connectionId, msg.kind, msg.payload)
            }
          },
          onIceConfig: (iceConfig) => {
            const t = endpointTransports.get(signalingUrl)
            if (t && client) {
              t.setPeerContext(store.get().peerId, client.getSessionId() || '', iceConfig, relayOnly)
            }
          },
          onError: (groupId, code, message) => {
            if (groupId) {
              const key = makeGroupKey(signalingUrl, groupId)
              const runtime = groups.get(key)
              if (runtime) {
                runtime.status = code === 'AUTH_FAILED' ? 'error' : 'error'
                runtime.message = `${code}: ${message}`
                publishState()
              }
            }
          },
          onStatusChange: (status, message) => {
            if (status === 'disconnected' || status === 'error') {
              for (const runtime of groups.values()) {
                if (runtime.signalingUrl === signalingUrl && runtime.isJoined) {
                  runtime.status = status
                  runtime.message = message
                }
              }
              publishState()
            }
          }
        }
      })
      endpointClients.set(signalingUrl, client)
    }

    return { client, transport }
  }

  function handleGroupJoined(signalingUrl: string, msg: GroupJoinedMessage): void {
    const key = makeGroupKey(signalingUrl, msg.groupId)
    const runtime = groups.get(key)
    if (!runtime) return

    runtime.membershipId = msg.membershipId
    runtime.epoch = msg.epoch
    runtime.membershipRevision = msg.revision
    runtime.isJoined = true
    runtime.status = 'connected'
    runtime.lastRosterRenewedAt = Date.now()

    handleRosterUpdate(signalingUrl, msg.groupId, msg.epoch, msg.revision, msg.peers)
    announceCatalogue(runtime)
  }

  function handleRosterUpdate(
    signalingUrl: string,
    groupId: string,
    epoch: string,
    revision: number,
    peers: SignalingRosterPeerV2[]
  ): void {
    const key = makeGroupKey(signalingUrl, groupId)
    const runtime = groups.get(key)
    if (!runtime) return

    runtime.lastRosterRenewedAt = Date.now()

    // Stale revision check in same epoch
    if (runtime.epoch === epoch && revision < runtime.membershipRevision) {
      return
    }

    // Changing epoch resets authorities
    if (runtime.epoch !== epoch) {
      runtime.epoch = epoch
      runtime.supernodeIndex.clear()
      runtime.searchResults.clear()
      runtime.acknowledgedGeneration = null
    }

    runtime.membershipRevision = revision

    // Election deterministically by joinOrder then peerId
    const election = electSupernodes(peers)
    runtime.activeElectedSupernodes = election.electedSupernodes.map((s) => s.peerId)
    const newRole = calculatePeerRole(store.get().peerId, election.electedSupernodes)
    const prevRole = runtime.role
    runtime.role = newRole

    if (prevRole !== newRole) {
      runtime.recoveryRing.add(
        'role-changed',
        runtime.activeElectedSupernodes,
        epoch,
        revision,
        null,
        `Role changed from ${prevRole} to ${newRole}`
      )
    }

    const prevPrimary = runtime.primaryPeerId
    if (newRole === 'ordinary') {
      const selected = selectSupernodesForPeer(store.get().peerId, election.electedSupernodes)
      runtime.primaryPeerId = selected.primary ? selected.primary.peerId : null
      runtime.standbyPeerId = selected.standby ? selected.standby.peerId : null
    } else {
      runtime.primaryPeerId = null
      runtime.standbyPeerId = null
    }

    if (runtime.primaryPeerId !== prevPrimary && runtime.primaryPeerId !== null) {
      let durationMs: number | null = null
      if (runtime.lossDetectedTimestamp !== null) {
        durationMs = Math.round(performance.now() - runtime.lossDetectedTimestamp)
        runtime.lossDetectedTimestamp = null
      }
      runtime.recoveryRing.add(
        'route-changed',
        runtime.primaryPeerId ? [runtime.primaryPeerId] : [],
        epoch,
        revision,
        durationMs,
        `Primary serving route updated to ${runtime.primaryPeerId}`
      )
    }

    // Clean up departed members from index
    const activeIds = new Set(peers.map((p) => p.peerId))
    for (const member of runtime.members) {
      if (!activeIds.has(member.peerId)) {
        runtime.supernodeIndex.removeOwner(member.peerId)
      }
    }

    // Update roster members
    runtime.members = peers.map((p) => ({
      peerId: p.peerId,
      sessionId: p.sessionId,
      membershipId: p.membershipId,
      joinOrder: p.joinOrder,
      displayName: p.displayName,
      supernodeEligible: p.supernodeEligible,
      role: calculatePeerRole(p.peerId, election.electedSupernodes)
    }))

    if (election.electedSupernodes.length === 0) {
      runtime.message = 'No eligible supernode available in network.'
    } else if (newRole === 'supernode') {
      runtime.message = `Operating as active supernode (${election.electedSupernodes.length} total).`
    } else {
      runtime.message = `Connected to supernode ${runtime.primaryPeerId || 'none'}.`
    }

    // Update transport group context
    const transport = endpointTransports.get(signalingUrl)
    if (transport) {
      transport.updateGroupContext(groupId, epoch, revision, peers, true)
    }

    announceCatalogue(runtime)
    publishState()
  }

  function handleGroupLeft(signalingUrl: string, groupId: string): void {
    const key = makeGroupKey(signalingUrl, groupId)
    const runtime = groups.get(key)
    if (!runtime) return

    runtime.isJoined = false
    runtime.status = 'disconnected'
    runtime.message = 'Left group'
    runtime.members = []
    runtime.supernodeIndex.clear()
    runtime.searchResults.clear()
    runtime.acknowledgedGeneration = null

    const transport = endpointTransports.get(signalingUrl)
    if (transport) {
      transport.removeGroupContext(groupId)
    }

    publishState()
  }

  function handleControlMessage(
    signalingUrl: string,
    fromPeerId: string,
    msg: OverlayControlMessageV2 | OverlayControlMessage
  ): void {
    if ('v' in msg && msg.v === 2) {
      const v2 = msg as OverlayControlMessageV2
      if (v2.type === 'hello') return

      const key = makeGroupKey(signalingUrl, v2.groupId)
      const runtime = groups.get(key)
      if (!runtime || !runtime.isJoined) return
      switch (v2.type) {
        case 'ping': {
          const pong: OverlayControlMessageV2 = {
            v: 2,
            type: 'pong',
            groupId: v2.groupId,
            epoch: v2.epoch,
            revision: v2.revision,
            senderMembershipId: runtime.membershipId || ''
          }
          const transport = endpointTransports.get(signalingUrl)
          transport?.sendControl(v2.groupId, fromPeerId, pong)
          break
        }

        case 'pong': {
          break
        }

        case 'catalog-begin': {
          if (runtime.role === 'supernode') {
            const senderSession = v2.senderMembershipId || runtime.members.find((m) => m.peerId === fromPeerId)?.sessionId || fromPeerId
            const instantAck = runtime.supernodeIndex.handleCatalogBegin(fromPeerId, senderSession, v2 as any, v2.senderMembershipId)
            if (instantAck) {
              const ack: OverlayCatalogAckMessageV2 = {
                v: 2,
                type: 'catalog-ack',
                groupId: v2.groupId,
                epoch: runtime.epoch || '',
                revision: runtime.membershipRevision,
                senderMembershipId: runtime.membershipId || '',
                generation: v2.generation
              }
              const transport = endpointTransports.get(signalingUrl)
              const sent = transport?.sendControl(v2.groupId, fromPeerId, ack)
              if (!sent) {
                let retryTimer: NodeJS.Timeout | null = null
                let clearTimer: NodeJS.Timeout | null = null
                const cleanup = () => {
                  if (retryTimer) { clearInterval(retryTimer); retryTimer = null }
                  if (clearTimer) { clearTimeout(clearTimer); clearTimer = null }
                }
                retryTimer = setInterval(() => {
                  if (isDisposed) { cleanup(); return }
                  const t = endpointTransports.get(signalingUrl)
                  if (t?.getLinkState(fromPeerId)?.state === 'open') {
                    if (t.sendControl(v2.groupId, fromPeerId, ack)) cleanup()
                  }
                }, 40)
                clearTimer = setTimeout(cleanup, 3000)
              }
            }
          }
          break
        }

        case 'catalog-batch': {
          if (runtime.role === 'supernode') {
            const senderSession = v2.senderMembershipId || runtime.members.find((m) => m.peerId === fromPeerId)?.sessionId || fromPeerId
            runtime.supernodeIndex.handleCatalogBatch(fromPeerId, senderSession, v2 as any)
          }
          break
        }

        case 'catalog-end': {
          if (runtime.role === 'supernode') {
            const senderSession = v2.senderMembershipId || runtime.members.find((m) => m.peerId === fromPeerId)?.sessionId || fromPeerId
            const swapped = runtime.supernodeIndex.handleCatalogEnd(fromPeerId, senderSession, v2 as any, v2.senderMembershipId)
            if (swapped) {
              const ack: OverlayCatalogAckMessageV2 = {
                v: 2,
                type: 'catalog-ack',
                groupId: v2.groupId,
                epoch: runtime.epoch || '',
                revision: runtime.membershipRevision,
                senderMembershipId: runtime.membershipId || '',
                generation: v2.generation
              }
              const transport = endpointTransports.get(signalingUrl)
              const sent = transport?.sendControl(v2.groupId, fromPeerId, ack)
              if (!sent) {
                let retryTimer: NodeJS.Timeout | null = null
                let clearTimer: NodeJS.Timeout | null = null
                const cleanup = () => {
                  if (retryTimer) { clearInterval(retryTimer); retryTimer = null }
                  if (clearTimer) { clearTimeout(clearTimer); clearTimer = null }
                }
                retryTimer = setInterval(() => {
                  if (isDisposed) { cleanup(); return }
                  const t = endpointTransports.get(signalingUrl)
                  if (t?.getLinkState(fromPeerId)?.state === 'open') {
                    if (t.sendControl(v2.groupId, fromPeerId, ack)) cleanup()
                  }
                }, 40)
                clearTimer = setTimeout(cleanup, 3000)
              }
            }
          }
          break
        }

        case 'catalog-ack': {
          if (v2.generation <= runtime.advertisedGeneration) {
            const curAck = runtime.acknowledgedGeneration ?? 0
            if (v2.generation >= curAck) {
              runtime.acknowledgedGeneration = v2.generation
              library.setAcknowledgedGeneration(v2.generation)
              runtime.recoveryRing.add(
                'index-ready',
                [fromPeerId],
                runtime.epoch,
                runtime.membershipRevision,
                null,
                'Catalogue indexed and acknowledged by supernode'
              )
              publishState()
            }
          }
          break
        }

        case 'search': {
          if (runtime.role === 'supernode') {
            const res = runtime.supernodeIndex.search(v2.query, fromPeerId, v2.queryId)
            const batches = runtime.supernodeIndex.splitResultBatches(res.entries)
            const otherSupernode = runtime.activeElectedSupernodes.find(
              (id) => id !== store.get().peerId && id !== fromPeerId
            )
            const hasForward = v2.ttl > 0 && Boolean(otherSupernode)
            const transport = endpointTransports.get(signalingUrl)
            if (batches.length === 0) {
              transport?.sendControl(v2.groupId, fromPeerId, {
                v: 2,
                type: 'search-results',
                groupId: v2.groupId,
                epoch: runtime.epoch || '',
                revision: runtime.membershipRevision,
                senderMembershipId: runtime.membershipId || '',
                responderPeerId: store.get().peerId,
                responderMembershipId: runtime.membershipId || '',
                queryId: v2.queryId,
                originPeerId: fromPeerId,
                originMembershipId: v2.senderMembershipId,
                entries: [],
                done: !hasForward,
                partial: false
              })
            } else {
              batches.forEach((batch, idx) => {
                transport?.sendControl(v2.groupId, fromPeerId, {
                  v: 2,
                  type: 'search-results',
                  groupId: v2.groupId,
                  epoch: runtime.epoch || '',
                  revision: runtime.membershipRevision,
                  senderMembershipId: runtime.membershipId || '',
                  responderPeerId: store.get().peerId,
                  responderMembershipId: runtime.membershipId || '',
                  queryId: v2.queryId,
                  originPeerId: fromPeerId,
                  originMembershipId: v2.senderMembershipId,
                  entries: batch.map((b) => ({
                    ownerPeerId: b.ownerPeerId,
                    ownerSessionId: b.ownerSessionId,
                    ownerMembershipId: (b as any).ownerMembershipId || '',
                    file: b.file
                  })),
                  done: idx === batches.length - 1 && !hasForward,
                  partial: false
                })
              })
            }

            if (v2.ttl > 0 && otherSupernode) {
              transport?.sendControl(v2.groupId, otherSupernode, {
                v: 2,
                type: 'search-forward',
                groupId: v2.groupId,
                epoch: runtime.epoch || '',
                revision: runtime.membershipRevision,
                senderMembershipId: runtime.membershipId || '',
                queryId: v2.queryId,
                query: v2.query,
                originPeerId: fromPeerId,
                originMembershipId: v2.senderMembershipId,
                ttl: 0
              })
            }
          }
          break
        }

        case 'search-forward': {
          if (runtime.role === 'supernode') {
            const res = runtime.supernodeIndex.search(v2.query, v2.originPeerId, v2.queryId)
            const batches = runtime.supernodeIndex.splitResultBatches(res.entries)
            const transport = endpointTransports.get(signalingUrl)
            const target = transport?.getLinkState(v2.originPeerId)?.state === 'open' ? v2.originPeerId : fromPeerId

            if (batches.length === 0) {
              transport?.sendControl(v2.groupId, target, {
                v: 2,
                type: 'search-results',
                groupId: v2.groupId,
                epoch: runtime.epoch || '',
                revision: runtime.membershipRevision,
                senderMembershipId: runtime.membershipId || '',
                responderPeerId: store.get().peerId,
                responderMembershipId: runtime.membershipId || '',
                queryId: v2.queryId,
                originPeerId: v2.originPeerId,
                originMembershipId: v2.originMembershipId,
                entries: [],
                done: true,
                partial: false
              })
            } else {
              batches.forEach((batch, idx) => {
                transport?.sendControl(v2.groupId, target, {
                  v: 2,
                  type: 'search-results',
                  groupId: v2.groupId,
                  epoch: runtime.epoch || '',
                  revision: runtime.membershipRevision,
                  senderMembershipId: runtime.membershipId || '',
                  responderPeerId: store.get().peerId,
                  responderMembershipId: runtime.membershipId || '',
                  queryId: v2.queryId,
                  originPeerId: v2.originPeerId,
                  originMembershipId: v2.originMembershipId,
                  entries: batch.map((b) => ({
                    ownerPeerId: b.ownerPeerId,
                    ownerSessionId: b.ownerSessionId,
                    ownerMembershipId: (b as any).ownerMembershipId || '',
                    file: b.file
                  })),
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
          if (v2.originPeerId === myPeerId) {
            if (v2.queryId === runtime.searchQueryId) {
              runtime.searchResults.addBatch(v2.queryId, v2.entries as any, (id) => {
                const member = runtime.members.find((m) => m.peerId === id)
                return member ? member.displayName : `Peer-${id.slice(0, 6)}`
              })
              if (v2.done) {
                runtime.searchStatus = 'complete'
                if (runtime.searchTimeoutTimer) {
                  clearTimeout(runtime.searchTimeoutTimer)
                  runtime.searchTimeoutTimer = undefined
                }
              }
              publishState()
            }
          } else if (runtime.role === 'supernode') {
            const transport = endpointTransports.get(signalingUrl)
            transport?.sendControl(v2.groupId, v2.originPeerId, v2)
          }
          break
        }
      }
    }
  }

  function handleLinkStateChange(
    signalingUrl: string,
    peerId: string,
    state: P2pLinkState,
    _path: P2pCandidatePath
  ): void {
    if (state === 'open') {
      for (const runtime of groups.values()) {
        if (runtime.signalingUrl === signalingUrl && runtime.isJoined) {
          if (peerId === runtime.primaryPeerId) {
            announceCatalogue(runtime)
          }
        }
      }
    }
    publishState()
  }

  function announceCatalogue(runtime: GroupRuntime): void {
    if (isDisposed || !runtime.isJoined) return

    // Filter library metadata by committed v2 grants for this groupKey
    const committedFiles = store.get().sharedFiles
    const groupGrantedFileIds = new Set(
      committedFiles
        .filter((f) => f.groupKeys.includes(runtime.groupKey))
        .map((f) => f.fileId)
    )

    const allMetadata = library.getSharedMetadata()
    const groupMetadata = allMetadata.filter((m) => groupGrantedFileIds.has(m.fileId))

    const gen = library.getGeneration()
    runtime.advertisedGeneration = gen
    if (runtime.acknowledgedGeneration !== gen) {
      runtime.acknowledgedGeneration = null
    }
    if (runtime.role === 'supernode') {
      runtime.supernodeIndex.updateLocalCatalogue(
        store.get().peerId,
        runtime.membershipId || '',
        gen,
        groupMetadata
      )
      runtime.acknowledgedGeneration = gen
      library.setAcknowledgedGeneration(gen)
      publishState()
      return
    }

    if (runtime.role === 'ordinary' && runtime.primaryPeerId && runtime.epoch) {
      const targetId = runtime.primaryPeerId
      const transport = endpointTransports.get(runtime.signalingUrl)
      if (!transport) return

      const batches: (typeof groupMetadata)[] = []
      for (let i = 0; i < groupMetadata.length; i += MAX_CATALOG_BATCH_ENTRIES) {
        batches.push(groupMetadata.slice(i, i + MAX_CATALOG_BATCH_ENTRIES))
      }

      const sendBatches = () => {
        const begin: OverlayCatalogBeginMessageV2 = {
          v: 2,
          type: 'catalog-begin',
          groupId: runtime.groupId,
          epoch: runtime.epoch!,
          revision: runtime.membershipRevision,
          senderMembershipId: runtime.membershipId || '',
          generation: gen,
          count: groupMetadata.length
        }
        transport.sendControl(runtime.groupId, targetId, begin)

        for (const batch of batches) {
          const batchMsg: OverlayCatalogBatchMessageV2 = {
            v: 2,
            type: 'catalog-batch',
            groupId: runtime.groupId,
            epoch: runtime.epoch!,
            revision: runtime.membershipRevision,
            senderMembershipId: runtime.membershipId || '',
            generation: gen,
            entries: batch
          }
          transport.sendControl(runtime.groupId, targetId, batchMsg)
        }

        const end: OverlayCatalogEndMessageV2 = {
          v: 2,
          type: 'catalog-end',
          groupId: runtime.groupId,
          epoch: runtime.epoch!,
          revision: runtime.membershipRevision,
          senderMembershipId: runtime.membershipId || '',
          generation: gen
        }
        transport.sendControl(runtime.groupId, targetId, end)
      }

      if (transport.getLinkState(targetId)?.state === 'open') {
        sendBatches()
      }
    }
  }

  // Heartbeat & freshness monitor (every 2 seconds)
  const monitorTimer = setInterval(() => {
    if (isDisposed) return
    const now = Date.now()

    for (const runtime of groups.values()) {
      if (runtime.isJoined) {
        // Freshness: expires after 6s without authoritative renewal
        if (runtime.lastRosterRenewedAt > 0 && now - runtime.lastRosterRenewedAt > 6000) {
          runtime.status = 'recovering'
          runtime.message = 'Roster freshness expired'
          publishState()
        }
      }
    }
  }, 2000)

  function buildCombinedSnapshot(): MultiGroupP2pState & P2pState {
    const persistedState = store.get()
    const activeGroupList: P2pGroupState[] = []

    for (const runtime of groups.values()) {
      const groupLinks = endpointTransports.get(runtime.signalingUrl)?.getGroupLinks(runtime.groupId) || []
      const netState: MultiGroupNetworkState = {
        status: runtime.status,
        peerId: persistedState.peerId,
        sessionId: endpointClients.get(runtime.signalingUrl)?.getSessionId() || null,
        membershipId: runtime.membershipId,
        displayName: persistedState.displayName,
        supernodeEligible: runtime.supernodeEligible,
        signalingUrl: runtime.signalingUrl,
        groupId: runtime.groupId,
        role: runtime.role,
        epoch: runtime.epoch,
        membershipRevision: runtime.membershipRevision,
        primaryPeerId: runtime.primaryPeerId,
        standbyPeerId: runtime.standbyPeerId,
        members: [...runtime.members],
        links: groupLinks,
        message: runtime.message
      }

      const catState: P2pGroupCatalogState = {
        advertisedGeneration: runtime.advertisedGeneration,
        acknowledgedGeneration: runtime.acknowledgedGeneration
      }

      activeGroupList.push({
        groupKey: runtime.groupKey,
        groupId: runtime.groupId,
        signalingUrl: runtime.signalingUrl,
        autoJoin: runtime.autoJoin,
        credentialStatus: runtime.credentialStatus,
        network: netState,
        catalog: catState,
        search: {
          queryId: runtime.searchQueryId,
          query: runtime.searchQueryText,
          status: runtime.searchStatus,
          results: runtime.searchResults.getResults() as unknown as P2pSearchResult[],
          message: runtime.searchMessage
        },
        recoveryEvents: runtime.recoveryRing.getAll()
      })
    }

    // Map library files to MultiGroupLibraryFile
    const libState = library.getState()
    const multiGroupFiles: MultiGroupLibraryFile[] = libState.files.map((f) => {
      const persistedFile = persistedState.sharedFiles.find((sf) => sf.fileId === f.fileId)
      return {
        ...f,
        groupKeys: persistedFile ? [...persistedFile.groupKeys] : []
      }
    })

    // Active transfers
    const transferList: MultiGroupTransfer[] = transfers.getTransfers().map((t) => ({
      id: t.id,
      groupKey: '',
      groupId: '',
      direction: t.direction,
      fileName: t.fileName,
      peerId: t.peerId,
      peerName: t.peerName,
      size: t.size,
      transferredBytes: t.transferredBytes,
      sha256: t.sha256,
      state: t.state,
      path: t.path,
      message: t.message
    }))

    // Legacy projection for untouched components / tests
    const firstGroup = activeGroupList[0]
    const legacyNet: P2pNetworkState = firstGroup
      ? {
          status: firstGroup.network.status,
          peerId: firstGroup.network.peerId,
          sessionId: firstGroup.network.sessionId,
          displayName: firstGroup.network.displayName,
          supernodeEligible: firstGroup.network.supernodeEligible,
          signalingUrl: firstGroup.network.signalingUrl,
          roomId: firstGroup.network.groupId,
          role: firstGroup.network.role,
          epoch: firstGroup.network.epoch,
          membershipRevision: firstGroup.network.membershipRevision,
          primaryPeerId: firstGroup.network.primaryPeerId,
          standbyPeerId: firstGroup.network.standbyPeerId,
          members: firstGroup.network.members.map((m) => ({
            peerId: m.peerId,
            sessionId: m.sessionId,
            joinOrder: m.joinOrder,
            displayName: m.displayName,
            supernodeEligible: m.supernodeEligible,
            role: m.role
          })),
          links: firstGroup.network.links,
          message: firstGroup.network.message
        }
      : {
          status: 'disconnected',
          peerId: persistedState.peerId,
          sessionId: null,
          displayName: persistedState.displayName,
          supernodeEligible: true,
          signalingUrl: '',
          roomId: '',
          role: 'ordinary',
          epoch: null,
          membershipRevision: 0,
          primaryPeerId: null,
          standbyPeerId: null,
          members: [],
          links: [],
          message: 'Disconnected'
        }

    return {
      revision: stateRevision,
      identity: {
        peerId: persistedState.peerId,
        displayName: persistedState.displayName
      },
      relayOnly,
      groups: activeGroupList,
      library: {
        status: libState.status,
        files: multiGroupFiles,
        advertisedGeneration: firstGroup ? firstGroup.catalog.advertisedGeneration : libState.advertisedGeneration,
        acknowledgedGeneration: firstGroup ? firstGroup.catalog.acknowledgedGeneration : libState.acknowledgedGeneration
      },
      transfers: transferList,
      // Legacy P2pState fields
      network: legacyNet,
      search: firstGroup ? firstGroup.search : {
        queryId: null,
        query: '',
        status: 'idle',
        results: [],
        message: null
      },
      recoveryEvents: firstGroup ? firstGroup.recoveryEvents : []
    }
  }
  const engineInstance = {
    getState: () => buildCombinedSnapshot(),

    subscribe: (listener: (state: MultiGroupP2pState & P2pState) => void) => {
      subscribers.add(listener)
      return () => {
        subscribers.delete(listener)
      }
    },

    joinGroup: async (options: JoinGroupOptions): Promise<ActionResult> => {
      const check = validateJoinGroupOptions(options)
      if (!check.valid) {
        return { ok: false, code: 'INVALID_INPUT', message: check.error }
      }

      // Check relay policy compatibility
      const hasActive = Array.from(groups.values()).some((g) => g.isJoined)
      if (hasActive && options.relayOnly !== relayOnly) {
        return {
          ok: false,
          code: 'INVALID_INPUT',
          message: 'Changing relay policy requires disconnecting all groups first'
        }
      }

      const inv = options.invitation
      const groupKey = makeGroupKey(inv.signalingUrl, inv.groupId)
      const credStatus = options.rememberInvitation ? 'stored' : 'memory'

      memoryCredentials.set(groupKey, inv.token)

      const runtime = createGroupRuntime(
        groupKey,
        inv.groupId,
        inv.signalingUrl,
        options.supernodeEligible,
        false,
        credStatus
      )
      runtime.supernodeEligible = options.supernodeEligible

      const { client, transport } = getOrCreateEndpoint(inv.signalingUrl)
      if (options.displayName) {
        client.setDisplayName(options.displayName)
      }
      transport.setPeerContext(
        store.get().peerId,
        client.getSessionId() || '',
        { expiresAt: 0, servers: [] },
        relayOnly
      )

      try {
        await client.joinGroup(inv.groupId, inv.token, options.supernodeEligible)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, code: msg.includes('AUTH_FAILED') ? 'AUTH_FAILED' : 'IO_ERROR', message: msg }
      }

      if (options.rememberInvitation) {
        await credentialStore.setCredential(groupKey, inv.token)
        runtime.credentialStatus = 'stored'
      } else {
        runtime.credentialStatus = 'memory'
      }
      runtime.autoJoin = options.autoJoin !== false

      // Authoritatively accepted: commit to store
      try {
        await store.upsertGroup(
          {
            groupKey,
            signalingUrl: inv.signalingUrl,
            groupId: inv.groupId,
            supernodeEligible: options.supernodeEligible,
            autoJoin: runtime.autoJoin,
            credentialCiphertext: null
          },
          {
            displayName: options.displayName,
            relayOnly: options.relayOnly
          }
        )
      } catch (err) {
        // Rollback
        await client.leaveGroup(inv.groupId)
        return { ok: false, code: 'IO_ERROR', message: 'Failed to persist group membership' }
      }

      publishState()
      return { ok: true }
    },

    resumeGroup: async (groupKey: GroupKey): Promise<ActionResult> => {
      const runtime = groups.get(groupKey)
      if (!runtime) {
        return { ok: false, code: 'NOT_FOUND', message: 'Group not found' }
      }

      const token = memoryCredentials.get(groupKey)
      if (!token) {
        return { ok: false, code: 'INVITATION_REQUIRED', message: 'Invitation token required to resume group' }
      }

      const { client, transport } = getOrCreateEndpoint(runtime.signalingUrl)
      transport.setPeerContext(
        store.get().peerId,
        client.getSessionId() || '',
        { expiresAt: 0, servers: [] },
        relayOnly
      )

      try {
        await client.joinGroup(runtime.groupId, token, runtime.supernodeEligible)
        publishState()
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, code: msg.includes('AUTH_FAILED') ? 'AUTH_FAILED' : 'IO_ERROR', message: msg }
      }
    },

    leaveGroup: async (groupKey: GroupKey): Promise<ActionResult> => {
      const runtime = groups.get(groupKey)
      if (!runtime) {
        return { ok: false, code: 'NOT_FOUND', message: 'Group not found' }
      }

      const client = endpointClients.get(runtime.signalingUrl)
      if (client) {
        await client.leaveGroup(runtime.groupId)
      }

      handleGroupLeft(runtime.signalingUrl, runtime.groupId)
      await store.setGroupAutoJoin(groupKey, false)
      publishState()
      return { ok: true }
    },

    setGroupAutoJoin: async (groupKey: GroupKey, autoJoin: boolean): Promise<ActionResult> => {
      const runtime = groups.get(groupKey)
      if (runtime) {
        runtime.autoJoin = autoJoin
      }
      await store.setGroupAutoJoin(groupKey, autoJoin)
      publishState()
      return { ok: true }
    },
    forgetGroup: async (groupKey: GroupKey): Promise<ActionResult> => {
      const runtime = groups.get(groupKey)
      if (runtime) {
        const client = endpointClients.get(runtime.signalingUrl)
        if (client) {
          await client.leaveGroup(runtime.groupId)
        }
        handleGroupLeft(runtime.signalingUrl, runtime.groupId)
      }

      memoryCredentials.delete(groupKey)
      await credentialStore.deleteCredential(groupKey)
      groups.delete(groupKey)
      await store.removeGroup(groupKey)
      publishState()
      return { ok: true }
    },

    disconnectAll: async (): Promise<ActionResult> => {
      for (const runtime of groups.values()) {
        if (runtime.isJoined) {
          const client = endpointClients.get(runtime.signalingUrl)
          if (client) {
            await client.leaveGroup(runtime.groupId)
          }
          handleGroupLeft(runtime.signalingUrl, runtime.groupId)
          await store.setGroupAutoJoin(runtime.groupKey, false)
        }
      }
      publishState()
      return { ok: true }
    },

    setSupernodeEligible: async (arg1: unknown, arg2?: unknown): Promise<any> => {
      if (typeof arg1 === 'boolean') {
        // Legacy single-group call
        const eligible = arg1
        for (const runtime of groups.values()) {
          runtime.supernodeEligible = eligible
          const client = endpointClients.get(runtime.signalingUrl)
          client?.setEligibility(runtime.groupId, eligible)
          await store.setGroupEligibility(runtime.groupKey, eligible)
        }
        publishState()
        return
      }

      const groupKey = arg1 as GroupKey
      const eligible = Boolean(arg2)
      const runtime = groups.get(groupKey)
      if (!runtime) {
        return { ok: false, code: 'NOT_FOUND', message: 'Group not found' }
      }

      runtime.supernodeEligible = eligible
      const client = endpointClients.get(runtime.signalingUrl)
      client?.setEligibility(runtime.groupId, eligible)
      await store.setGroupEligibility(groupKey, eligible)
      publishState()
      return { ok: true }
    },

    setRelayOnly: async (newRelayOnly: boolean): Promise<ActionResult> => {
      const hasActive = Array.from(groups.values()).some((g) => g.isJoined)
      if (hasActive) {
        return {
          ok: false,
          code: 'INVALID_INPUT',
          message: 'Changing relay policy requires disconnecting all groups first'
        }
      }
      relayOnly = newRelayOnly
      await store.setRelayOnly(newRelayOnly)
      publishState()
      return { ok: true }
    },

    addFiles: async (arg1: unknown, arg2?: unknown): Promise<any> => {
      let groupKey: GroupKey | null
      let paths: readonly string[]

      if (Array.isArray(arg1)) {
        // Legacy single-group call
        paths = arg1 as readonly string[]
        groupKey = groups.keys().next().value || null
      } else {
        groupKey = arg1 as GroupKey | null
        paths = arg2 as readonly string[]
      }

      const added = await library.addFiles(paths)
      for (const item of added) {
        const targetKeys = groupKey ? [groupKey] : []
        const existing = store.get().sharedFiles.find((f) => f.fileId === item.fileId)
        if (existing) {
          const merged = groupKey && !existing.groupKeys.includes(groupKey)
            ? [...existing.groupKeys, groupKey]
            : existing.groupKeys
          await store.setFileGroups(item.fileId, merged)
          library.setFileGroups(item.fileId, merged)
        } else {
          try {
            await store.addSharedFile({
              fileId: item.fileId,
              path: item.path,
              groupKeys: targetKeys
            })
            library.setFileGroups(item.fileId, targetKeys)
          } catch (err) {
            library.removeFile(item.fileId)
            throw err
          }
        }
      }

      scheduleAnnounceAll()
      publishState()
      if (Array.isArray(arg1)) return
      return { ok: true }
    },

    rescanLibrary: async (): Promise<any> => {
      await library.rescan()
      scheduleAnnounceAll()
      publishState()
      return { ok: true }
    },

    removeFile: async (fileId: string): Promise<any> => {
      library.removeFile(fileId)
      await store.removeSharedFile(fileId)
      scheduleAnnounceAll()
      publishState()
      return { ok: true }
    },

    setFileGroups: async (fileId: string, groupKeys: GroupKey[]): Promise<ActionResult> => {
      await store.setFileGroups(fileId, groupKeys)
      scheduleAnnounceAll()
      publishState()
      return { ok: true }
    },

    search: async (arg1: string, arg2?: string): Promise<any> => {
      let groupKey: GroupKey
      let queryText: string

      if (arg2 !== undefined) {
        groupKey = arg1
        queryText = arg2
      } else {
        // Legacy single-group call
        groupKey = groups.keys().next().value || ''
        queryText = arg1
      }

      const trimmed = queryText.trim()
      if (trimmed.length < 1 || trimmed.length > MAX_SEARCH_QUERY_LENGTH) {
        throw new Error('Query must be 1 to 120 characters')
      }

      const runtime = groups.get(groupKey)
      if (!runtime || !runtime.isJoined) {
        throw new Error('No active group joined for search')
      }

      runtime.searchQueryText = trimmed
      runtime.searchQueryId = randomUUID()
      runtime.searchStatus = 'searching'
      runtime.searchMessage = null
      runtime.searchResults.startNewSearch(runtime.searchQueryId, trimmed)
      publishState()

      clearTimeout(runtime.searchTimeoutTimer)
      runtime.searchTimeoutTimer = setTimeout(() => {
        if (runtime.searchStatus === 'searching') {
          runtime.searchStatus = 'complete'
          publishState()
        }
      }, 8000)

      const transport = endpointTransports.get(runtime.signalingUrl)
      if (runtime.role === 'supernode') {
        const localRes = runtime.supernodeIndex.search(trimmed, store.get().peerId, runtime.searchQueryId)
        runtime.searchResults.addBatch(runtime.searchQueryId, localRes.entries as any, (id) => {
          const m = runtime.members.find((x) => x.peerId === id)
          return m ? m.displayName : `Peer-${id.slice(0, 6)}`
        })
        const otherSupernode = runtime.activeElectedSupernodes.find((id) => id !== store.get().peerId)
        if (otherSupernode) {
          transport?.sendControl(runtime.groupId, otherSupernode, {
            v: 2,
            type: 'search-forward',
            groupId: runtime.groupId,
            epoch: runtime.epoch || '',
            revision: runtime.membershipRevision,
            senderMembershipId: runtime.membershipId || '',
            queryId: runtime.searchQueryId,
            query: trimmed,
            originPeerId: store.get().peerId,
            originMembershipId: runtime.membershipId || '',
            ttl: 0
          })
        } else {
          runtime.searchStatus = 'complete'
          clearTimeout(runtime.searchTimeoutTimer)
        }
        publishState()
      } else if (runtime.role === 'ordinary' && runtime.primaryPeerId) {
        const targetId = runtime.primaryPeerId
        const queryId = runtime.searchQueryId
        transport?.sendControl(runtime.groupId, targetId, {
          v: 2,
          type: 'search',
          groupId: runtime.groupId,
          epoch: runtime.epoch || '',
          revision: runtime.membershipRevision,
          senderMembershipId: runtime.membershipId || '',
          queryId,
          query: trimmed,
          ttl: 1
        })
      } else {
        runtime.searchStatus = 'error'
        runtime.searchMessage = 'No supernode available to route search'
        publishState()
      }

      if (arg2 === undefined) return
      return { ok: true }
    },

    download: async (arg1: string, arg2: string, arg3?: string): Promise<any> => {
      let groupKey: GroupKey
      let resultId: string
      let destination: string

      if (arg3 !== undefined) {
        groupKey = arg1
        resultId = arg2
        destination = arg3
      } else {
        groupKey = groups.keys().next().value || ''
        resultId = arg1
        destination = arg2
      }

      const runtime = groups.get(groupKey)
      if (!runtime) throw new Error('NOT_FOUND')

      const result = runtime.searchResults.resolveResult(resultId)
      if (!result) throw new Error('NOT_FOUND')

      const transport = endpointTransports.get(runtime.signalingUrl)
      if (!transport) throw new Error('NOT_FOUND')

      const transferId = randomUUID()
      await transfers.startDownload({
        transferId,
        groupKey: runtime.groupKey,
        groupId: runtime.groupId,
        epoch: runtime.epoch || '',
        remoteSessionId: result.ownerSessionId,
        localMembershipId: runtime.membershipId || '',
        remoteMembershipId:
          ('ownerMembershipId' in result && (result as any).ownerMembershipId) ||
          runtime.members.find((m) => m.peerId === result.ownerPeerId)?.membershipId ||
          result.ownerSessionId ||
          '',
        fileId: result.file.fileId,
        fileName: result.file.name,
        size: result.file.size,
        sha256: result.file.sha256,
        peerId: result.ownerPeerId,
        peerName: result.ownerName,
        destination,
        openChannel: () => transport.openFileChannel(runtime.groupId, result.ownerPeerId, transferId)
      })

      if (arg3 === undefined) return
      return { ok: true }
    },

    cancelTransfer: async (transferId: string): Promise<any> => {
      await transfers.cancelTransfer(transferId)
      publishState()
      return { ok: true }
    },

    resolveSearchResult: (arg1: string, arg2?: string): any => {
      if (arg2 !== undefined) {
        const runtime = groups.get(arg1 as GroupKey)
        return runtime?.searchResults.resolveResult(arg2)
      }
      for (const runtime of groups.values()) {
        const res = runtime.searchResults.resolveResult(arg1)
        if (res) return res as unknown as P2pSearchResult
      }
      return undefined
    },

    getAuthorizedFile: async (fileId: string): Promise<{ path: string; size: number; sha256: string }> => {
      return library.getAuthorizedFile(fileId)
    },

    // Legacy connect / disconnect methods
    connect: async (opts: ConnectOptions): Promise<void> => {
      const inv: GroupInvitation = {
        version: 2,
        signalingUrl: opts.signalingUrl,
        groupId: opts.roomId,
        token: opts.token
      }
      const res = await engineInstance.joinGroup({
        invitation: inv,
        displayName: opts.displayName,
        supernodeEligible: opts.supernodeEligible,
        relayOnly: opts.relayOnly,
        rememberInvitation: false
      })
      if (!res.ok) {
        throw new Error(`${res.code}: ${res.message}`)
      }
    },

    disconnect: async (): Promise<void> => {
      await engineInstance.disconnectAll()
    },
    dispose: async (): Promise<void> => {
      if (isDisposed) return
      isDisposed = true

      clearInterval(monitorTimer)
      for (const runtime of groups.values()) {
        clearTimeout(runtime.searchTimeoutTimer)
      }

      for (const client of endpointClients.values()) {
        client.dispose()
      }
      endpointClients.clear()

      for (const transport of endpointTransports.values()) {
        await transport.dispose()
      }
      endpointTransports.clear()

      await transfers.dispose()
      subscribers.clear()
    }
  }
  return engineInstance as unknown as PeerEngine
}
