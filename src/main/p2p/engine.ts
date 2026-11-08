import { randomBytes, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  makeGroupKey,
  validateDisplayName,
  validateCreateGroupOptions,
  validateJoinGroupOptions,
  type ActionResult,
  type CreateGroupOptions,
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
  type P2pNetworkStatus,
  type P2pRecoveryEvent,
  type P2pRole
} from '../../shared/p2p.ts'
import {
  MAX_CATALOG_BATCH_ENTRIES,
  MAX_SEARCH_QUERY_LENGTH,
  ROSTER_FRESHNESS_LEASE_MS,
  type GroupJoinedMessage,
  type OverlayCatalogAckMessageV2,
  type OverlayCatalogBatchMessageV2,
  type OverlayCatalogBeginMessageV2,
  type OverlayCatalogEndMessageV2,
  type OverlayControlMessageV2,
  type OverlaySearchMessageV2,
  type OverlaySearchResultsMessageV2,
  type SignalingIceConfig,
  type SignalingRosterPeerV2
} from '../../shared/p2p-wire.ts'
import { LibraryManager } from './library.ts'
import { SupernodeIndexManager, SearchResultsTracker } from './search-index.ts'
import { TransferManager, type TransferAuthorizationContext } from './transfers.ts'
import { createCredentialStore, type CredentialStore } from './credential-store.ts'
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
  defaultSignalingUrl?: string
  transportFactory?: (signalingUrl: string, events: TransportEvents) => TransportManager
  credentialStore?: CredentialStore
}

export interface PeerEngine {
  getState(): MultiGroupP2pState
  subscribe(listener: (state: MultiGroupP2pState) => void): () => void
  createGroup(options: CreateGroupOptions): Promise<ActionResult>
  joinGroup(options: JoinGroupOptions): Promise<ActionResult>
  resumeGroup(groupKey: GroupKey): Promise<ActionResult>
  leaveGroup(groupKey: GroupKey): Promise<ActionResult>
  rotateGroupInvite(groupKey: GroupKey): Promise<ActionResult>
  removeGroupMember(groupKey: GroupKey, targetPeerId: string): Promise<ActionResult>
  setGroupAutoJoin(groupKey: GroupKey, autoJoin: boolean): Promise<ActionResult>
  setGroupEligibility(groupKey: GroupKey, eligible: boolean): Promise<ActionResult>
  setSupernodeEligible(groupKey: GroupKey, eligible: boolean): Promise<ActionResult>
  forgetGroup(groupKey: GroupKey): Promise<ActionResult>
  disconnectAll(): Promise<ActionResult>
  setRelayOnly(relayOnly: boolean): Promise<ActionResult>
  addFiles(groupKey: GroupKey | null, paths: readonly string[]): Promise<ActionResult>
  rescanLibrary(): Promise<ActionResult>
  removeFile(fileId: string): Promise<ActionResult>
  setFileGroups(fileId: string, groupKeys: GroupKey[]): Promise<ActionResult>
  search(groupKey: GroupKey, queryText: string): Promise<ActionResult>
  download(groupKey: GroupKey, resultId: string, destination: string): Promise<ActionResult>
  cancelTransfer(transferId: string): Promise<ActionResult>
  resolveSearchResult(groupKey: GroupKey, resultId: string): MultiGroupSearchResult | undefined
  getAuthorizedFile(groupKeyOrFileId: string, fileId?: string): Promise<{ path: string; size: number; sha256: string }>
  dispose(): Promise<void>
}

interface GroupRuntime {
  groupKey: GroupKey
  groupId: string
  signalingUrl: string
  ownerPeerId: string | null
  inviteCode: string | null
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

  const defaultSignalingUrl =
    options.defaultSignalingUrl ||
    process.env.P2P_MULTIPLE_GROUPS_PUBLIC_SIGNAL_URL ||
    'ws://127.0.0.1:8787/signal'

  const store: MultiGroupPeerStore = await createMultiGroupPeerStore(options.dataDirectory)
  const persisted = store.get()

  const library = new LibraryManager()
  let isDisposed = false
  let stateRevision = 1
  let relayOnly = persisted.relayOnly

  const subscribers = new Set<(state: MultiGroupP2pState) => void>()
  const groups = new Map<GroupKey, GroupRuntime>()
  const memoryCredentials = new Map<GroupKey, string>()
  const memoryOwnerSecrets = new Map<GroupKey, string>()

  const endpointClients = new Map<string, SignalingClient>()
  const endpointTransports = new Map<string, TransportManager>()

  // Load stored shared files into library
  await library.loadStoredFiles(persisted.sharedFiles.map((f) => ({ fileId: f.fileId, path: f.path, groupKeys: f.groupKeys })))

  const isTransferAuthorized = (context: TransferAuthorizationContext): boolean => {
    if (!context.groupKey) {
      return false
    }
    const runtime = groups.get(context.groupKey)
    if (!runtime || !hasFreshGroupAuthority(runtime)) return false
    if (context.epoch && runtime.epoch && runtime.epoch !== context.epoch) return false
    if (context.direction === 'upload') {
      if (
        !context.requesterPeerId ||
        !context.requesterSessionId ||
        !context.requesterMembershipId ||
        !context.ownerMembershipId
      ) {
        return false
      }
      if (context.ownerMembershipId !== runtime.membershipId) {
        return false
      }
      const remoteMember = runtime.members.find(
        (m) =>
          m.peerId === context.requesterPeerId &&
          m.sessionId === context.requesterSessionId &&
          m.membershipId === context.requesterMembershipId
      )
      if (!remoteMember) return false

      const sf = store.get().sharedFiles.find((f) => f.fileId === context.fileId)
      if (!sf || !sf.groupKeys.includes(context.groupKey)) {
        return false
      }
      return true
    } else {
      if (
        !context.ownerPeerId ||
        !context.ownerSessionId ||
        !context.ownerMembershipId ||
        !context.requesterMembershipId
      ) {
        return false
      }
      if (context.requesterMembershipId !== runtime.membershipId) {
        return false
      }
      const remoteMember = runtime.members.find(
        (m) =>
          m.peerId === context.ownerPeerId &&
          m.sessionId === context.ownerSessionId &&
          m.membershipId === context.ownerMembershipId
      )
      if (!remoteMember) return false

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

  const credentialStore = options.credentialStore ?? createCredentialStore({ dataDirectory: options.dataDirectory })
  const autoJoinKeys: GroupKey[] = []

  // Initialize group runtimes from persisted store and load remembered credentials
  for (const g of persisted.groups) {
    const ownerSecret = await credentialStore.getCredential(`${g.groupKey}:owner`)
    if (ownerSecret) {
      memoryOwnerSecrets.set(g.groupKey, ownerSecret)
    }

    const token = await credentialStore.getCredential(g.groupKey)
    const runtime = token
      ? createGroupRuntime(g.groupKey, g.groupId, g.signalingUrl, g.supernodeEligible, g.autoJoin, 'stored')
      : createGroupRuntime(g.groupKey, g.groupId, g.signalingUrl, g.supernodeEligible, g.autoJoin, 'required')

    if (ownerSecret) {
      runtime.ownerPeerId = persisted.peerId
    }
    if (token) {
      memoryCredentials.set(g.groupKey, token)
      runtime.inviteCode = token
      if (g.autoJoin) {
        autoJoinKeys.push(g.groupKey)
      }
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
      ownerPeerId: null,
      inviteCode: null,
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

  function hasFreshGroupAuthority(runtime: GroupRuntime): boolean {
    if (isDisposed) return false
    if (!runtime.isJoined) return false
    if (!runtime.epoch || !runtime.membershipId) return false
    return Date.now() - runtime.lastRosterRenewedAt < ROSTER_FRESHNESS_LEASE_MS
  }

  function expireGroupAuthority(runtime: GroupRuntime): void {
    if (!runtime.isJoined) return
    if (runtime.status === 'recovering' && runtime.message === 'Roster freshness expired') {
      return
    }
    runtime.status = 'recovering'
    runtime.message = 'Roster freshness expired'
    runtime.supernodeIndex.clear()
    runtime.searchResults.clear()
    runtime.acknowledgedGeneration = null

    if (runtime.searchTimeoutTimer) {
      clearTimeout(runtime.searchTimeoutTimer)
      runtime.searchTimeoutTimer = undefined
    }
    if (runtime.searchQueryId) {
      runtime.searchStatus = 'error'
      runtime.searchMessage = 'Roster freshness expired'
    }

    transfers.cancelGroup(runtime.groupKey)

    const transport = endpointTransports.get(runtime.signalingUrl)
    if (transport) {
      transport.setGroupFreshness(runtime.groupId, false)
    }

    publishState()
  }

  function publishState(): void {
    stateRevision++
    const snapshot = buildSnapshot()
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
        if (!groupId) {
          try {
            channel.close()
          } catch {
            // ignore
          }
          return
        }
        const key = makeGroupKey(signalingUrl, groupId)
        const runtime = groups.get(key)
        if (!runtime || !hasFreshGroupAuthority(runtime)) {
          try {
            channel.close()
          } catch {
            // ignore
          }
          return
        }
        const remoteMember = runtime.members.find((m) => m.peerId === fromPeerId)
        if (!remoteMember || remoteMember.sessionId !== fromSessionId) {
          try {
            channel.close()
          } catch {
            // ignore
          }
          return
        }
        const channelGroupContext = {
          groupKey: key,
          groupId,
          epoch: runtime.epoch || '',
          localMembershipId: runtime.membershipId || '',
          remoteSessionId: fromSessionId,
          remoteMembershipId: remoteMember.membershipId
        }
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
      transport.setPeerContext(
        currentIdentity.peerId,
        '',
        { expiresAt: 0, servers: [] },
        relayOnly
      )
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
          onRoster: (groupId, epoch, revision, peers, ownerPeerId) => {
            const key = makeGroupKey(signalingUrl, groupId)
            const runtime = groups.get(key)
            if (runtime && ownerPeerId !== undefined) {
              runtime.ownerPeerId = ownerPeerId
            }
            handleRosterUpdate(signalingUrl, groupId, epoch, revision, peers)
          },
          onInviteRotated: (groupId, inviteCode) => {
            const key = makeGroupKey(signalingUrl, groupId)
            const runtime = groups.get(key)
            memoryCredentials.set(key, inviteCode)
            if (runtime) {
              runtime.inviteCode = inviteCode
              if (runtime.credentialStatus === 'stored') {
                void credentialStore.setCredential(key, inviteCode).catch(() => {})
              }
            }
            publishState()
          },
          onGroupKicked: (groupId, reason) => {
            const key = makeGroupKey(signalingUrl, groupId)
            const runtime = groups.get(key)
            transfers.cancelGroup(key)
            endpointTransports.get(signalingUrl)?.removeGroupContext(groupId)
            if (runtime) {
              runtime.supernodeIndex.clear()
              runtime.searchResults.clear()
              runtime.acknowledgedGeneration = null
              clearTimeout(runtime.searchTimeoutTimer)
              runtime.searchTimeoutTimer = undefined
              runtime.members = []
              runtime.isJoined = false
              runtime.status = 'disconnected'
              runtime.message = reason
              runtime.autoJoin = false
            }
            void store.setGroupAutoJoin(key, false).catch(() => {})
            publishState()
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
                runtime.status = 'error'
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
    runtime.isJoined = true
    runtime.status = 'connected'
    runtime.lastRosterRenewedAt = Date.now()
    if (msg.ownerPeerId !== undefined) {
      runtime.ownerPeerId = msg.ownerPeerId
    }
    if (msg.inviteCode) {
      runtime.inviteCode = msg.inviteCode
    }

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
    if (!runtime || !runtime.isJoined) return

    if (runtime.epoch === epoch && revision < runtime.membershipRevision) {
      return
    }

    const localPeerId = store.get().peerId
    const localMember = peers.find((p) => p.peerId === localPeerId)
    if (!localMember) {
      return
    }
    const client = endpointClients.get(signalingUrl)
    if (client && client.getSessionId() && localMember.sessionId !== client.getSessionId()) {
      return
    }
    if (runtime.membershipId && localMember.membershipId !== runtime.membershipId) {
      return
    }
    if (!runtime.membershipId) {
      runtime.membershipId = localMember.membershipId
    }

    runtime.lastRosterRenewedAt = Date.now()
    const isPureRenewal = runtime.epoch === epoch && revision === runtime.membershipRevision
    if (!isPureRenewal) {
      if (runtime.epoch !== epoch) {
        runtime.epoch = epoch
        runtime.supernodeIndex.clear()
        runtime.searchResults.clear()
        runtime.acknowledgedGeneration = null
      }

      runtime.membershipRevision = revision

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

      // Clean up departed members from index and cancel active transfers
      const activeIds = new Set(peers.map((p) => p.peerId))
      for (const member of runtime.members) {
        if (!activeIds.has(member.peerId)) {
          runtime.supernodeIndex.removeOwner(member.peerId)
        }
      }

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
    }

    const wasRecovering = runtime.status === 'recovering'
    runtime.status = 'connected'
    if (isPureRenewal && wasRecovering) {
      const activeSupernodes = runtime.members.filter((m) => m.role === 'supernode')
      if (activeSupernodes.length === 0) {
        runtime.message = 'No eligible supernode available in network.'
      } else if (runtime.role === 'supernode') {
        runtime.message = `Operating as active supernode (${activeSupernodes.length} total).`
      } else {
        runtime.message = `Connected to supernode ${runtime.primaryPeerId || 'none'}.`
      }
    }

    const transport = endpointTransports.get(signalingUrl)
    if (transport) {
      transport.updateGroupContext(groupId, runtime.epoch || epoch, runtime.membershipRevision, peers, true)
    }

    if (!isPureRenewal || wasRecovering) {
      announceCatalogue(runtime)
    }
    publishState()
  }

  function handleGroupLeft(signalingUrl: string, groupId: string): void {
    const key = makeGroupKey(signalingUrl, groupId)
    const runtime = groups.get(key)
    if (!runtime) return

    transfers.cancelGroup(key)
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
    v2: OverlayControlMessageV2
  ): void {
    if (v2.type === 'hello') return

    const key = makeGroupKey(signalingUrl, v2.groupId)
    const runtime = groups.get(key)
    if (!runtime || !hasFreshGroupAuthority(runtime)) return

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
          const senderSession = runtime.members.find((m) => m.peerId === fromPeerId)?.sessionId || fromPeerId
          const instantAck = runtime.supernodeIndex.handleCatalogBegin(fromPeerId, senderSession, v2, v2.senderMembershipId)
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
          const senderSession = runtime.members.find((m) => m.peerId === fromPeerId)?.sessionId || fromPeerId
          runtime.supernodeIndex.handleCatalogBatch(fromPeerId, senderSession, v2)
        }
        break
      }

      case 'catalog-end': {
        if (runtime.role === 'supernode') {
          const senderSession = runtime.members.find((m) => m.peerId === fromPeerId)?.sessionId || fromPeerId
          const swapped = runtime.supernodeIndex.handleCatalogEnd(fromPeerId, senderSession, v2, v2.senderMembershipId)
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
                  ownerMembershipId: b.ownerMembershipId,
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
            const added = runtime.searchResults.addBatch(v2.queryId, v2.entries, (id) => {
              const member = runtime.members.find((m) => m.peerId === id)
              return member ? member.displayName : `Peer-${id.slice(0, 6)}`
            }, key)

            if (v2.done) {
              clearTimeout(runtime.searchTimeoutTimer)
              runtime.searchTimeoutTimer = undefined
              runtime.searchStatus = 'complete'
            }

            if (added || v2.done) {
              publishState()
            }
          }
        } else if (runtime.role === 'supernode') {
          const originMember = runtime.members.find((m) => m.peerId === v2.originPeerId)
          if (!originMember || originMember.membershipId !== v2.originMembershipId) {
            break
          }
          const relayedResultsMsg: OverlaySearchResultsMessageV2 = {
            v: 2,
            type: 'search-results',
            groupId: v2.groupId,
            epoch: runtime.epoch || '',
            revision: runtime.membershipRevision,
            senderMembershipId: runtime.membershipId || '',
            queryId: v2.queryId,
            originPeerId: v2.originPeerId,
            originMembershipId: v2.originMembershipId,
            responderPeerId: v2.responderPeerId,
            responderMembershipId: v2.responderMembershipId,
            entries: v2.entries,
            done: v2.done,
            partial: v2.partial
          }

          const transport = endpointTransports.get(signalingUrl)
          transport?.sendControl(v2.groupId, v2.originPeerId, relayedResultsMsg)
        }
        break
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
    if (isDisposed || !hasFreshGroupAuthority(runtime)) return

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
        endpointClients.get(runtime.signalingUrl)?.getSessionId() || '',
        gen,
        groupMetadata,
        runtime.membershipId || undefined
      )
      runtime.acknowledgedGeneration = gen
      library.setAcknowledgedGeneration(gen)
      publishState()
      return
    }

    if (!runtime.primaryPeerId) {
      return
    }

    const transport = endpointTransports.get(runtime.signalingUrl)
    if (!transport) return

    const beginMsg: OverlayCatalogBeginMessageV2 = {
      v: 2,
      type: 'catalog-begin',
      groupId: runtime.groupId,
      epoch: runtime.epoch || '',
      revision: runtime.membershipRevision,
      senderMembershipId: runtime.membershipId || '',
      generation: gen,
      count: groupMetadata.length
    }

    if (!transport.sendControl(runtime.groupId, runtime.primaryPeerId, beginMsg)) {
      return
    }

    const batches = library.createBatches(runtime.groupKey)
    for (const batch of batches) {
      const batchMsg: OverlayCatalogBatchMessageV2 = {
        v: 2,
        type: 'catalog-batch',
        groupId: runtime.groupId,
        epoch: runtime.epoch || '',
        revision: runtime.membershipRevision,
        senderMembershipId: runtime.membershipId || '',
        generation: gen,
        entries: batch
      }
      transport.sendControl(runtime.groupId, runtime.primaryPeerId, batchMsg)
    }

    const endMsg: OverlayCatalogEndMessageV2 = {
      v: 2,
      type: 'catalog-end',
      groupId: runtime.groupId,
      epoch: runtime.epoch || '',
      revision: runtime.membershipRevision,
      senderMembershipId: runtime.membershipId || '',
      generation: gen
    }
    transport.sendControl(runtime.groupId, runtime.primaryPeerId, endMsg)
  }

  // Monitor loop for lease expirations and loss of supernode detection
  const monitorTimer = setInterval(() => {
    if (isDisposed) return
    const now = Date.now()
    for (const runtime of groups.values()) {
      if (runtime.isJoined && runtime.lastRosterRenewedAt > 0) {
        if (now - runtime.lastRosterRenewedAt >= ROSTER_FRESHNESS_LEASE_MS) {
          expireGroupAuthority(runtime)
        }
      }
    }
  }, 2000)
  monitorTimer.unref()

  function buildSnapshot(): MultiGroupP2pState {
    const persistedState = store.get()
    const activeGroupList: P2pGroupState[] = []

    for (const runtime of groups.values()) {
      const groupLinks = endpointTransports.get(runtime.signalingUrl)?.getGroupLinks(runtime.groupId) || []
      const isOwner = runtime.ownerPeerId !== null && runtime.ownerPeerId === persistedState.peerId

      const netState: MultiGroupNetworkState = {
        status: runtime.status,
        peerId: persistedState.peerId,
        sessionId: endpointClients.get(runtime.signalingUrl)?.getSessionId() || null,
        membershipId: runtime.membershipId,
        displayName: persistedState.displayName,
        supernodeEligible: runtime.supernodeEligible,
        signalingUrl: runtime.signalingUrl,
        groupId: runtime.groupId,
        ownerPeerId: runtime.ownerPeerId,
        isOwner,
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
        ownerPeerId: runtime.ownerPeerId,
        isOwner,
        inviteCode: runtime.inviteCode,
        autoJoin: runtime.autoJoin,
        credentialStatus: runtime.credentialStatus,
        network: netState,
        catalog: catState,
        search: {
          queryId: runtime.searchQueryId,
          query: runtime.searchQueryText,
          status: runtime.searchStatus,
          results: runtime.searchResults.getResults(),
          message: runtime.searchMessage
        },
        recoveryEvents: runtime.recoveryRing.getAll()
      })
    }

    return {
      revision: stateRevision,
      identity: {
        peerId: persistedState.peerId,
        displayName: persistedState.displayName
      },
      defaultSignalingUrl,
      relayOnly,
      groups: activeGroupList,
      library: {
        status: library.isScanning() ? 'scanning' : 'idle',
        files: library.getFiles()
      },
      transfers: transfers.getTransfers()
    }
  }

  let policyQueue: Promise<void> = Promise.resolve()
  function queueAction<T>(action: () => Promise<T>): Promise<T> {
    const enqueued = policyQueue.then(() => {
      if (isDisposed) throw new Error('PeerEngine is disposed')
      return action()
    })
    policyQueue = enqueued.then(
      () => {},
      () => {}
    )
    return enqueued
  }

  const engineInstance = {
    getState: () => buildSnapshot(),

    subscribe: (listener: (state: MultiGroupP2pState) => void) => {
      subscribers.add(listener)
      return () => {
        subscribers.delete(listener)
      }
    },

    createGroup: (createOpts: CreateGroupOptions): Promise<ActionResult> => {
      return queueAction(async () => {
        const validated = validateCreateGroupOptions(createOpts, defaultSignalingUrl)
        if (!validated.valid) {
          return { ok: false, code: 'INVALID_INPUT', message: validated.error }
        }
        const { groupId, displayName, signalingUrl, supernodeEligible, autoJoin, rememberInvitation } = validated.value
        const optRelay = typeof createOpts.relayOnly === 'boolean' ? createOpts.relayOnly : undefined

        const groupKey = makeGroupKey(signalingUrl, groupId)
        if (groups.has(groupKey)) {
          return { ok: false, code: 'GROUP_EXISTS', message: 'Group already exists locally' }
        }
        const hasActive = Array.from(groups.values()).some((g) => g.isJoined)
        if (hasActive && optRelay !== undefined && optRelay !== relayOnly) {
          return {
            ok: false,
            code: 'INVALID_INPUT',
            message: 'Changing relay policy requires disconnecting all groups first'
          }
        }

        const prevRelayOnly = relayOnly
        if (optRelay !== undefined) {
          relayOnly = optRelay
          for (const t of endpointTransports.values()) {
            t.setRelayOnly(relayOnly)
          }
        }

        const ownerSecret = randomBytes(32).toString('base64url')
        const { client } = getOrCreateEndpoint(signalingUrl)
        if (displayName) {
          client.setDisplayName(displayName)
        }
        const runtime = createGroupRuntime(
          groupKey,
          groupId,
          signalingUrl,
          supernodeEligible,
          autoJoin !== false,
          rememberInvitation !== false ? 'stored' : 'memory'
        )
        runtime.status = 'connecting'
        runtime.message = 'Creating group...'
        publishState()

        try {
          const joinedMsg = await client.createGroup(groupId, ownerSecret, supernodeEligible)
          const inviteCode = joinedMsg.inviteCode || ''
          runtime.inviteCode = inviteCode
          runtime.ownerPeerId = joinedMsg.ownerPeerId ?? store.get().peerId
          runtime.credentialStatus = rememberInvitation !== false ? 'stored' : 'memory'

          memoryCredentials.set(groupKey, inviteCode)
          memoryOwnerSecrets.set(groupKey, ownerSecret)

          if (rememberInvitation !== false) {
            runtime.credentialStatus = await credentialStore.setCredential(groupKey, inviteCode)
            await credentialStore.setCredential(`${groupKey}:owner`, ownerSecret)
          }

          const groupPersisted: PersistedGroupV2 = {
            groupKey,
            signalingUrl,
            groupId,
            supernodeEligible,
            autoJoin: autoJoin !== false,
            credentialCiphertext: rememberInvitation !== false ? 'stored' : null
          }

          await store.upsertGroup(groupPersisted, {
            displayName,
            relayOnly: optRelay
          })

          publishState()
          return { ok: true }
        } catch (err) {
          await client.leaveGroup(groupId).catch(() => {})
          groups.delete(groupKey)
          memoryCredentials.delete(groupKey)
          memoryOwnerSecrets.delete(groupKey)
          const survivingActive = Array.from(groups.values()).some((g) => g.isJoined)
          if (!survivingActive) {
            relayOnly = prevRelayOnly
            for (const t of endpointTransports.values()) {
              t.setRelayOnly(relayOnly)
            }
          }
          runtime.status = 'error'
          runtime.message = err instanceof Error ? err.message : String(err)
          publishState()
          const errMsg = runtime.message
          const code: P2pErrorCode = errMsg.includes('GROUP_EXISTS') ? 'GROUP_EXISTS' : 'PROTOCOL_ERROR'
          return { ok: false, code, message: errMsg }
        }
      })
    },

    joinGroup: (joinOpts: JoinGroupOptions): Promise<ActionResult> => {
      return queueAction(async () => {
        const validated = validateJoinGroupOptions(joinOpts, defaultSignalingUrl)
        if (!validated.valid) {
          return { ok: false, code: 'INVALID_INPUT', message: validated.error }
        }
        const { invitation: inv, displayName, supernodeEligible, autoJoin, rememberInvitation } = validated.value
        const optRelay = typeof joinOpts.relayOnly === 'boolean' ? joinOpts.relayOnly : undefined

        const hasActive = Array.from(groups.values()).some((g) => g.isJoined)
        if (hasActive && optRelay !== undefined && optRelay !== relayOnly) {
          return {
            ok: false,
            code: 'INVALID_INPUT',
            message: 'Changing relay policy requires disconnecting all groups first'
          }
        }

        const prevRelayOnly = relayOnly
        if (optRelay !== undefined) {
          relayOnly = optRelay
          for (const t of endpointTransports.values()) {
            t.setRelayOnly(relayOnly)
          }
        }

        const { client } = getOrCreateEndpoint(inv.signalingUrl)
        if (displayName) {
          client.setDisplayName(displayName)
        }

        const isCodeOnly = inv.groupId === ''
        if (!isCodeOnly) {
          const initialKey = makeGroupKey(inv.signalingUrl, inv.groupId)
          const runtime = createGroupRuntime(
            initialKey,
            inv.groupId,
            inv.signalingUrl,
            supernodeEligible,
            autoJoin !== false,
            rememberInvitation !== false ? 'stored' : 'memory'
          )
          runtime.supernodeEligible = supernodeEligible
          runtime.autoJoin = autoJoin !== false
        }

        try {
          let joinedMsg: GroupJoinedMessage
          if (isCodeOnly) {
            joinedMsg = await client.joinGroup('', inv.token, supernodeEligible)
          } else {
            const existingKey = makeGroupKey(inv.signalingUrl, inv.groupId)
            const existingSecret = memoryOwnerSecrets.get(existingKey)
            joinedMsg = await client.joinGroup(inv.groupId, inv.token, supernodeEligible, existingSecret)
          }

          const resolvedGroupId = joinedMsg.groupId
          const groupKey = makeGroupKey(inv.signalingUrl, resolvedGroupId)
          const inviteCode = joinedMsg.inviteCode || inv.token

          let runtime = groups.get(groupKey)
          if (!runtime) {
            runtime = createGroupRuntime(
              groupKey,
              resolvedGroupId,
              inv.signalingUrl,
              supernodeEligible,
              autoJoin !== false,
              rememberInvitation !== false ? 'stored' : 'memory'
            )
            handleGroupJoined(inv.signalingUrl, joinedMsg)
          }
          runtime.inviteCode = inviteCode
          runtime.ownerPeerId = joinedMsg.ownerPeerId ?? null
          runtime.supernodeEligible = supernodeEligible
          runtime.credentialStatus = rememberInvitation !== false ? 'stored' : 'memory'
          runtime.autoJoin = autoJoin !== false

          memoryCredentials.set(groupKey, inviteCode)

          if (rememberInvitation !== false) {
            runtime.credentialStatus = await credentialStore.setCredential(groupKey, inviteCode)
          } else {
            await credentialStore.deleteCredential(groupKey)
            runtime.credentialStatus = 'memory'
          }

          try {
            await store.upsertGroup({
              groupKey,
              signalingUrl: inv.signalingUrl,
              groupId: resolvedGroupId,
              supernodeEligible,
              autoJoin: autoJoin !== false,
              credentialCiphertext: rememberInvitation !== false ? 'stored' : null
            }, {
              displayName,
              relayOnly
            })
          } catch (storeErr) {
            await client.leaveGroup(resolvedGroupId).catch(() => {})
            groups.delete(groupKey)
            memoryCredentials.delete(groupKey)
            memoryOwnerSecrets.delete(groupKey)
            const survivingActive = Array.from(groups.values()).some((g) => g.isJoined)
            if (!survivingActive) {
              relayOnly = prevRelayOnly
              for (const t of endpointTransports.values()) {
                t.setRelayOnly(relayOnly)
              }
            }
            return { ok: false, code: 'IO_ERROR', message: 'Failed to persist group membership' }
          }
          publishState()
          return { ok: true }
        } catch (err) {
          const survivingActive = Array.from(groups.values()).some((g) => g.isJoined)
          if (!survivingActive) {
            relayOnly = prevRelayOnly
            for (const t of endpointTransports.values()) {
              t.setRelayOnly(relayOnly)
            }
          }
          const msg = err instanceof Error ? err.message : String(err)
          let code: P2pErrorCode = 'PROTOCOL_ERROR'
          if (msg.includes('AUTH_FAILED')) code = 'AUTH_FAILED'
          else if (msg.includes('GROUP_FULL')) code = 'GROUP_FULL'
          else if (msg.includes('LIMIT_EXCEEDED')) code = 'BUSY'
          else if (msg.includes('NOT_FOUND')) code = 'NOT_FOUND'
          return { ok: false, code, message: msg }
        }
      })
    },

    resumeGroup: (groupKey: GroupKey): Promise<ActionResult> => {
      return queueAction(async () => {
        const runtime = groups.get(groupKey)
        if (!runtime) {
          return { ok: false, code: 'NOT_FOUND', message: 'Group not found' }
        }

        const token = memoryCredentials.get(groupKey)
        if (!token) {
          return { ok: false, code: 'INVITATION_REQUIRED', message: 'Invitation token required to resume group' }
        }

        const { client } = getOrCreateEndpoint(runtime.signalingUrl)
        const ownerSecret = memoryOwnerSecrets.get(groupKey)
        try {
          await client.joinGroup(runtime.groupId, token, runtime.supernodeEligible, ownerSecret)
          publishState()
          return { ok: true }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          let code: P2pErrorCode = 'PROTOCOL_ERROR'
          if (msg.includes('AUTH_FAILED')) code = 'AUTH_FAILED'
          else if (msg.includes('GROUP_FULL')) code = 'GROUP_FULL'
          return { ok: false, code, message: msg }
        }
      })
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

    rotateGroupInvite: async (groupKey: GroupKey): Promise<ActionResult> => {
      if (isDisposed) return { ok: false, code: 'DISCONNECTED', message: 'Engine is disposed' }
      const runtime = groups.get(groupKey)
      if (!runtime || !runtime.isJoined) {
        return { ok: false, code: 'NOT_FOUND', message: 'Group is not currently joined' }
      }
      const ownerSecret = memoryOwnerSecrets.get(groupKey)
      if (!ownerSecret || runtime.ownerPeerId !== store.get().peerId) {
        return { ok: false, code: 'FORBIDDEN', message: 'Only the group owner can rotate the invite code' }
      }
      const client = endpointClients.get(runtime.signalingUrl)
      if (!client) {
        return { ok: false, code: 'DISCONNECTED', message: 'Not connected to signaling server' }
      }

      try {
        const newCode = await client.rotateInvite(runtime.groupId, ownerSecret)
        runtime.inviteCode = newCode
        memoryCredentials.set(groupKey, newCode)
        if (runtime.credentialStatus === 'stored') {
          await credentialStore.setCredential(groupKey, newCode)
        }
        publishState()
        return { ok: true }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const code: P2pErrorCode = errMsg.includes('FORBIDDEN') ? 'FORBIDDEN' : 'PROTOCOL_ERROR'
        return { ok: false, code, message: errMsg }
      }
    },

    removeGroupMember: async (groupKey: GroupKey, targetPeerId: string): Promise<ActionResult> => {
      if (isDisposed) return { ok: false, code: 'DISCONNECTED', message: 'Engine is disposed' }
      const runtime = groups.get(groupKey)
      if (!runtime || !runtime.isJoined) {
        return { ok: false, code: 'NOT_FOUND', message: 'Group is not currently joined' }
      }
      const ownerSecret = memoryOwnerSecrets.get(groupKey)
      if (!ownerSecret || runtime.ownerPeerId !== store.get().peerId) {
        return { ok: false, code: 'FORBIDDEN', message: 'Only the group owner can remove members' }
      }
      if (targetPeerId === store.get().peerId) {
        return { ok: false, code: 'INVALID_INPUT', message: 'Cannot remove yourself from group' }
      }
      const client = endpointClients.get(runtime.signalingUrl)
      if (!client) {
        return { ok: false, code: 'DISCONNECTED', message: 'Not connected to signaling server' }
      }

      try {
        await client.removeMember(runtime.groupId, targetPeerId, ownerSecret)
        return { ok: true }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const code: P2pErrorCode = errMsg.includes('FORBIDDEN') ? 'FORBIDDEN' : 'PROTOCOL_ERROR'
        return { ok: false, code, message: errMsg }
      }
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

    setGroupEligibility: async (groupKey: GroupKey, eligible: boolean): Promise<ActionResult> => {
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

    setSupernodeEligible: async (groupKey: GroupKey, eligible: boolean): Promise<ActionResult> => {
      return engineInstance.setGroupEligibility(groupKey, eligible)
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
      memoryOwnerSecrets.delete(groupKey)
      await credentialStore.deleteCredential(groupKey)
      await credentialStore.deleteCredential(`${groupKey}:owner`)
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

    setRelayOnly: (newRelayOnly: boolean): Promise<ActionResult> => {
      return queueAction(async () => {
        const hasActive = Array.from(groups.values()).some((g) => g.isJoined)
        if (hasActive) {
          return {
            ok: false,
            code: 'INVALID_INPUT',
            message: 'Changing relay policy requires disconnecting all groups first'
          }
        }
        await store.setRelayOnly(newRelayOnly)
        relayOnly = newRelayOnly
        for (const t of endpointTransports.values()) {
          t.setRelayOnly(newRelayOnly)
        }
        publishState()
        return { ok: true }
      })
    },

    addFiles: async (groupKey: GroupKey | null, paths: readonly string[]): Promise<ActionResult> => {
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
      return { ok: true }
    },

    rescanLibrary: async (): Promise<ActionResult> => {
      await library.rescanLibrary()
      scheduleAnnounceAll()
      publishState()
      return { ok: true }
    },

    removeFile: async (fileId: string): Promise<ActionResult> => {
      library.removeFile(fileId)
      await store.removeSharedFile(fileId)
      scheduleAnnounceAll()
      publishState()
      return { ok: true }
    },

    setFileGroups: async (fileId: string, groupKeys: GroupKey[]): Promise<ActionResult> => {
      const existing = store.get().sharedFiles.find((f) => f.fileId === fileId)
      const oldKeys = existing ? [...existing.groupKeys] : []

      try {
        await store.setFileGroups(fileId, groupKeys)
      } catch (err: unknown) {
        return {
          ok: false,
          code: 'IO_ERROR',
          message: err instanceof Error ? err.message : String(err)
        }
      }

      library.setFileGroups(fileId, groupKeys)

      const removedKeys = oldKeys.filter((k) => !groupKeys.includes(k))
      for (const removedKey of removedKeys) {
        transfers.cancelFileTransfer(removedKey, fileId)
      }

      scheduleAnnounceAll()
      publishState()
      return { ok: true }
    },

    search: async (groupKey: GroupKey, queryText: string): Promise<ActionResult> => {
      const trimmed = queryText.trim()
      if (trimmed.length < 1 || trimmed.length > MAX_SEARCH_QUERY_LENGTH) {
        return { ok: false, code: 'INVALID_INPUT', message: 'Query must be 1 to 120 characters' }
      }

      const runtime = groups.get(groupKey)
      if (!runtime || !hasFreshGroupAuthority(runtime)) {
        return { ok: false, code: 'DISCONNECTED', message: 'Group is not connected or roster authority has expired' }
      }

      const currentQueryId = randomUUID()
      runtime.searchQueryText = trimmed
      runtime.searchQueryId = currentQueryId
      runtime.searchStatus = 'searching'
      runtime.searchMessage = null
      runtime.searchResults.startNewSearch(currentQueryId, trimmed)
      publishState()

      clearTimeout(runtime.searchTimeoutTimer)
      runtime.searchTimeoutTimer = undefined

      const transport = endpointTransports.get(runtime.signalingUrl)
      if (runtime.role === 'supernode') {
        runtime.searchTimeoutTimer = setTimeout(() => {
          if (runtime.searchStatus === 'searching' && runtime.searchQueryId === currentQueryId) {
            runtime.searchStatus = 'complete'
            publishState()
          }
        }, 8000)

        const localRes = runtime.supernodeIndex.search(trimmed, store.get().peerId, currentQueryId)
        runtime.searchResults.addBatch(currentQueryId, localRes.entries, (id) => {
          const m = runtime.members.find((x) => x.peerId === id)
          return m ? m.displayName : `Peer-${id.slice(0, 6)}`
        }, groupKey)
        const otherSupernode = runtime.activeElectedSupernodes.find((id) => id !== store.get().peerId)
        if (otherSupernode) {
          transport?.sendControl(runtime.groupId, otherSupernode, {
            v: 2,
            type: 'search-forward',
            groupId: runtime.groupId,
            epoch: runtime.epoch || '',
            revision: runtime.membershipRevision,
            senderMembershipId: runtime.membershipId || '',
            queryId: currentQueryId,
            query: trimmed,
            originPeerId: store.get().peerId,
            originMembershipId: runtime.membershipId || '',
            ttl: 0
          })
        } else {
          runtime.searchStatus = 'complete'
          clearTimeout(runtime.searchTimeoutTimer)
          runtime.searchTimeoutTimer = undefined
        }
        publishState()
        return { ok: true }
      } else if (runtime.role === 'ordinary') {
        const capturedPrimary = runtime.primaryPeerId
        if (!capturedPrimary) {
          runtime.searchStatus = 'error'
          runtime.searchMessage = 'No supernode available to route search'
          publishState()
          return { ok: false, code: 'NO_SUPERNODE', message: 'No supernode available to route search' }
        }

        if (!transport) {
          runtime.searchStatus = 'error'
          runtime.searchMessage = 'Transport unavailable'
          publishState()
          return { ok: false, code: 'UNREACHABLE', message: 'Transport unavailable' }
        }

        try {
          await transport.waitForLinkOpen(capturedPrimary, 10000)
        } catch (waitErr: unknown) {
          if (runtime.searchQueryId !== currentQueryId || isDisposed) {
            return { ok: false, code: 'UNREACHABLE', message: 'Query superseded or engine disposed' }
          }
          runtime.searchStatus = 'error'
          runtime.searchMessage = `Primary link failed to open: ${waitErr instanceof Error ? waitErr.message : String(waitErr)}`
          publishState()
          return { ok: false, code: 'UNREACHABLE', message: runtime.searchMessage }
        }

        if (isDisposed || runtime.searchQueryId !== currentQueryId) {
          return { ok: false, code: 'UNREACHABLE', message: 'Query superseded or engine disposed' }
        }
        if (!hasFreshGroupAuthority(runtime)) {
          runtime.searchStatus = 'error'
          runtime.searchMessage = 'Group authority expired while waiting for primary route'
          publishState()
          return { ok: false, code: 'DISCONNECTED', message: 'Group authority expired' }
        }
        if (runtime.primaryPeerId !== capturedPrimary) {
          runtime.searchStatus = 'error'
          runtime.searchMessage = 'Primary route changed while waiting for connection'
          publishState()
          return { ok: false, code: 'UNREACHABLE', message: 'Primary route changed' }
        }

        const sent = transport.sendControl(runtime.groupId, capturedPrimary, {
          v: 2,
          type: 'search',
          groupId: runtime.groupId,
          epoch: runtime.epoch || '',
          revision: runtime.membershipRevision,
          senderMembershipId: runtime.membershipId || '',
          queryId: currentQueryId,
          query: trimmed,
          ttl: 1
        })

        if (!sent) {
          runtime.searchStatus = 'error'
          runtime.searchMessage = 'Failed to dispatch search control frame to primary'
          publishState()
          return { ok: false, code: 'UNREACHABLE', message: 'Failed to dispatch search frame' }
        }

        runtime.searchTimeoutTimer = setTimeout(() => {
          if (runtime.searchStatus === 'searching' && runtime.searchQueryId === currentQueryId) {
            runtime.searchStatus = 'complete'
            publishState()
          }
        }, 8000)

        return { ok: true }
      }
      return { ok: false, code: 'UNREACHABLE', message: 'Unknown peer role' }
    },

    download: async (groupKey: GroupKey, resultId: string, destination: string): Promise<ActionResult> => {
      const runtime = groups.get(groupKey)
      if (!runtime || !hasFreshGroupAuthority(runtime)) {
        return { ok: false, code: 'DISCONNECTED', message: 'Group is not connected or roster authority has expired' }
      }
      const result = runtime.searchResults.resolveResult(resultId)
      if (!result) return { ok: false, code: 'NOT_FOUND', message: 'Search result not found' }

      const transport = endpointTransports.get(runtime.signalingUrl)
      if (!transport) return { ok: false, code: 'NOT_FOUND', message: 'Transport not found' }

      const transferId = randomUUID()
      try {
        await transfers.startDownload({
          transferId,
          groupKey: runtime.groupKey,
          groupId: runtime.groupId,
          epoch: runtime.epoch || '',
          remoteSessionId: result.ownerSessionId,
          localMembershipId: runtime.membershipId || '',
          remoteMembershipId:
            runtime.members.find((m) => m.peerId === result.ownerPeerId)?.membershipId ||
            result.ownerMembershipId ||
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
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        let code: P2pErrorCode = 'IO_ERROR'
        if (msg === 'BUSY') code = 'BUSY'
        else if (msg === 'DESTINATION_EXISTS') code = 'DESTINATION_EXISTS'
        else if (msg === 'NOT_AUTHORIZED') code = 'FORBIDDEN'
        return { ok: false, code, message: msg }
      }
    },

    cancelTransfer: async (transferId: string): Promise<ActionResult> => {
      await transfers.cancelTransfer(transferId)
      publishState()
      return { ok: true }
    },

    resolveSearchResult: (groupKey: GroupKey, resultId: string): MultiGroupSearchResult | undefined => {
      const runtime = groups.get(groupKey)
      if (!runtime || !hasFreshGroupAuthority(runtime)) return undefined
      return runtime.searchResults.resolveResult(resultId)
    },

    getAuthorizedFile: async (arg1: string, arg2?: string): Promise<{ path: string; size: number; sha256: string }> => {
      return library.getAuthorizedFile(arg1, arg2)
    },

    dispose: async (): Promise<void> => {
      if (isDisposed) return
      isDisposed = true

      try {
        await policyQueue
      } catch {
        // ignore
      }

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

  queueMicrotask(async () => {
    for (const key of autoJoinKeys) {
      if (isDisposed) break
      try {
        const res = await engineInstance.resumeGroup(key)
        if (!res.ok) {
          const runtime = groups.get(key)
          if (runtime && !runtime.isJoined) {
            runtime.status = res.code === 'AUTH_FAILED' ? 'error' : 'disconnected'
            runtime.message = res.message
            publishState()
          }
        }
      } catch (err: unknown) {
        const runtime = groups.get(key)
        if (runtime && !runtime.isJoined) {
          runtime.status = 'error'
          runtime.message = err instanceof Error ? err.message : String(err)
          publishState()
        }
      }
    }
  })

  return engineInstance
}
