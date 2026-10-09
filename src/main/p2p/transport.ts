import { RTCPeerConnection, type RTCDataChannel } from 'werift'
import { randomUUID } from 'node:crypto'
import type {
  P2pCandidatePath,
  P2pLinkState,
  P2pPeerLink
} from '../../shared/p2p.ts'
import {
  isOverlayControlMessage,
  isOverlayControlMessageV2,
  isPeerHelloMessage,
  parseFileChannelLabelV2,
  makeFileChannelLabelV2,
  CONTROL_CHANNEL_LABEL_V2,
  FILE_CHANNEL_LABEL_PREFIX_V2,
  type OverlayControlMessage,
  type OverlayControlMessageV2,
  type PeerHelloMessage,
  type OverlayHelloMessage,
  type SignalingIceConfig,
  type SignalingRosterPeer,
  type SignalingRosterPeerV2,
  MAX_CONTROL_MESSAGE_SIZE
} from '../../shared/p2p-wire.ts'

export type LegacyOnFileChannelCallback = (fromPeerId: string, transferId: string, channel: RTCDataChannel) => void
export type V2OnFileChannelCallback = (
  groupId: string,
  fromPeerId: string,
  fromSessionId: string,
  transferId: string,
  channel: RTCDataChannel
) => void
export type OnFileChannelCallback = LegacyOnFileChannelCallback | V2OnFileChannelCallback

export interface TransportEvents {
  onControlMessage: (fromPeerId: string, message: OverlayControlMessageV2 | OverlayControlMessage) => void
  onFileChannel: OnFileChannelCallback
  onLinkStateChange: (peerId: string, state: P2pLinkState, path: P2pCandidatePath) => void
  onSendSignal: (signal: {
    groupId?: string
    targetPeerId: string
    targetSessionId: string
    connectionId: string
    kind: 'request-offer' | 'offer' | 'answer' | 'candidate'
    payload: unknown
  }) => void
}

export interface TransportManagerOptions {
  connectionFactory?: (config: ConstructorParameters<typeof RTCPeerConnection>[0]) => RTCPeerConnection
}

interface PeerConnectionRecord {
  peerId: string
  sessionId: string
  pc: RTCPeerConnection
  controlChannel: RTCDataChannel | null
  controlReady: boolean
  attemptId: string
  attemptTimer: NodeJS.Timeout | null
  candidateCount: number
  state: P2pLinkState
  path: P2pCandidatePath
  activeFileChannels: Map<string, RTCDataChannel>
  negotiationGroupId?: string
}

interface GroupContext {
  groupId: string
  epoch: string
  revision: number
  peers: Map<string, SignalingRosterPeerV2>
  fresh: boolean
}

export class TransportManager {
  private readonly events: TransportEvents
  private readonly options: TransportManagerOptions
  private readonly connections = new Map<string, PeerConnectionRecord>()
  private localPeerId = ''
  private localSessionId = ''
  private legacyEpoch = ''
  private legacyRevision = 0
  private iceConfig: SignalingIceConfig = { expiresAt: 0, servers: [] }
  private relayOnly = false
  private activeLegacyRoster = new Map<string, SignalingRosterPeer>()
  private readonly groupContexts = new Map<string, GroupContext>()
  private isDisposed = false

  constructor(events: TransportEvents, options: TransportManagerOptions = {}) {
    this.events = events
    this.options = options
  }

  // ==========================================
  // Multi-Group Context Management
  // ==========================================

  setPeerContext(
    peerId: string,
    sessionId: string,
    iceConfig: SignalingIceConfig,
    relayOnly: boolean
  ): void {
    this.localPeerId = peerId
    this.localSessionId = sessionId
    this.iceConfig = iceConfig
    this.relayOnly = relayOnly
  }

  updateGroupContext(
    groupId: string,
    epoch: string,
    revision: number,
    peers: readonly SignalingRosterPeerV2[],
    fresh: boolean
  ): void {
    if (this.isDisposed) return

    const peerMap = new Map<string, SignalingRosterPeerV2>()
    for (const p of peers) {
      if (p.peerId !== this.localPeerId) {
        peerMap.set(p.peerId, p)
      }
    }

    this.groupContexts.set(groupId, {
      groupId,
      epoch,
      revision,
      peers: peerMap,
      fresh
    })

    this.reconcileConnections()
  }

  removeGroupContext(groupId: string): void {
    if (this.isDisposed) return
    this.groupContexts.delete(groupId)
    this.reconcileConnections()
  }

  // ==========================================
  // Legacy Single-Group Adapter Methods
  // ==========================================

  setSignalingContext(
    epoch: string,
    revision: number,
    localPeerId: string,
    localSessionId: string,
    iceConfig: SignalingIceConfig,
    relayOnly: boolean
  ): void {
    this.legacyEpoch = epoch
    this.legacyRevision = revision
    this.setPeerContext(localPeerId, localSessionId, iceConfig, relayOnly)
  }

  updateRoster(activePeers: readonly SignalingRosterPeer[]): void {
    if (this.isDisposed) return
    this.activeLegacyRoster.clear()
    const activeIds = new Set<string>()

    for (const p of activePeers) {
      if (p.peerId !== this.localPeerId) {
        this.activeLegacyRoster.set(p.peerId, p)
        activeIds.add(p.peerId)
      }
    }

    // Prune connections for departed peers
    for (const [peerId, record] of this.connections.entries()) {
      if (!activeIds.has(peerId) && this.getSharedGroups(peerId).length === 0) {
        void this.cleanupRecord(record, 'failed')
        this.connections.delete(peerId)
      }
    }

    // Attempt connections to all active legacy peers
    for (const [peerId, peer] of this.activeLegacyRoster.entries()) {
      const existing = this.connections.get(peerId)
      if (!existing || existing.sessionId !== peer.sessionId || existing.state === 'failed') {
        if (existing) {
          void this.cleanupRecord(existing, 'failed')
          this.connections.delete(peerId)
        }
        this.initiateOrRequestConnectionLegacy(peer)
      }
    }
  }

  getAllLinks(): P2pPeerLink[] {
    const list: P2pPeerLink[] = []
    for (const [peerId, record] of this.connections.entries()) {
      list.push({
        peerId,
        state: record.state,
        path: record.path
      })
    }
    return list
  }

  getGroupLinks(groupId: string): P2pPeerLink[] {
    const group = this.groupContexts.get(groupId)
    if (!group) return []

    const list: P2pPeerLink[] = []
    for (const peerId of group.peers.keys()) {
      const record = this.connections.get(peerId)
      if (record) {
        list.push({
          peerId,
          state: record.state,
          path: record.path
        })
      }
    }
    return list
  }

  getLinkState(peerId: string): { state: P2pLinkState; path: P2pCandidatePath } | null {
    const record = this.connections.get(peerId)
    if (!record) return null
    return { state: record.state, path: record.path }
  }

  async closeLink(peerId: string): Promise<void> {
    const record = this.connections.get(peerId)
    if (record) {
      await this.cleanupRecord(record, 'failed')
      this.connections.delete(peerId)
    }
  }

  // ==========================================
  // Connection Pool Reconciliation
  // ==========================================

  private getSharedGroups(peerId: string): string[] {
    const shared: string[] = []
    for (const [groupId, ctx] of this.groupContexts.entries()) {
      if (ctx.peers.has(peerId)) {
        shared.push(groupId)
      }
    }
    return shared.sort()
  }

  private reconcileConnections(): void {
    if (this.isDisposed || !this.localPeerId) return

    // Compute union of active peers across all groups
    const activeUnion = new Map<string, { peerId: string; sessionId: string; groups: string[] }>()

    for (const [groupId, ctx] of this.groupContexts.entries()) {
      for (const peer of ctx.peers.values()) {
        let entry = activeUnion.get(peer.peerId)
        if (!entry) {
          entry = { peerId: peer.peerId, sessionId: peer.sessionId, groups: [] }
          activeUnion.set(peer.peerId, entry)
        }
        entry.groups.push(groupId)
      }
    }

    // Prune connections for peers no longer in any active group (and not in legacy roster)
    for (const [peerId, record] of this.connections.entries()) {
      if (!activeUnion.has(peerId) && !this.activeLegacyRoster.has(peerId)) {
        void this.cleanupRecord(record, 'failed')
        this.connections.delete(peerId)
      }
    }

    // Connect to each peer in the union
    for (const [peerId, peerEntry] of activeUnion.entries()) {
      const existing = this.connections.get(peerId)
      if (!existing || existing.sessionId !== peerEntry.sessionId || existing.state === 'failed') {
        if (existing) {
          void this.cleanupRecord(existing, 'failed')
          this.connections.delete(peerId)
        }
        this.initiateOrRequestConnection(peerEntry)
      }
    }
  }

  private initiateOrRequestConnection(remotePeer: { peerId: string; sessionId: string; groups: string[] }): void {
    if (this.isDisposed || !this.localPeerId) return

    const shared = remotePeer.groups.slice().sort()
    const chosenGroupId = shared[0] || ''
    const connectionId = randomUUID()

    if (this.localPeerId < remotePeer.peerId) {
      // Lower lexical ID initiates offer
      this.createPeerConnection(remotePeer.peerId, remotePeer.sessionId, connectionId, true, chosenGroupId)
    } else {
      // Upper lexical ID requests initiation
      this.events.onSendSignal({
        groupId: chosenGroupId,
        targetPeerId: remotePeer.peerId,
        targetSessionId: remotePeer.sessionId,
        connectionId,
        kind: 'request-offer',
        payload: null
      })
    }
  }

  private initiateOrRequestConnectionLegacy(remotePeer: SignalingRosterPeer): void {
    if (this.isDisposed || !this.localPeerId) return

    const connectionId = randomUUID()
    if (this.localPeerId < remotePeer.peerId) {
      this.createPeerConnection(remotePeer.peerId, remotePeer.sessionId, connectionId, true)
    } else {
      this.events.onSendSignal({
        targetPeerId: remotePeer.peerId,
        targetSessionId: remotePeer.sessionId,
        connectionId,
        kind: 'request-offer',
        payload: null
      })
    }
  }

  private createPeerConnection(
    remotePeerId: string,
    remoteSessionId: string,
    connectionId: string,
    isInitiator: boolean,
    negotiationGroupId?: string
  ): PeerConnectionRecord {
    const existing = this.connections.get(remotePeerId)
    if (existing) {
      void this.cleanupRecord(existing, 'failed')
      this.connections.delete(remotePeerId)
    }

    // Build configuration
    let turnHostname: string | undefined
    for (const s of this.iceConfig.servers) {
      if (s.urls.startsWith('turns:') || s.urls.includes('transport=tls')) {
        try {
          const u = new URL(s.urls.replace('turns:', 'https:').replace('turn:', 'http:'))
          turnHostname = u.hostname
          break
        } catch {
          // ignore parsing error
        }
      }
    }

    const pcConfig: Record<string, unknown> = {
      iceServers: this.iceConfig.servers,
      iceTransportPolicy: this.relayOnly ? 'relay' : 'all',
      maxMessageSize: 65536
    }

    if (turnHostname) {
      pcConfig.turnTlsOptions = {
        servername: turnHostname,
        rejectUnauthorized: true
      }
      pcConfig.turnTransport = 'tls'
    }

    const pc = this.options.connectionFactory
      ? this.options.connectionFactory(pcConfig as ConstructorParameters<typeof RTCPeerConnection>[0])
      : new RTCPeerConnection(pcConfig as unknown as object)

    const record: PeerConnectionRecord = {
      peerId: remotePeerId,
      sessionId: remoteSessionId,
      pc,
      controlChannel: null,
      controlReady: false,
      attemptId: connectionId,
      attemptTimer: null,
      candidateCount: 0,
      state: 'connecting',
      path: 'unknown',
      activeFileChannels: new Map(),
      negotiationGroupId
    }

    // 20-second connection attempt deadline
    record.attemptTimer = setTimeout(() => {
      if (record.state === 'connecting') {
        void this.cleanupRecord(record, 'failed')
      }
    }, 20000)

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (!event.candidate || record.attemptId !== connectionId) return
      const candObj = event.candidate.toJSON() as { candidate?: string }
      const candStr = candObj.candidate || ''
      if (candStr.includes(' typ ') && (candStr.includes('::') || candStr.match(/\b([0-9a-fA-F]{1,4}:){2,}/))) {
        return
      }
      if (record.candidateCount >= 64) return
      record.candidateCount++

      const shared = this.getSharedGroups(remotePeerId)
      const sigGroupId = record.negotiationGroupId || shared[0]

      this.events.onSendSignal({
        groupId: sigGroupId,
        targetPeerId: remotePeerId,
        targetSessionId: remoteSessionId,
        connectionId,
        kind: 'candidate',
        payload: candObj
      })
    }

    // Handle incoming data channels
    pc.ondatachannel = (event) => {
      const channel = event.channel
      if (channel.label === CONTROL_CHANNEL_LABEL_V2 || channel.label === 'kazaa-control-v1') {
        record.controlChannel = channel
        this.setupControlChannel(record, channel)
      } else if (channel.label.startsWith(FILE_CHANNEL_LABEL_PREFIX_V2)) {
        const parsed = parseFileChannelLabelV2(channel.label)
        if (parsed) {
          record.activeFileChannels.set(parsed.transferId, channel)
          channel.onclose = () => {
            record.activeFileChannels.delete(parsed.transferId)
          }
          this.emitFileChannel(parsed.groupId, remotePeerId, remoteSessionId, parsed.transferId, channel)
        } else {
          try {
            channel.close()
          } catch {
            // ignore
          }
        }
      } else if (channel.label.startsWith('kazaa-file-v1:')) {
        const transferId = channel.label.slice('kazaa-file-v1:'.length)
        record.activeFileChannels.set(transferId, channel)
        channel.onclose = () => {
          record.activeFileChannels.delete(transferId)
        }
        this.emitFileChannel('', remotePeerId, remoteSessionId, transferId, channel)
      } else {
        try {
          channel.close()
        } catch {
          // ignore
        }
      }
    }

    pc.connectionStateChange.subscribe((state) => {
      if (state === 'failed' || state === 'closed') {
        if (record.state !== 'failed') {
          void this.cleanupRecord(record, 'failed')
        }
      }
    })

    this.connections.set(remotePeerId, record)
    this.events.onLinkStateChange(remotePeerId, 'connecting', 'unknown')

    if (isInitiator) {
      const dc = pc.createDataChannel(CONTROL_CHANNEL_LABEL_V2, {
        ordered: true
      })
      record.controlChannel = dc
      this.setupControlChannel(record, dc)

      pc.createOffer()
        .then(async (offer) => {
          if (record.attemptId !== connectionId) return
          await pc.setLocalDescription(offer)
          const shared = this.getSharedGroups(remotePeerId)
          const sigGroupId = record.negotiationGroupId || shared[0]

          this.events.onSendSignal({
            groupId: sigGroupId,
            targetPeerId: remotePeerId,
            targetSessionId: remoteSessionId,
            connectionId,
            kind: 'offer',
            payload: { type: offer.type, sdp: offer.sdp }
          })
        })
        .catch(() => {
          void this.cleanupRecord(record, 'failed')
        })
    }

    return record
  }

  private setupControlChannel(record: PeerConnectionRecord, channel: RTCDataChannel): void {
    let helloSent = false
    const sendHello = () => {
      if (helloSent || this.isDisposed || !this.localPeerId) return
      helloSent = true

      // Send V2 physical hello message
      const helloV2: PeerHelloMessage = {
        v: 2,
        type: 'hello',
        peerId: this.localPeerId,
        sessionId: this.localSessionId,
        connectionId: record.attemptId
      }

      // Also send V1 hello if legacy epoch is present for backwards compatibility
      const helloV1: OverlayHelloMessage = {
        v: 1,
        type: 'hello',
        epoch: this.legacyEpoch,
        revision: this.legacyRevision,
        peerId: this.localPeerId,
        sessionId: this.localSessionId
      }

      try {
        channel.send(Buffer.from(JSON.stringify(helloV2), 'utf-8'))
        if (this.legacyEpoch) {
          channel.send(Buffer.from(JSON.stringify(helloV1), 'utf-8'))
        }
      } catch {
        void this.cleanupRecord(record, 'failed')
      }
    }

    channel.onopen = sendHello
    if (channel.readyState === 'open') {
      sendHello()
    }

    channel.onmessage = (event) => {
      if (this.isDisposed) return
      const rawData = event.data
      let rawStr: string

      if (typeof rawData === 'string') {
        rawStr = rawData
      } else if (Buffer.isBuffer(rawData)) {
        rawStr = rawData.toString('utf-8')
      } else {
        return
      }

      if (rawStr.length > MAX_CONTROL_MESSAGE_SIZE) {
        void this.cleanupRecord(record, 'failed')
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(rawStr)
      } catch {
        void this.cleanupRecord(record, 'failed')
        return
      }
      if (!record.controlReady) {
        // Physical Hello handshake phase
        if (isPeerHelloMessage(parsed)) {
          if (
            parsed.peerId === record.peerId &&
            parsed.sessionId === record.sessionId
          ) {
            record.controlReady = true
            record.state = 'open'
            if (record.attemptTimer) {
              clearTimeout(record.attemptTimer)
              record.attemptTimer = null
            }
            this.events.onLinkStateChange(record.peerId, 'open', record.path)
            this.detectPath(record).then((path) => {
              if (record.state === 'open') {
                record.path = path
                this.events.onLinkStateChange(record.peerId, 'open', path)
              }
            })
            return
          }
        } else if (
          parsed &&
          typeof parsed === 'object' &&
          (parsed as Record<string, unknown>).v === 1 &&
          (parsed as Record<string, unknown>).type === 'hello'
        ) {
          // Legacy V1 hello accepted
          const h1 = parsed as OverlayHelloMessage
          if (h1.peerId === record.peerId && h1.sessionId === record.sessionId) {
            record.controlReady = true
            record.state = 'open'
            if (record.attemptTimer) {
              clearTimeout(record.attemptTimer)
              record.attemptTimer = null
            }
            this.events.onLinkStateChange(record.peerId, 'open', record.path)
            this.detectPath(record).then((path) => {
              if (record.state === 'open') {
                record.path = path
                this.events.onLinkStateChange(record.peerId, 'open', path)
              }
            })
            return
          }
        }

        // If an operational message arrived before physical hello completed, ignore without tearing down link
        if (isOverlayControlMessageV2(parsed) || isOverlayControlMessage(parsed)) {
          return
        }

        // Malformed non-protocol frame: close link
        void this.cleanupRecord(record, 'failed')
        return
      }

      // Operational phase
      if (isOverlayControlMessageV2(parsed)) {
        if (parsed.type === 'hello') return

        const groupCtx = this.groupContexts.get(parsed.groupId)
        if (!groupCtx) return
        if (parsed.epoch !== groupCtx.epoch) return
        const sender = groupCtx.peers.get(record.peerId)
        if (!sender || sender.membershipId !== parsed.senderMembershipId) return
        this.events.onControlMessage(record.peerId, parsed)
        return
      }

      // Legacy V1 control message support
      if (isOverlayControlMessage(parsed)) {
        const overlayMsg = parsed as OverlayControlMessage
        if (overlayMsg.epoch !== this.legacyEpoch) {
          return
        }
        this.events.onControlMessage(record.peerId, parsed)
        return
      }

      // Malformed operational message
      void this.cleanupRecord(record, 'failed')
    }

    channel.onclose = () => {
      record.controlReady = false
      if (record.state === 'open') {
        record.state = 'failed'
        this.events.onLinkStateChange(record.peerId, 'failed', record.path)
      }
    }
  }

  private async detectPath(record: PeerConnectionRecord): Promise<P2pCandidatePath> {
    try {
      const stats = await record.pc.getStats()
      for (const [, statValue] of stats.entries()) {
        const v = statValue as unknown as Record<string, unknown>
        if (
          v.type === 'candidate-pair' &&
          v.state === 'succeeded' &&
          (v.nominated === true || v.selected === true)
        ) {
          const localCandidate = stats.get(String(v.localCandidateId)) as unknown as Record<string, unknown> | undefined
          const remoteCandidate = stats.get(String(v.remoteCandidateId)) as unknown as Record<string, unknown> | undefined

          if (localCandidate?.candidateType === 'relay' || remoteCandidate?.candidateType === 'relay') {
            return 'relay'
          }
          if (
            (localCandidate?.candidateType === 'host' || localCandidate?.candidateType === 'srflx' || localCandidate?.candidateType === 'prflx') &&
            (remoteCandidate?.candidateType === 'host' || remoteCandidate?.candidateType === 'srflx' || remoteCandidate?.candidateType === 'prflx')
          ) {
            return 'direct'
          }
        }
      }
    } catch {
      // Inconclusive stats
    }
    return 'unknown'
  }

  async handleSignal(
    arg1: string,
    arg2: string,
    arg3: string,
    arg4: string,
    arg5: unknown,
    arg6?: unknown
  ): Promise<void> {
    if (this.isDisposed) return

    let groupId: string | undefined
    let fromPeerId: string
    let fromSessionId: string
    let connectionId: string
    let kind: string
    let payload: unknown

    if (arg6 !== undefined) {
      groupId = arg1
      fromPeerId = arg2
      fromSessionId = arg3
      connectionId = arg4
      kind = arg5 as string
      payload = arg6
    } else {
      fromPeerId = arg1
      fromSessionId = arg2
      connectionId = arg3
      kind = arg4
      payload = arg5
    }

    // Authenticate sender in at least one shared group or legacy roster
    const sharedGroups = this.getSharedGroups(fromPeerId)
    const isLegacySender = this.activeLegacyRoster.get(fromPeerId)?.sessionId === fromSessionId
    if (sharedGroups.length === 0 && !isLegacySender) {
      return
    }

    const record = this.connections.get(fromPeerId)

    if (kind === 'request-offer') {
      if (record && record.sessionId === fromSessionId && (record.state === 'open' || record.state === 'connecting')) {
        return
      }
      if (this.localPeerId < fromPeerId) {
        this.createPeerConnection(fromPeerId, fromSessionId, connectionId, true, groupId)
      }
      return
    }

    if (kind === 'offer') {
      const offerPayload = payload as { type: 'offer'; sdp: string }
      if (!offerPayload?.sdp) return

      if (record && record.sessionId === fromSessionId && record.state === 'open') {
        return
      }

      const newRecord = this.createPeerConnection(fromPeerId, fromSessionId, connectionId, false, groupId)
      try {
        await newRecord.pc.setRemoteDescription(offerPayload)
        const answer = await newRecord.pc.createAnswer()
        await newRecord.pc.setLocalDescription(answer)
        const chosenGroupId = groupId || sharedGroups[0]
        this.events.onSendSignal({
          groupId: chosenGroupId,
          targetPeerId: fromPeerId,
          targetSessionId: fromSessionId,
          connectionId,
          kind: 'answer',
          payload: { type: answer.type, sdp: answer.sdp }
        })
      } catch {
        void this.cleanupRecord(newRecord, 'failed')
      }
      return
    }

    if (kind === 'answer') {
      const answerPayload = payload as { type: 'answer'; sdp: string }
      if (!record || record.attemptId !== connectionId || !answerPayload?.sdp) return
      try {
        await record.pc.setRemoteDescription(answerPayload)
      } catch {
        void this.cleanupRecord(record, 'failed')
      }
      return
    }

    if (kind === 'candidate') {
      if (!record || record.attemptId !== connectionId) return
      try {
        await record.pc.addIceCandidate(payload as RTCIceCandidate)
      } catch {
        // ignore candidate addition error
      }
    }
  }

  sendControl(arg1: string, arg2: string | OverlayControlMessage, arg3?: OverlayControlMessageV2): boolean {
    let targetPeerId: string
    let message: OverlayControlMessage | OverlayControlMessageV2

    if (arg3 !== undefined) {
      targetPeerId = arg2 as string
      message = arg3
    } else {
      targetPeerId = arg1
      message = arg2 as OverlayControlMessage
    }

    const record = this.connections.get(targetPeerId)
    if (!record || !record.controlReady || !record.controlChannel) {
      return false
    }
    try {
      const serialized = JSON.stringify(message)
      record.controlChannel.send(Buffer.from(serialized, 'utf-8'))
      return true
    } catch {
      return false
    }
  }

  async openFileChannel(arg1: string, arg2: string, arg3?: string): Promise<RTCDataChannel> {
    let groupId: string
    let targetPeerId: string
    let transferId: string

    if (arg3 !== undefined) {
      groupId = arg1
      targetPeerId = arg2
      transferId = arg3
    } else {
      groupId = ''
      targetPeerId = arg1
      transferId = arg2
    }

    let record = this.connections.get(targetPeerId)
    if (!record || record.state === 'failed') {
      throw new Error(`Cannot open file channel: peer ${targetPeerId} link is not available`)
    }

    if (record.state === 'connecting') {
      const { promise, resolve, reject } = Promise.withResolvers<void>()
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for peer ${targetPeerId} link to open`))
      }, 10000)

      const checkInterval = setInterval(() => {
        const cur = this.connections.get(targetPeerId)
        if (cur?.state === 'open') {
          clearInterval(checkInterval)
          clearTimeout(timeout)
          resolve()
        } else if (!cur || cur.state === 'failed') {
          clearInterval(checkInterval)
          clearTimeout(timeout)
          reject(new Error(`Peer ${targetPeerId} link failed`))
        }
      }, 50)

      await promise
      record = this.connections.get(targetPeerId)!
    }

    if (record.state !== 'open') {
      throw new Error(`Cannot open file channel: peer ${targetPeerId} link is not open`)
    }

    const channelLabel = groupId
      ? makeFileChannelLabelV2(groupId, transferId)
      : `kazaa-file-v1:${transferId}`

    const channel = record.pc.createDataChannel(channelLabel, {
      ordered: true
    })

    record.activeFileChannels.set(transferId, channel)
    channel.onclose = () => {
      record.activeFileChannels.delete(transferId)
    }

    const { promise, resolve, reject } = Promise.withResolvers<RTCDataChannel>()
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout opening file channel to peer ${targetPeerId}`))
    }, 10000)

    channel.onopen = () => {
      clearTimeout(timeout)
      resolve(channel)
    }
    channel.onerror = (err) => {
      clearTimeout(timeout)
      reject(err instanceof Error ? err : new Error(String(err)))
    }

    if (channel.readyState === 'open') {
      clearTimeout(timeout)
      resolve(channel)
    }

    return promise
  }

  private emitFileChannel(
    groupId: string,
    fromPeerId: string,
    fromSessionId: string,
    transferId: string,
    channel: RTCDataChannel
  ): void {
    const fn = this.events.onFileChannel as unknown as (...args: unknown[]) => void
    if (fn.length <= 3) {
      fn(fromPeerId, transferId, channel)
    } else {
      fn(groupId, fromPeerId, fromSessionId, transferId, channel)
    }
  }

  private async cleanupRecord(record: PeerConnectionRecord, finalState: P2pLinkState): Promise<void> {
    if (record.attemptTimer) {
      clearTimeout(record.attemptTimer)
    }
    record.state = finalState
    record.controlReady = false

    if (record.controlChannel) {
      try {
        record.controlChannel.close()
      } catch {
        // ignore
      }
      record.controlChannel = null
    }

    for (const fc of record.activeFileChannels.values()) {
      try {
        fc.close()
      } catch {
        // ignore
      }
    }
    record.activeFileChannels.clear()

    try {
      await record.pc.close()
    } catch {
      // ignore
    }

    this.events.onLinkStateChange(record.peerId, finalState, record.path)
  }

  async dispose(): Promise<void> {
    if (this.isDisposed) return
    this.isDisposed = true

    const cleanups: Promise<void>[] = []
    for (const record of this.connections.values()) {
      cleanups.push(this.cleanupRecord(record, 'failed'))
    }
    this.connections.clear()
    this.activeLegacyRoster.clear()
    this.groupContexts.clear()
    await Promise.all(cleanups)
  }
}
