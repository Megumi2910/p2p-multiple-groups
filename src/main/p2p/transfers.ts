import { createReadStream, type ReadStream } from 'node:fs'
import { open, link, unlink, stat, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash, randomUUID, type Hash } from 'node:crypto'
import type { RTCDataChannel } from 'werift'
import type {
  P2pCandidatePath,
  P2pTransfer,
  P2pTransferDirection,
  P2pTransferState
} from '../../shared/p2p.ts'
import {
  isTransferControlMessage,
  isTransferControlMessageV2,
  type TransferControlMessage,
  type TransferControlMessageV2,
  MAX_TRANSFER_CHUNK_SIZE
} from '../../shared/p2p-wire.ts'

export const MAX_CONCURRENT_UPLOADS = 2
export const MAX_CONCURRENT_DOWNLOADS = 2
export const MAX_RECENT_TRANSFERS = 100
const CHUNK_SIZE = 16384 // 16 KiB
const ACK_INTERVAL_BYTES = 256 * 1024 // 256 KiB
const MAX_UNACK_BYTES = 512 * 1024 // 512 KiB
const HIGH_WATER_BUFFER = 256 * 1024 // 256 KiB
const LOW_WATER_BUFFER = 128 * 1024 // 128 KiB
const STALL_TIMEOUT_MS = 30000 // 30s
const MAX_CONTROL_PAYLOAD_BYTES = 1024 // 1 KiB control byte limit

export function sanitizeDestinationFileName(name: string): string {
  let cleaned = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim()
  cleaned = cleaned.replace(/[. ]+$/, '')
  if (!cleaned) cleaned = 'download'
  const upper = cleaned.toUpperCase()
  const base = upper.split('.')[0]
  const reserved = [
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
  ]
  if (reserved.includes(base)) {
    cleaned = `_${cleaned}`
  }
  return cleaned
}

export interface TransferAuthorizationContext {
  direction: P2pTransferDirection
  groupKey: string
  fileId: string
  epoch: string
  requesterPeerId: string
  requesterSessionId: string
  requesterMembershipId: string
  ownerPeerId: string
  ownerSessionId: string
  ownerMembershipId: string
}

export interface TransferCallbacks {
  onStateChange: () => void
  getAuthorizedFile: (context: TransferAuthorizationContext) => Promise<{ path: string; size: number; sha256: string }>
  isAuthorized: (context: TransferAuthorizationContext) => boolean
  getPeerPath: (peerId: string) => P2pCandidatePath
}

interface TransferSession {
  id: string
  direction: P2pTransferDirection
  fileName: string
  peerId: string
  peerName: string
  size: number
  transferredBytes: number
  sha256: string
  state: P2pTransferState
  path: P2pCandidatePath
  message: string | null
  channel: RTCDataChannel | null
  stallTimer: NodeJS.Timeout | null
  groupKey: string
  groupId: string
  epoch: string
  fileId: string
  remoteSessionId: string
  localMembershipId: string
  remoteMembershipId: string
  authContext?: TransferAuthorizationContext
  // Upload-specific
  filePath?: string
  lastAckedBytes?: number
  resumeStream?: () => void
  readStream?: ReadStream
  // Download-specific
  destinationPath?: string
  partPath?: string
  fileHandle?: FileHandle
  hasher?: Hash
  writeQueue?: Promise<void>
}

export class TransferManager {
  private readonly transfers = new Map<string, TransferSession>()
  private readonly terminalHistory: P2pTransfer[] = []
  private readonly callbacks: TransferCallbacks
  private isDisposed = false

  constructor(callbacks: TransferCallbacks) {
    this.callbacks = callbacks
  }

  getActiveUploadsCount(): number {
    let count = 0
    for (const t of this.transfers.values()) {
      if (t.direction === 'upload' && (t.state === 'connecting' || t.state === 'transferring' || t.state === 'verifying')) {
        count++
      }
    }
    return count
  }

  getActiveDownloadsCount(): number {
    let count = 0
    for (const t of this.transfers.values()) {
      if (t.direction === 'download' && (t.state === 'connecting' || t.state === 'transferring' || t.state === 'verifying')) {
        count++
      }
    }
    return count
  }

  getTransfers(): P2pTransfer[] {
    const list: P2pTransfer[] = []
    for (const t of this.transfers.values()) {
      list.push({
        id: t.id,
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
      })
    }
    return [...list, ...this.terminalHistory]
  }

  private resetStallTimer(session: TransferSession): void {
    if (session.stallTimer) {
      clearTimeout(session.stallTimer)
      session.stallTimer = null
    }
    if (session.state === 'transferring' || session.state === 'connecting' || session.state === 'verifying') {
      session.stallTimer = setTimeout(() => {
        void this.failTransfer(session, 'Transfer stalled (no progress for 30s)')
      }, STALL_TIMEOUT_MS)
    }
  }

  async startDownload(params: {
    transferId: string
    groupKey?: string
    groupId?: string
    epoch?: string
    fileId: string
    fileName: string
    size: number
    sha256: string
    peerId: string
    peerName: string
    destination: string
    openChannel: () => Promise<RTCDataChannel>
    remoteSessionId?: string
    localMembershipId?: string
    remoteMembershipId?: string
  }): Promise<void> {
    if (this.isDisposed) throw new Error('TransferManager is disposed')

    // Concurrency slots globally bounded (max 2 downloads)
    if (this.getActiveDownloadsCount() >= MAX_CONCURRENT_DOWNLOADS) {
      throw new Error('BUSY')
    }

    const groupKey = params.groupKey || ''
    const groupId = params.groupId || ''
    const epoch = params.epoch || ''
    const remoteSessionId = params.remoteSessionId || ''
    const localMembershipId = params.localMembershipId || ''
    const remoteMembershipId = params.remoteMembershipId || ''

    const authContext: TransferAuthorizationContext = {
      direction: 'download',
      groupKey,
      fileId: params.fileId,
      epoch,
      requesterPeerId: '',
      requesterSessionId: '',
      requesterMembershipId: localMembershipId,
      ownerPeerId: params.peerId,
      ownerSessionId: remoteSessionId,
      ownerMembershipId: remoteMembershipId
    }

    if (groupKey && !this.callbacks.isAuthorized(authContext)) {
      throw new Error('NOT_AUTHORIZED')
    }

    // Refuse existing destination
    try {
      await stat(params.destination)
      throw new Error('DESTINATION_EXISTS')
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
    }

    // New part files are .p2p-multiple-groups-<transferId>.part (never sweep old .kazaa-* downloads)
    const partPath = join(dirname(params.destination), `.p2p-multiple-groups-${params.transferId}.part`)
    let fileHandle: FileHandle
    try {
      fileHandle = await open(partPath, 'wx')
    } catch {
      throw new Error('IO_ERROR')
    }

    const session: TransferSession = {
      id: params.transferId,
      direction: 'download',
      fileName: params.fileName,
      peerId: params.peerId,
      peerName: params.peerName,
      size: params.size,
      transferredBytes: 0,
      sha256: params.sha256,
      state: 'connecting',
      path: this.callbacks.getPeerPath(params.peerId),
      message: 'Connecting to peer...',
      channel: null,
      stallTimer: null,
      groupKey,
      groupId,
      epoch,
      fileId: params.fileId,
      remoteSessionId,
      localMembershipId,
      remoteMembershipId,
      authContext,
      destinationPath: params.destination,
      partPath,
      fileHandle,
      hasher: createHash('sha256')
    }

    this.transfers.set(session.id, session)
    this.resetStallTimer(session)
    this.callbacks.onStateChange()
    try {
      const channel = await params.openChannel()
      session.channel = channel
      session.path = this.callbacks.getPeerPath(params.peerId)

      // Recheck authorization after channel opening
      if (groupKey && !this.callbacks.isAuthorized(authContext)) {
        await this.failTransfer(session, 'Transfer authorization revoked')
        return
      }

      this.setupDownloadChannel(session, channel, params.fileId)
    } catch (err) {
      await this.failTransfer(session, `Failed to open file channel: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private setupDownloadChannel(session: TransferSession, channel: RTCDataChannel, fileId: string): void {
    const requestMsg: TransferControlMessageV2 | TransferControlMessage = session.groupId
      ? {
          v: 2,
          type: 'request',
          groupId: session.groupId,
          transferId: session.id,
          epoch: session.epoch,
          requesterMembershipId: session.localMembershipId,
          ownerMembershipId: session.remoteMembershipId,
          fileId,
          size: session.size,
          sha256: session.sha256
        }
      : {
          v: 1,
          type: 'request',
          fileId,
          size: session.size,
          sha256: session.sha256
        }

    // Send control message exclusively as RTC text
    channel.send(JSON.stringify(requestMsg))

    channel.onmessage = async (event) => {
      if (session.state === 'cancelled' || session.state === 'completed' || session.state === 'failed') return
      this.resetStallTimer(session)
      const data = event.data

      if (typeof data === 'string') {
        // Control message (RTC text) bounded at 1 KiB
        if (Buffer.byteLength(data, 'utf-8') > MAX_CONTROL_PAYLOAD_BYTES) {
          await this.failTransfer(session, 'Control message exceeded maximum allowed size (1 KiB)')
          return
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(data)
        } catch {
          await this.failTransfer(session, 'Invalid control message from peer')
          return
        }

        if (isTransferControlMessageV2(parsed)) {
          // Verify group and transfer binding
          if (parsed.groupId !== session.groupId || parsed.transferId !== session.id) {
            await this.failTransfer(session, 'Mismatched group or transfer context')
            return
          }

          if (parsed.type === 'accepted') {
            session.state = 'transferring'
            session.message = 'Transfer in progress'
            this.callbacks.onStateChange()
            return
          }

          if (parsed.type === 'end') {
            session.state = 'verifying'
            session.message = 'Verifying file integrity...'
            this.callbacks.onStateChange()
            await this.finalizeDownload(session)
            return
          }

          if (parsed.type === 'error') {
            await this.failTransfer(session, `Remote peer rejected transfer: ${parsed.code}`)
            return
          }

          if (parsed.type === 'cancel') {
            await this.cancelSession(session, false)
            return
          }
        } else if (isTransferControlMessage(parsed)) {
          if (parsed.type === 'accepted') {
            session.state = 'transferring'
            session.message = 'Transfer in progress'
            this.callbacks.onStateChange()
            return
          }

          if (parsed.type === 'end') {
            session.state = 'verifying'
            session.message = 'Verifying file integrity...'
            this.callbacks.onStateChange()
            await this.finalizeDownload(session)
            return
          }

          if (parsed.type === 'error') {
            await this.failTransfer(session, `Remote peer rejected transfer: ${parsed.code}`)
            return
          }

          if (parsed.type === 'cancel') {
            await this.cancelSession(session, false)
            return
          }
        }
      } else {
        // Binary chunk frame exclusively (Buffer or ArrayBuffer)
        const chunkBuf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)

        if (session.state !== 'transferring') {
          await this.failTransfer(session, 'Received binary frame before acceptance')
          return
        }

        // Recheck authorization on chunk receipt
        if (session.authContext && session.groupKey && !this.callbacks.isAuthorized(session.authContext)) {
          await this.failTransfer(session, 'Transfer authorization revoked')
          return
        }

        if (chunkBuf.length < 8) {
          await this.failTransfer(session, 'Malformed binary frame (missing offset)')
          return
        }

        const offset = Number(chunkBuf.readBigUInt64LE(0))
        const chunk = chunkBuf.subarray(8)

        if (chunk.length > MAX_TRANSFER_CHUNK_SIZE) {
          await this.failTransfer(session, 'Chunk exceeds maximum allowed size')
          return
        }
        if (offset !== session.transferredBytes) {
          await this.failTransfer(session, `Offset gap: expected ${session.transferredBytes}, got ${offset}`)
          return
        }

        if (session.transferredBytes + chunk.length > session.size) {
          await this.failTransfer(session, 'Transfer exceeded advertised file size')
          return
        }

        session.transferredBytes += chunk.length
        session.hasher!.update(chunk)
        this.callbacks.onStateChange()

        // Send ACK after each 256 KiB written or EOF
        if (session.transferredBytes % ACK_INTERVAL_BYTES < chunk.length || session.transferredBytes === session.size) {
          const ackMsg: TransferControlMessageV2 | TransferControlMessage = session.groupId
            ? {
                v: 2,
                type: 'ack',
                groupId: session.groupId,
                transferId: session.id,
                receivedBytes: session.transferredBytes
              }
            : {
                v: 1,
                type: 'ack',
                receivedBytes: session.transferredBytes
              }
          channel.send(JSON.stringify(ackMsg))
        }

        session.writeQueue = (session.writeQueue || Promise.resolve())
          .then(async () => {
            if (session.fileHandle) {
              await session.fileHandle.write(chunk)
            }
          })
          .catch((writeErr) => {
            void this.failTransfer(
              session,
              `Disk write error: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`
            )
          })
      }
    }

    channel.onclose = () => {
      if (session.state === 'transferring' || session.state === 'connecting' || session.state === 'verifying') {
        void this.failTransfer(session, 'Connection closed unexpectedly')
      }
    }
  }

  private async finalizeDownload(session: TransferSession): Promise<void> {
    if (session.state === 'completed' || session.state === 'failed' || session.state === 'cancelled') return

    // Recheck authorization before final publication
    if (session.authContext && session.groupKey && !this.callbacks.isAuthorized(session.authContext)) {
      await this.failTransfer(session, 'Transfer authorization revoked before publication')
      return
    }

    try {
      if (session.writeQueue) {
        await session.writeQueue
      }
      if (session.fileHandle) {
        await session.fileHandle.sync()
        await session.fileHandle.close()
        session.fileHandle = undefined
      }

      if (session.transferredBytes !== session.size) {
        await this.failTransfer(session, `Size mismatch: expected ${session.size}, got ${session.transferredBytes}`)
        return
      }

      const digest = session.hasher!.digest('hex')
      if (digest !== session.sha256) {
        await this.failTransfer(session, `SHA-256 mismatch: expected ${session.sha256}, got ${digest}`)
        return
      }

      // Atomic publication: hard-link .part file to final destination
      try {
        await link(session.partPath!, session.destinationPath!)
      } catch (linkErr: unknown) {
        const code = (linkErr as NodeJS.ErrnoException).code
        if (code === 'EEXIST') {
          await this.failTransfer(session, 'Destination file already exists')
          return
        }
        await this.failTransfer(session, 'Destination filesystem does not support atomic publication')
        return
      }

      // Remove .part file
      await unlink(session.partPath!).catch(() => {})

      session.state = 'completed'
      session.message = 'Transfer completed and verified.'
      if (session.stallTimer) {
        clearTimeout(session.stallTimer)
        session.stallTimer = null
      }

      if (session.channel && session.channel.readyState === 'open') {
        const verifiedMsg: TransferControlMessageV2 | TransferControlMessage = session.groupId
          ? {
              v: 2,
              type: 'verified',
              groupId: session.groupId,
              transferId: session.id
            }
          : { v: 1, type: 'verified' }
        try {
          session.channel.send(JSON.stringify(verifiedMsg))
        } catch {
          // ignore
        }
      }

      this.archiveSession(session)
      this.callbacks.onStateChange()
    } catch (err) {
      await this.failTransfer(session, `Finalization error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async handleIncomingChannel(
    fromPeerId: string,
    transferId: string,
    channel: RTCDataChannel,
    channelGroupContext?: {
      groupKey: string
      groupId: string
      epoch: string
      localMembershipId: string
      remoteSessionId: string
      remoteMembershipId: string
    }
  ): Promise<void> {
    if (this.isDisposed) {
      channel.close()
      return
    }

    // Reserve concurrency slot before asynchronous authorization
    if (this.getActiveUploadsCount() >= MAX_CONCURRENT_UPLOADS) {
      const err = channelGroupContext?.groupId
        ? { v: 2, type: 'error', groupId: channelGroupContext.groupId, transferId, code: 'BUSY' }
        : { v: 1, type: 'error', code: 'BUSY' }
      try {
        channel.send(JSON.stringify(err))
      } catch {}
      channel.close()
      return
    }

    const session: TransferSession = {
      id: transferId,
      direction: 'upload',
      fileName: 'upload',
      peerId: fromPeerId,
      peerName: `Peer-${fromPeerId.slice(0, 6)}`,
      size: 0,
      transferredBytes: 0,
      sha256: '',
      state: 'connecting',
      path: this.callbacks.getPeerPath(fromPeerId),
      message: 'Incoming request...',
      channel,
      stallTimer: null,
      groupKey: channelGroupContext?.groupKey || '',
      groupId: channelGroupContext?.groupId || '',
      epoch: channelGroupContext?.epoch || '',
      fileId: '',
      remoteSessionId: channelGroupContext?.remoteSessionId || '',
      localMembershipId: channelGroupContext?.localMembershipId || '',
      remoteMembershipId: channelGroupContext?.remoteMembershipId || ''
    }

    this.transfers.set(session.id, session)
    this.resetStallTimer(session)
    this.callbacks.onStateChange()

    channel.onmessage = async (event) => {
      if (session.state === 'cancelled' || session.state === 'completed' || session.state === 'failed') return
      this.resetStallTimer(session)
      const data = event.data

      if (typeof data !== 'string') {
        // Uploader does not accept binary frames from downloader
        return
      }

      if (Buffer.byteLength(data, 'utf-8') > MAX_CONTROL_PAYLOAD_BYTES) {
        await this.failTransfer(session, 'Control message exceeded maximum allowed size (1 KiB)')
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch {
        return
      }

      if (isTransferControlMessageV2(parsed)) {
        if (session.groupId && parsed.groupId !== session.groupId) {
          await this.failTransfer(session, 'Mismatched group context')
          return
        }
        if (parsed.transferId !== session.id) {
          await this.failTransfer(session, 'Mismatched transfer ID')
          return
        }

        if (parsed.type === 'request') {
          // Context is immutable after first accepted request
          if (session.state !== 'connecting') {
            await this.failTransfer(session, 'Repeated request rejected')
            return
          }

          session.fileId = parsed.fileId
          session.groupKey = session.groupKey || channelGroupContext?.groupKey || ''
          session.groupId = parsed.groupId
          session.epoch = parsed.epoch

          const authContext: TransferAuthorizationContext = {
            direction: 'upload',
            groupKey: session.groupKey,
            fileId: parsed.fileId,
            epoch: parsed.epoch,
            requesterPeerId: fromPeerId,
            requesterSessionId: session.remoteSessionId,
            requesterMembershipId: parsed.requesterMembershipId,
            ownerPeerId: '',
            ownerSessionId: '',
            ownerMembershipId: session.localMembershipId
          }
          session.authContext = authContext

          // Authorization check before acceptance
          if (session.groupKey && !this.callbacks.isAuthorized(authContext)) {
            const err: TransferControlMessageV2 = {
              v: 2,
              type: 'error',
              groupId: parsed.groupId,
              transferId: parsed.transferId,
              code: 'NOT_FOUND'
            }
            try { channel.send(JSON.stringify(err)) } catch {}
            await this.failTransfer(session, 'File not authorized')
            return
          }

          let authorized: { path: string; size: number; sha256: string }
          try {
            authorized = await this.callbacks.getAuthorizedFile(authContext)
          } catch {
            const err: TransferControlMessageV2 = {
              v: 2,
              type: 'error',
              groupId: parsed.groupId,
              transferId: parsed.transferId,
              code: 'NOT_FOUND'
            }
            try { channel.send(JSON.stringify(err)) } catch {}
            await this.failTransfer(session, 'File not authorized or modified on disk')
            return
          }

          // Recheck authorization after awaited file validation
          if (session.groupKey && !this.callbacks.isAuthorized(authContext)) {
            const err: TransferControlMessageV2 = {
              v: 2,
              type: 'error',
              groupId: parsed.groupId,
              transferId: parsed.transferId,
              code: 'NOT_FOUND'
            }
            try { channel.send(JSON.stringify(err)) } catch {}
            await this.failTransfer(session, 'File not authorized')
            return
          }

          if (authorized.size !== parsed.size || authorized.sha256 !== parsed.sha256) {
            const err: TransferControlMessageV2 = {
              v: 2,
              type: 'error',
              groupId: parsed.groupId,
              transferId: parsed.transferId,
              code: 'FILE_CHANGED'
            }
            try { channel.send(JSON.stringify(err)) } catch {}
            await this.failTransfer(session, 'File changed on disk')
            return
          }

          session.fileName = sanitizeDestinationFileName(authorized.path.split(/[\\/]/).pop() || 'file')
          session.size = authorized.size
          session.sha256 = authorized.sha256
          session.filePath = authorized.path
          session.lastAckedBytes = 0
          session.state = 'transferring'
          session.message = 'Sending file data...'
          this.callbacks.onStateChange()

          const acceptedMsg: TransferControlMessageV2 = {
            v: 2,
            type: 'accepted',
            groupId: parsed.groupId,
            transferId: parsed.transferId,
            epoch: parsed.epoch,
            requesterMembershipId: parsed.requesterMembershipId,
            ownerMembershipId: session.localMembershipId,
            fileId: parsed.fileId,
            size: authorized.size,
            sha256: authorized.sha256
          }
          channel.send(JSON.stringify(acceptedMsg))

          void this.startStreamingUpload(session, channel, authorized.path)
          return
        }

        if (parsed.type === 'ack') {
          session.lastAckedBytes = parsed.receivedBytes
          session.transferredBytes = parsed.receivedBytes
          this.callbacks.onStateChange()
          session.resumeStream?.()
          return
        }

        if (parsed.type === 'verified') {
          session.state = 'completed'
          session.message = 'Transfer completed and verified by receiver.'
          if (session.stallTimer) {
            clearTimeout(session.stallTimer)
            session.stallTimer = null
          }
          this.archiveSession(session)
          this.callbacks.onStateChange()
          return
        }

        if (parsed.type === 'cancel') {
          await this.cancelSession(session, false)
          return
        }
      } else if (isTransferControlMessage(parsed)) {
        if (parsed.type === 'request') {
          if (session.state !== 'connecting') {
            await this.failTransfer(session, 'Repeated request rejected')
            return
          }

          session.fileId = parsed.fileId
          const authContext: TransferAuthorizationContext = {
            direction: 'upload',
            groupKey: session.groupKey,
            fileId: parsed.fileId,
            epoch: session.epoch,
            requesterPeerId: fromPeerId,
            requesterSessionId: session.remoteSessionId,
            requesterMembershipId: session.remoteMembershipId,
            ownerPeerId: '',
            ownerSessionId: '',
            ownerMembershipId: session.localMembershipId
          }
          session.authContext = authContext

          let authorized: { path: string; size: number; sha256: string }
          try {
            authorized = await this.callbacks.getAuthorizedFile(authContext)
          } catch {
            const err: TransferControlMessage = { v: 1, type: 'error', code: 'NOT_FOUND' }
            try { channel.send(JSON.stringify(err)) } catch {}
            await this.failTransfer(session, 'File not authorized or modified on disk')
            return
          }

          if (authorized.size !== parsed.size || authorized.sha256 !== parsed.sha256) {
            const err: TransferControlMessage = { v: 1, type: 'error', code: 'FILE_CHANGED' }
            try { channel.send(JSON.stringify(err)) } catch {}
            await this.failTransfer(session, 'File changed on disk')
            return
          }

          session.fileName = sanitizeDestinationFileName(authorized.path.split(/[\\/]/).pop() || 'file')
          session.size = authorized.size
          session.sha256 = authorized.sha256
          session.filePath = authorized.path
          session.lastAckedBytes = 0
          session.state = 'transferring'
          session.message = 'Sending file data...'
          this.callbacks.onStateChange()

          const accepted: TransferControlMessage = {
            v: 1,
            type: 'accepted',
            size: authorized.size,
            sha256: authorized.sha256
          }
          channel.send(JSON.stringify(accepted))

          void this.startStreamingUpload(session, channel, authorized.path)
          return
        }

        if (parsed.type === 'ack') {
          session.lastAckedBytes = parsed.receivedBytes
          session.transferredBytes = parsed.receivedBytes
          this.callbacks.onStateChange()
          session.resumeStream?.()
          return
        }

        if (parsed.type === 'verified') {
          session.state = 'completed'
          session.message = 'Transfer completed and verified by receiver.'
          if (session.stallTimer) {
            clearTimeout(session.stallTimer)
            session.stallTimer = null
          }
          this.archiveSession(session)
          this.callbacks.onStateChange()
          return
        }

        if (parsed.type === 'cancel') {
          await this.cancelSession(session, false)
          return
        }
      }
    }

    channel.onclose = () => {
      if (session.state === 'transferring' || session.state === 'connecting') {
        void this.failTransfer(session, 'Peer closed connection')
      }
    }
  }

  private async startStreamingUpload(
    session: TransferSession,
    channel: RTCDataChannel,
    filePath: string
  ): Promise<void> {
    if (session.size === 0) {
      // Zero-byte file: send end immediately
      const endMsg: TransferControlMessageV2 | TransferControlMessage = session.groupId
        ? {
            v: 2,
            type: 'end',
            groupId: session.groupId,
            transferId: session.id,
            size: 0,
            sha256: session.sha256
          }
        : {
            v: 1,
            type: 'end',
            size: 0,
            sha256: session.sha256
          }
      channel.send(JSON.stringify(endMsg))
      return
    }

    let offset = 0
    channel.bufferedAmountLowThreshold = LOW_WATER_BUFFER
    const stream = createReadStream(filePath, { highWaterMark: CHUNK_SIZE })
    session.readStream = stream

    const resumeIfNeeded = (): void => {
      if (!stream.isPaused()) return
      if (session.authContext && session.groupKey && !this.callbacks.isAuthorized(session.authContext)) {
        stream.destroy()
        void this.failTransfer(session, 'Transfer authorization revoked')
        return
      }
      const curUnacked = offset - (session.lastAckedBytes || 0)
      if (channel.bufferedAmount <= LOW_WATER_BUFFER && curUnacked < MAX_UNACK_BYTES) {
        stream.resume()
      }
    }
    session.resumeStream = resumeIfNeeded

    const sub = channel.bufferedAmountLow.subscribe(() => {
      resumeIfNeeded()
    })

    stream.on('data', (rawChunk: string | Buffer) => {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
      if (session.state !== 'transferring' || channel.readyState !== 'open') {
        stream.destroy()
        return
      }

      // Recheck authorization before each upload frame
      if (session.authContext && session.groupKey && !this.callbacks.isAuthorized(session.authContext)) {
        stream.destroy()
        void this.failTransfer(session, 'Transfer authorization revoked')
        return
      }

      const frame = Buffer.allocUnsafe(8 + chunk.length)
      frame.writeBigUInt64LE(BigInt(offset), 0)
      chunk.copy(frame, 8)
      offset += chunk.length

      channel.send(frame)
      this.resetStallTimer(session)

      // Backpressure management
      const unacked = offset - (session.lastAckedBytes || 0)
      if (channel.bufferedAmount >= HIGH_WATER_BUFFER || unacked >= MAX_UNACK_BYTES) {
        stream.pause()
      }
    })

    stream.on('end', () => {
      if (session.state === 'transferring' && channel.readyState === 'open') {
        const endMsg: TransferControlMessageV2 | TransferControlMessage = session.groupId
          ? {
              v: 2,
              type: 'end',
              groupId: session.groupId,
              transferId: session.id,
              size: session.size,
              sha256: session.sha256
            }
          : {
              v: 1,
              type: 'end',
              size: session.size,
              sha256: session.sha256
            }
        channel.send(JSON.stringify(endMsg))
      }
    })

    stream.on('error', (err) => {
      void this.failTransfer(session, `Stream read error: ${err.message}`)
    })
  }

  async cancelTransfer(transferId: string): Promise<void> {
    const session = this.transfers.get(transferId)
    if (session) {
      await this.cancelSession(session, true)
    }
  }

  cancelGroup(groupKey: string): void {
    for (const session of this.transfers.values()) {
      if (session.groupKey === groupKey) {
        void this.cancelSession(session, true)
      }
    }
  }

  cancelFileGrant(groupKey: string, fileId: string): void {
    for (const session of this.transfers.values()) {
      if (session.groupKey === groupKey && session.fileId === fileId) {
        void this.cancelSession(session, true)
      }
    }
  }

  cancelPeerSessions(peerId: string): void {
    for (const session of this.transfers.values()) {
      if (session.peerId === peerId) {
        void this.cancelSession(session, true)
      }
    }
  }

  private async cancelSession(session: TransferSession, notifyRemote: boolean): Promise<void> {
    if (session.state === 'cancelled') return
    session.state = 'cancelled'
    session.message = 'Transfer cancelled.'
    if (session.stallTimer) {
      clearTimeout(session.stallTimer)
      session.stallTimer = null
    }

    if (session.readStream) {
      try {
        session.readStream.destroy()
      } catch {}
      session.readStream = undefined
    }

    if (session.channel && session.channel.readyState === 'open') {
      if (notifyRemote) {
        try {
          const cancelMsg: TransferControlMessageV2 | TransferControlMessage = session.groupId
            ? {
                v: 2,
                type: 'cancel',
                groupId: session.groupId,
                transferId: session.id
              }
            : { v: 1, type: 'cancel' }
          session.channel.send(JSON.stringify(cancelMsg))
        } catch {
          // ignore
        }
      }
      try {
        session.channel.close()
      } catch {
        // ignore
      }
    }

    if (session.fileHandle) {
      await session.fileHandle.close().catch(() => {})
      session.fileHandle = undefined
    }

    if (session.partPath) {
      await unlink(session.partPath).catch(() => {})
    }

    this.archiveSession(session)
    this.callbacks.onStateChange()
  }

  private async failTransfer(session: TransferSession, reason: string): Promise<void> {
    if (session.state === 'completed' || session.state === 'cancelled' || session.state === 'failed') return
    session.state = 'failed'
    session.message = reason
    if (session.stallTimer) {
      clearTimeout(session.stallTimer)
      session.stallTimer = null
    }

    if (session.readStream) {
      try {
        session.readStream.destroy()
      } catch {}
      session.readStream = undefined
    }

    if (session.channel && session.channel.readyState === 'open') {
      try {
        const errMsg: TransferControlMessageV2 | TransferControlMessage = session.groupId
          ? {
              v: 2,
              type: 'error',
              groupId: session.groupId,
              transferId: session.id,
              code: reason
            }
          : { v: 1, type: 'error', code: reason }
        session.channel.send(JSON.stringify(errMsg))
      } catch {
        // ignore
      }
      try {
        session.channel.close()
      } catch {
        // ignore
      }
    }

    if (session.fileHandle) {
      await session.fileHandle.close().catch(() => {})
      session.fileHandle = undefined
    }

    if (session.partPath) {
      await unlink(session.partPath).catch(() => {})
    }

    this.archiveSession(session)
    this.callbacks.onStateChange()
  }

  private archiveSession(session: TransferSession): void {
    this.terminalHistory.unshift({
      id: session.id,
      direction: session.direction,
      fileName: session.fileName,
      peerId: session.peerId,
      peerName: session.peerName,
      size: session.size,
      transferredBytes: session.transferredBytes,
      sha256: session.sha256,
      state: session.state,
      path: session.path,
      message: session.message
    })

    if (this.terminalHistory.length > MAX_RECENT_TRANSFERS) {
      this.terminalHistory.pop()
    }

    this.transfers.delete(session.id)
  }

  async dispose(): Promise<void> {
    if (this.isDisposed) return
    this.isDisposed = true

    for (const session of this.transfers.values()) {
      await this.cancelSession(session, false)
    }
    this.transfers.clear()
    this.terminalHistory.length = 0
  }
}
