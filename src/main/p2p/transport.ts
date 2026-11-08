import { RTCPeerConnection, type RTCDataChannel } from 'werift'
import { randomUUID } from 'node:crypto'
import type {
  P2pCandidatePath,
  P2pLinkState,
  P2pPeerLink
} from '../../shared/p2p.ts'
import {
  isOverlayControlMessageV2,
  isPeerHelloMessage,
  parseFileChannelLabelV2,
  makeFileChannelLabelV2,
  CONTROL_CHANNEL_LABEL_V2,
  FILE_CHANNEL_LABEL_PREFIX_V2,
  type OverlayControlMessageV2,
  type PeerHelloMessage,
  type SignalingIceConfig,
  type SignalingRosterPeerV2,
  MAX_CONTROL_MESSAGE_SIZE,
  ROSTER_FRESHNESS_LEASE_MS
} from '../../shared/p2p-wire.ts'

export type V2OnFileChannelCallback = (
  groupId: string,
  fromPeerId: string,
  fromSessionId: string,
  transferId: string,
  channel: RTCDataChannel
) => void

export interface TransportEvents {
  onControlMessage: (fromPeerId: string, message: OverlayControlMessageV2) => void
  onFileChannel: V2OnFileChannelCallback
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
  renewedAt: number
}

export class TransportManager {
  private readonly events: TransportEvents
  private readonly options: TransportManagerOptions
  private readonly connections = new Map<string, PeerConnectionRecord>() // peerId -> record

  private localPeerId: string = ''
  private localSessionId: string = ''
  private iceConfig: SignalingIceConfig = { expiresAt: 0, servers: [] }
  private relayOnly = false
  private readonly groupContexts = new Map<string, GroupContext>()
  private isDisposed = false

  constructor(events: TransportEvents, options: TransportManagerOptions = {}) {
    this.events = events
    this.options = options
  }

  // ==========================================
  // Context & Roster Lifecycle
  // ==========================================

  setPeerContext(
    localPeerId: string,
    localSessionId: string,
    iceConfig: SignalingIceConfig,
    relayOnly: boolean
  ): void {
    if (this.isDisposed) return
    this.localPeerId = localPeerId
    this.localSessionId = localSessionId
    this.iceConfig = iceConfig
    this.relayOnly = relayOnly
  }

  setRelayOnly(relayOnly: boolean): void {
    if (this.isDisposed) return
    this.relayOnly = relayOnly
  }

  setIceConfig(iceConfig: SignalingIceConfig): void {
    if (this.isDisposed) return
    this.iceConfig = iceConfig
  }

  updateGroupContext(
    groupId: string,
    epoch: string,
    revision: number,
    peers: readonly SignalingRosterPeerV2[],
    fresh: boolean
  ): void {
    this.updateGroupRoster(groupId, epoch, revision, peers, fresh)
  }

  updateGroupRoster(
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

    const existing = this.groupContexts.get(groupId)
    if (existing) {
      existing.epoch = epoch
      existing.revision = revision
      existing.peers = peerMap
      existing.fresh = fresh
      existing.renewedAt = Date.now()
    } else {
      this.groupContexts.set(groupId, {
        groupId,
        epoch,
        revision,
        peers: peerMap,
        fresh,
        renewedAt: Date.now()
      })
    }

    this.reconcileConnections()
  }

  setGroupFreshness(groupId: string, fresh: boolean): void {
    if (this.isDisposed) return
    const group = this.groupContexts.get(groupId)
    if (group) {
      group.fresh = fresh
      if (fresh) {
        group.renewedAt = Date.now()
      }
    }
  }

  removeGroupContext(groupId: string): void {
    if (this.isDisposed) return
    this.groupContexts.delete(groupId)
    this.reconcileConnections()
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

    // Prune connections for peers no longer in any active group
    for (const [peerId, record] of this.connections.entries()) {
      if (!activeUnion.has(peerId)) {
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
    const freshShared = shared.filter((g) => this.isGroupFresh(g))
    const chosenGroupId = freshShared[0] || shared[0] || ''
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

  private isGroupFresh(groupId: string): boolean {
    const group = this.groupContexts.get(groupId)
    if (!group) return false
    if (!group.fresh) return false
    return Date.now() - group.renewedAt < ROSTER_FRESHNESS_LEASE_MS
  }

  // ==========================================
  // WebRTC Connection Setup
  // ==========================================

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
    const config = {
      iceServers: this.iceConfig.servers.map((s) => ({
        urls: s.urls,
        username: s.username,
        credential: s.credential
      })),
      iceTransportPolicy: this.relayOnly ? ('relay' as const) : ('all' as const)
    }

    const pc = this.options.connectionFactory ? this.options.connectionFactory(config) : new RTCPeerConnection(config)

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

    // Enforce 10s handshake timeout
    record.attemptTimer = setTimeout(() => {
      if (this.connections.get(remotePeerId) === record && record.state !== 'open') {
        void this.cleanupRecord(record, 'failed')
        this.connections.delete(remotePeerId)
      }
    }, 10000)

    pc.onicecandidate = (event) => {
      if (!event.candidate || record.attemptId !== connectionId) return
      if (record.candidateCount >= 64) return // Candidate rate/volume ceiling
      record.candidateCount++
      const candidateObj =
        typeof (event.candidate as { toJSON?: () => unknown }).toJSON === 'function'
          ? (event.candidate as { toJSON: () => unknown }).toJSON()
          : event.candidate

      const shared = this.getSharedGroups(remotePeerId)
      const freshShared = shared.filter((g) => this.isGroupFresh(g))
      const sigGroupId = (record.negotiationGroupId && this.isGroupFresh(record.negotiationGroupId))
        ? record.negotiationGroupId
        : freshShared[0] || record.negotiationGroupId || shared[0]

      this.events.onSendSignal({
        groupId: sigGroupId,
        targetPeerId: remotePeerId,
        targetSessionId: remoteSessionId,
        connectionId,
        kind: 'candidate',
        payload: candidateObj
      })
    }

    pc.ondatachannel = (event) => {
      const channel = event.channel
      if (channel.label === CONTROL_CHANNEL_LABEL_V2) {
        record.controlChannel = channel
        this.setupControlChannel(record, channel)
      } else if (channel.label.startsWith(FILE_CHANNEL_LABEL_PREFIX_V2)) {
        const parsed = parseFileChannelLabelV2(channel.label)
        if (parsed) {
          if (!this.isGroupFresh(parsed.groupId)) {
            try {
              channel.close()
            } catch {
              // ignore
            }
            return
          }
          record.activeFileChannels.set(parsed.transferId, channel)
          channel.onclose = () => {
            record.activeFileChannels.delete(parsed.transferId)
          }
          this.events.onFileChannel(parsed.groupId, remotePeerId, remoteSessionId, parsed.transferId, channel)
        } else {
          try {
            channel.close()
          } catch {
            // ignore
          }
        }
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
          const freshShared = shared.filter((g) => this.isGroupFresh(g))
          const sigGroupId = (record.negotiationGroupId && this.isGroupFresh(record.negotiationGroupId))
            ? record.negotiationGroupId
            : freshShared[0] || record.negotiationGroupId || shared[0]

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

      const helloV2: PeerHelloMessage = {
        v: 2,
        type: 'hello',
        peerId: this.localPeerId,
        sessionId: this.localSessionId,
        connectionId: record.attemptId
      }

      try {
        channel.send(Buffer.from(JSON.stringify(helloV2), 'utf-8'))
      } catch {
        // ignore send error
      }
    }

    if (channel.readyState === 'open') {
      sendHello()
    } else {
      channel.onopen = () => {
        sendHello()
      }
    }

    channel.onmessage = (event) => {
      if (this.isDisposed) return
      const raw = event.data

      if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) {
        return
      }

      const byteLen = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf-8') : raw.length
      if (byteLen > MAX_CONTROL_MESSAGE_SIZE) {
        // Exceeds max control frame size
        void this.cleanupRecord(record, 'failed')
        return
      }

      let parsed: unknown
      try {
        const str = typeof raw === 'string' ? raw : raw.toString('utf-8')
        parsed = JSON.parse(str)
      } catch {
        // Invalid JSON frame
        void this.cleanupRecord(record, 'failed')
        return
      }

      // Handshake phase: expect physical hello
      if (!record.controlReady) {
        if (isPeerHelloMessage(parsed)) {
          if (
            parsed.peerId === record.peerId &&
            parsed.sessionId === record.sessionId &&
            parsed.connectionId === record.attemptId
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
        }

        // If an operational message arrived before physical hello completed, ignore without tearing down link
        if (isOverlayControlMessageV2(parsed)) {
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
        if (!this.isGroupFresh(parsed.groupId)) return
        if (parsed.epoch !== groupCtx.epoch) return
        const sender = groupCtx.peers.get(record.peerId)
        if (!sender || sender.membershipId !== parsed.senderMembershipId) return
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
    return this.relayOnly ? 'relay' : 'unknown'
  }

  // ==========================================
  // Public Signaling & Control Dispatch
  // ==========================================

  async handleSignal(
    groupId: string,
    fromPeerId: string,
    fromSessionId: string,
    connectionId: string,
    kind: string,
    payload: unknown
  ): Promise<void> {
    if (this.isDisposed) return
    if (groupId && !this.isGroupFresh(groupId)) return

    // Authenticate sender in at least one shared group
    const sharedGroups = this.getSharedGroups(fromPeerId)
    if (sharedGroups.length === 0) {
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
        const freshShared = sharedGroups.filter((g) => this.isGroupFresh(g))
        const chosenGroupId = (groupId && this.isGroupFresh(groupId))
          ? groupId
          : freshShared[0] || groupId || sharedGroups[0]
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

  sendControl(groupId: string, targetPeerId: string, message: OverlayControlMessageV2): boolean {
    if (!this.isGroupFresh(groupId)) {
      return false
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

  async waitForLinkOpen(peerId: string, timeoutMs: number = 10000): Promise<void> {
    if (this.isDisposed) {
      throw new Error('TransportManager is disposed')
    }

    const current = this.connections.get(peerId)
    if (current && current.state === 'open' && current.controlReady) {
      return
    }
    if (current?.state === 'failed') {
      throw new Error(`Link to peer ${peerId} is not available`)
    }

    const initialSessionId = current?.sessionId
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    let settled = false

    const cleanup = () => {
      if (settled) return
      settled = true
      clearInterval(interval)
      clearTimeout(timer)
    }

    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timeout waiting for link to peer ${peerId} to open`))
    }, timeoutMs)

    const interval = setInterval(() => {
      if (this.isDisposed) {
        cleanup()
        reject(new Error('TransportManager disposed while waiting for link'))
        return
      }
      const rec = this.connections.get(peerId)
      if (rec?.state === 'failed' || (initialSessionId && !rec) || (initialSessionId && rec && rec.sessionId !== initialSessionId)) {
        cleanup()
        reject(new Error(`Link to peer ${peerId} failed during wait`))
        return
      }
      if (rec && rec.state === 'open' && rec.controlReady) {
        cleanup()
        resolve()
      }
    }, 50)

    return promise
  }

  async openFileChannel(groupId: string, targetPeerId: string, transferId: string): Promise<RTCDataChannel> {
    if (!this.isGroupFresh(groupId)) {
      throw new Error(`Cannot open file channel: group "${groupId}" authority expired`)
    }

    const record = this.connections.get(targetPeerId)
    if (!record || record.state === 'failed') {
      throw new Error(`Cannot open file channel: peer ${targetPeerId} link is not available`)
    }

    if (record.state === 'connecting') {
      await this.waitForLinkOpen(targetPeerId, 10000)
    }

    const currentRecord = this.connections.get(targetPeerId)
    if (!currentRecord || currentRecord.state !== 'open') {
      throw new Error(`Cannot open file channel: peer ${targetPeerId} link is not open`)
    }
    if (!this.isGroupFresh(groupId)) {
      throw new Error(`Cannot open file channel: group "${groupId}" authority expired`)
    }

    const channelLabel = makeFileChannelLabelV2(groupId, transferId)

    const channel = currentRecord.pc.createDataChannel(channelLabel, {
      ordered: true
    })

    currentRecord.activeFileChannels.set(transferId, channel)
    channel.onclose = () => {
      currentRecord.activeFileChannels.delete(transferId)
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
    this.groupContexts.clear()
    await Promise.all(cleanups)
  }
}
