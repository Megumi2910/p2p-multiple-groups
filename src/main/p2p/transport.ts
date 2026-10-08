import { RTCPeerConnection, type RTCDataChannel } from 'werift'
import { randomUUID } from 'node:crypto'
import type {
  P2pCandidatePath,
  P2pLinkState,
  P2pPeerLink
} from '../../shared/p2p.ts'
import {
  isOverlayControlMessage,
  type OverlayControlMessage,
  type OverlayHelloMessage,
  type SignalingIceConfig,
  type SignalingRosterPeer,
  MAX_CONTROL_MESSAGE_SIZE
} from '../../shared/p2p-wire.ts'

export interface TransportEvents {
  onControlMessage: (fromPeerId: string, message: OverlayControlMessage) => void
  onFileChannel: (fromPeerId: string, transferId: string, channel: RTCDataChannel) => void
  onLinkStateChange: (peerId: string, state: P2pLinkState, path: P2pCandidatePath) => void
  onSendSignal: (signal: {
    targetPeerId: string
    targetSessionId: string
    connectionId: string
    kind: 'request-offer' | 'offer' | 'answer' | 'candidate'
    payload: unknown
  }) => void
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
}

export class TransportManager {
  private readonly events: TransportEvents
  private readonly connections = new Map<string, PeerConnectionRecord>()
  private localPeerId = ''
  private localSessionId = ''
  private epoch = ''
  private revision = 0
  private iceConfig: SignalingIceConfig = { expiresAt: 0, servers: [] }
  private relayOnly = false
  private activeRoster = new Map<string, SignalingRosterPeer>()
  private isDisposed = false

  constructor(events: TransportEvents) {
    this.events = events
  }

  setSignalingContext(
    epoch: string,
    revision: number,
    localPeerId: string,
    localSessionId: string,
    iceConfig: SignalingIceConfig,
    relayOnly: boolean
  ): void {
    this.epoch = epoch
    this.revision = revision
    this.localPeerId = localPeerId
    this.localSessionId = localSessionId
    this.iceConfig = iceConfig
    this.relayOnly = relayOnly
  }

  updateRoster(activePeers: readonly SignalingRosterPeer[]): void {
    if (this.isDisposed) return
    this.activeRoster.clear()
    const activeIds = new Set<string>()

    for (const p of activePeers) {
      if (p.peerId !== this.localPeerId) {
        this.activeRoster.set(p.peerId, p)
        activeIds.add(p.peerId)
      }
    }

    // Prune connections for departed peers
    for (const [peerId, record] of this.connections.entries()) {
      if (!activeIds.has(peerId)) {
        this.cleanupRecord(record, 'failed')
        this.connections.delete(peerId)
      }
    }

    // Attempt connections to all active peers
    for (const [peerId, peer] of this.activeRoster.entries()) {
      const existing = this.connections.get(peerId)
      if (!existing || existing.sessionId !== peer.sessionId || existing.state === 'failed') {
        if (existing) {
          this.cleanupRecord(existing, 'failed')
          this.connections.delete(peerId)
        }
        this.initiateOrRequestConnection(peer)
      }
    }
  }

  private initiateOrRequestConnection(remotePeer: SignalingRosterPeer): void {
    if (this.isDisposed || !this.localPeerId) return

    const connectionId = randomUUID()
    if (this.localPeerId < remotePeer.peerId) {
      // Lower lexical ID initiates the offer
      this.createPeerConnection(remotePeer.peerId, remotePeer.sessionId, connectionId, true)
    } else {
      // Upper lexical ID requests initiation through signaling
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
    isInitiator: boolean
  ): PeerConnectionRecord {
    const existing = this.connections.get(remotePeerId)
    if (existing) {
      this.cleanupRecord(existing, 'failed')
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

    const pc = new RTCPeerConnection(pcConfig as unknown as object)

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
      activeFileChannels: new Map()
    }

    // Connection attempt deadline: 20s
    record.attemptTimer = setTimeout(() => {
      if (record.state === 'connecting') {
        this.cleanupRecord(record, 'failed')
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

      this.events.onSendSignal({
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
      if (channel.label === 'kazaa-control-v1') {
        record.controlChannel = channel
        this.setupControlChannel(record, channel)
      } else if (channel.label.startsWith('kazaa-file-v1:')) {
        const transferId = channel.label.slice('kazaa-file-v1:'.length)
        record.activeFileChannels.set(transferId, channel)
        channel.onclose = () => {
          record.activeFileChannels.delete(transferId)
        }
        this.events.onFileChannel(remotePeerId, transferId, channel)
      } else {
        // Unknown channel label
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
          this.cleanupRecord(record, 'failed')
        }
      }
    })

    this.connections.set(remotePeerId, record)
    this.events.onLinkStateChange(remotePeerId, 'connecting', 'unknown')

    if (isInitiator) {
      const dc = pc.createDataChannel('kazaa-control-v1', {
        ordered: true
      })
      record.controlChannel = dc
      this.setupControlChannel(record, dc)

      pc.createOffer()
        .then(async (offer) => {
          if (record.attemptId !== connectionId) return
          await pc.setLocalDescription(offer)
          this.events.onSendSignal({
            targetPeerId: remotePeerId,
            targetSessionId: remoteSessionId,
            connectionId,
            kind: 'offer',
            payload: { type: offer.type, sdp: offer.sdp }
          })
        })
        .catch(() => {
          this.cleanupRecord(record, 'failed')
        })
    }

    return record
  }

  private setupControlChannel(record: PeerConnectionRecord, channel: RTCDataChannel): void {
    channel.onopen = () => {
      if (this.isDisposed || !this.localPeerId) return
      // Send Hello handshake
      const hello: OverlayHelloMessage = {
        v: 1,
        type: 'hello',
        epoch: this.epoch,
        revision: this.revision,
        peerId: this.localPeerId,
        sessionId: this.localSessionId
      }
      try {
        channel.send(Buffer.from(JSON.stringify(hello), 'utf-8'))
      } catch {
        this.cleanupRecord(record, 'failed')
      }
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
        // Oversized control frame: close link
        this.cleanupRecord(record, 'failed')
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(rawStr)
      } catch {
        this.cleanupRecord(record, 'failed')
        return
      }

      if (!record.controlReady) {
        // Handshake phase
        if (
          parsed &&
          typeof parsed === 'object' &&
          (parsed as Record<string, unknown>).type === 'hello'
        ) {
          const hello = parsed as OverlayHelloMessage
          if (
            hello.peerId === record.peerId &&
            hello.sessionId === record.sessionId &&
            hello.epoch === this.epoch
          ) {
            record.controlReady = true
            record.state = 'open'
            if (record.attemptTimer) {
              clearTimeout(record.attemptTimer)
              record.attemptTimer = null
            }
            this.detectPath(record).then((path) => {
              record.path = path
              this.events.onLinkStateChange(record.peerId, 'open', path)
            })
            return
          }
        }
        // Bad handshake
        this.cleanupRecord(record, 'failed')
        return
      }

      // Operational phase
      if (isOverlayControlMessage(parsed)) {
        if (parsed.epoch !== this.epoch) {
          // Stale epoch, ignore
          return
        }
        this.events.onControlMessage(record.peerId, parsed)
      } else {
        // Malformed message
        this.cleanupRecord(record, 'failed')
      }
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
    fromPeerId: string,
    fromSessionId: string,
    connectionId: string,
    kind: string,
    payload: unknown
  ): Promise<void> {
    if (this.isDisposed) return

    const rosterPeer = this.activeRoster.get(fromPeerId)
    if (!rosterPeer || rosterPeer.sessionId !== fromSessionId) {
      // Unauthenticated / non-roster sender
      return
    }

    let record = this.connections.get(fromPeerId)

    if (kind === 'request-offer') {
      if (this.localPeerId < fromPeerId) {
        // We are the initiator
        this.createPeerConnection(fromPeerId, fromSessionId, connectionId, true)
      }
      return
    }

    if (kind === 'offer') {
      const offerPayload = payload as { type: 'offer'; sdp: string }
      if (!offerPayload?.sdp) return

      record = this.createPeerConnection(fromPeerId, fromSessionId, connectionId, false)
      try {
        await record.pc.setRemoteDescription(offerPayload)
        const answer = await record.pc.createAnswer()
        await record.pc.setLocalDescription(answer)
        this.events.onSendSignal({
          targetPeerId: fromPeerId,
          targetSessionId: fromSessionId,
          connectionId,
          kind: 'answer',
          payload: { type: answer.type, sdp: answer.sdp }
        })
      } catch {
        this.cleanupRecord(record, 'failed')
      }
      return
    }

    if (kind === 'answer') {
      const answerPayload = payload as { type: 'answer'; sdp: string }
      if (!record || record.attemptId !== connectionId || !answerPayload?.sdp) return
      try {
        await record.pc.setRemoteDescription(answerPayload)
      } catch {
        this.cleanupRecord(record, 'failed')
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

  sendControl(targetPeerId: string, message: OverlayControlMessage): boolean {
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

  async openFileChannel(targetPeerId: string, transferId: string): Promise<RTCDataChannel> {
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

    const channel = record.pc.createDataChannel(`kazaa-file-v1:${transferId}`, {
      ordered: true
    })

    record.activeFileChannels.set(transferId, channel)
    channel.onclose = () => {
      record.activeFileChannels.delete(transferId)
    }

    const { promise, resolve, reject } = Promise.withResolvers<RTCDataChannel>()
    const timeout = setTimeout(() => {
      reject(new Error('File channel open timeout'))
    }, 10000)

    channel.onopen = () => {
      clearTimeout(timeout)
      resolve(channel)
    }
    channel.onerror = (err) => {
      clearTimeout(timeout)
      reject(err)
    }
    return promise
  }

  getLinkState(peerId: string): { state: P2pLinkState; path: P2pCandidatePath } | undefined {
    const record = this.connections.get(peerId)
    if (!record) return undefined
    return { state: record.state, path: record.path }
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

  private async cleanupRecord(record: PeerConnectionRecord, finalState: P2pLinkState): Promise<void> {
    if (record.attemptTimer) {
      clearTimeout(record.attemptTimer)
      record.attemptTimer = null
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

  async closeLink(peerId: string): Promise<void> {
    const record = this.connections.get(peerId)
    if (record) {
      await this.cleanupRecord(record, 'failed')
      this.connections.delete(peerId)
    }
  }

  async dispose(): Promise<void> {
    if (this.isDisposed) return
    this.isDisposed = true

    const cleanups: Promise<void>[] = []
    for (const record of this.connections.values()) {
      cleanups.push(this.cleanupRecord(record, 'failed'))
    }
    this.connections.clear()
    this.activeRoster.clear()
    await Promise.all(cleanups)
  }
}
