import { createReadStream, type ReadStream } from 'node:fs'
import { open, stat, rename, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash, type Hash } from 'node:crypto'
import type { RTCDataChannel } from 'werift'
import type {
  P2pCandidatePath,
  MultiGroupTransfer,
  P2pTransferDirection,
  P2pTransferState
} from '../../shared/p2p.ts'
import {
  isTransferControlMessageV2,
  type TransferControlMessageV2,
  MAX_TRANSFER_CHUNK_SIZE
} from '../../shared/p2p-wire.ts'

export const MAX_CONCURRENT_DOWNLOADS = 2
export const MAX_CONCURRENT_UPLOADS = 4
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

export interface ResumableDownloadRecord {
  transferId: string
  groupKey: string
  groupId: string
  epoch: string
  fileId: string
  fileName: string
  destinationPath: string
  partPath: string
  size: number
  sha256: string
  peerId: string
  peerName: string
  transferredBytes: number
  localMembershipId: string
  remoteMembershipId: string
  remoteSessionId: string
  lastRejectedByPeerId?: string
}

export async function preparePartialDownload(
  partPath: string,
  expectedTotalBytes?: number
): Promise<{ fileHandle: FileHandle; startOffset: number; hasher: Hash }> {
  const hasher = createHash('sha256')
  let existingSize = 0
  try {
    const st = await stat(partPath)
    existingSize = st.size
  } catch {
    existingSize = 0
  }

  if (existingSize <= 0 || (expectedTotalBytes !== undefined && existingSize >= expectedTotalBytes)) {
    const fileHandle = await open(partPath, 'w')
    return { fileHandle, startOffset: 0, hasher }
  }

  const fileHandle = await open(partPath, 'r+')
  try {
    const buf = Buffer.allocUnsafe(64 * 1024)
    let pos = 0
    while (pos < existingSize) {
      const toRead = Math.min(buf.byteLength, existingSize - pos)
      const { bytesRead } = await fileHandle.read(buf, 0, toRead, pos)
      if (bytesRead <= 0) break
      hasher.update(buf.subarray(0, bytesRead))
      pos += bytesRead
    }
    if (pos !== existingSize) {
      await fileHandle.truncate(pos)
      existingSize = pos
    }
    return { fileHandle, startOffset: existingSize, hasher }
  } catch (err) {
    await fileHandle.close().catch(() => {})
    throw err
  }
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
  canResume?: boolean
  resumedFromBytes?: number
  lastRejectedByPeerId?: string
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
  private readonly terminalHistory: MultiGroupTransfer[] = []
  private readonly resumableDownloads = new Map<string, ResumableDownloadRecord>()
  private readonly callbacks: TransferCallbacks
  private isDisposed = false

  constructor(callbacks: TransferCallbacks) {
    this.callbacks = callbacks
  }

  getResumableDownload(transferId: string): ResumableDownloadRecord | undefined {
    return this.resumableDownloads.get(transferId)
  }

  removeResumableDownload(transferId: string): void {
    this.resumableDownloads.delete(transferId)
  }

  forceCloseTransferChannel(transferId: string): boolean {
    const session = this.transfers.get(transferId)
    if (session?.channel) {
      session.channel.close()
      return true
    }
    return false
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

  getTransfers(): MultiGroupTransfer[] {
    const list: MultiGroupTransfer[] = []
    for (const t of this.transfers.values()) {
      list.push({
        id: t.id,
        groupKey: t.groupKey,
        groupId: t.groupId,
        direction: t.direction,
        fileName: t.fileName,
        peerId: t.peerId,
        peerName: t.peerName,
        size: t.size,
        transferredBytes: t.transferredBytes,
        sha256: t.sha256,
        state: t.state,
        path: t.path,
        message: t.message,
        canResume: t.canResume,
        resumedFromBytes: t.resumedFromBytes
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
        void this.failTransfer(session, 'Transfer stalled (no progress for 30s)', true)
      }, STALL_TIMEOUT_MS)
    }
  }

  async startDownload(params: {
    transferId: string
    groupKey: string
    groupId: string
    epoch: string
    fileId: string
    fileName: string
    size: number
    sha256: string
    peerId: string
    peerName: string
    destination: string
    openChannel: () => Promise<RTCDataChannel>
    remoteSessionId: string
    localMembershipId: string
    remoteMembershipId: string
    isResume?: boolean
    partPath?: string
  }): Promise<void> {
    if (this.isDisposed) throw new Error('TransferManager is disposed')

    // Concurrency slots globally bounded (max 2 downloads)
    if (this.getActiveDownloadsCount() >= MAX_CONCURRENT_DOWNLOADS) {
      throw new Error('BUSY')
    }

    const authContext: TransferAuthorizationContext = {
      direction: 'download',
      groupKey: params.groupKey,
      fileId: params.fileId,
      epoch: params.epoch,
      requesterPeerId: '',
      requesterSessionId: '',
      requesterMembershipId: params.localMembershipId,
      ownerPeerId: params.peerId,
      ownerSessionId: params.remoteSessionId,
      ownerMembershipId: params.remoteMembershipId
    }

    if (!this.callbacks.isAuthorized(authContext)) {
      throw new Error('NOT_AUTHORIZED')
    }

    // Refuse existing completed destination
    try {
      await stat(params.destination)
      throw new Error('DESTINATION_EXISTS')
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
    }

    const partPath = params.partPath || join(dirname(params.destination), `.p2p-multiple-groups-${params.transferId}.part`)
    let fileHandle: FileHandle
    let startOffset = 0
    let hasher: Hash

    if (params.isResume) {
      try {
        const prep = await preparePartialDownload(partPath, params.size)
        fileHandle = prep.fileHandle
        startOffset = prep.startOffset
        hasher = prep.hasher
      } catch {
        throw new Error('IO_ERROR')
      }
    } else {
      try {
        fileHandle = await open(partPath, 'w')
        hasher = createHash('sha256')
      } catch {
        throw new Error('IO_ERROR')
      }
    }

    const histIdx = this.terminalHistory.findIndex((t) => t.id === params.transferId)
    if (histIdx !== -1) {
      this.terminalHistory.splice(histIdx, 1)
    }

    const session: TransferSession = {
      id: params.transferId,
      direction: 'download',
      fileName: params.fileName,
      peerId: params.peerId,
      peerName: params.peerName,
      size: params.size,
      transferredBytes: startOffset,
      lastAckedBytes: startOffset,
      resumedFromBytes: startOffset,
      sha256: params.sha256,
      state: 'connecting',
      path: this.callbacks.getPeerPath(params.peerId),
      message: startOffset > 0 ? `Resuming from byte ${startOffset}...` : 'Connecting to peer...',
      channel: null,
      stallTimer: null,
      groupKey: params.groupKey,
      groupId: params.groupId,
      epoch: params.epoch,
      fileId: params.fileId,
      remoteSessionId: params.remoteSessionId,
      localMembershipId: params.localMembershipId,
      remoteMembershipId: params.remoteMembershipId,
      authContext,
      destinationPath: params.destination,
      partPath,
      fileHandle,
      hasher,
      canResume: true,
      lastRejectedByPeerId: this.resumableDownloads.get(params.transferId)?.lastRejectedByPeerId
    }

    this.transfers.set(session.id, session)
    this.resetStallTimer(session)
    this.callbacks.onStateChange()
    try {
      const channel = await params.openChannel()
      session.channel = channel
      session.path = this.callbacks.getPeerPath(params.peerId)

      // Recheck authorization after channel opening
      if (!this.callbacks.isAuthorized(authContext)) {
        await this.failTransfer(session, 'Transfer authorization revoked', true)
        return
      }

      this.setupDownloadChannel(session, channel, params.fileId)
    } catch (err) {
      await this.failTransfer(session, `Failed to open file channel: ${err instanceof Error ? err.message : String(err)}`, true)
    }
  }

  private setupDownloadChannel(session: TransferSession, channel: RTCDataChannel, fileId: string): void {
    const requestMsg: TransferControlMessageV2 = {
      v: 2,
      type: 'request',
      groupId: session.groupId,
      transferId: session.id,
      epoch: session.epoch,
      requesterMembershipId: session.localMembershipId,
      ownerMembershipId: session.remoteMembershipId,
      fileId,
      size: session.size,
      sha256: session.sha256,
      ...(session.transferredBytes > 0 ? { offset: session.transferredBytes } : {})
    }

    channel.send(JSON.stringify(requestMsg))

    channel.onmessage = async (event) => {
      if (session.state === 'cancelled' || session.state === 'completed' || session.state === 'failed') return
      this.resetStallTimer(session)
      const data = event.data

      if (typeof data === 'string') {
        if (Buffer.byteLength(data, 'utf-8') > MAX_CONTROL_PAYLOAD_BYTES) {
          await this.failTransfer(session, 'Control message exceeded maximum allowed size (1 KiB)', true)
          return
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(data)
        } catch {
          await this.failTransfer(session, 'Invalid control message from peer', true)
          return
        }
        if (isTransferControlMessageV2(parsed)) {
          if (parsed.groupId !== session.groupId || parsed.transferId !== session.id) {
            await this.failTransfer(session, 'Mismatched group or transfer context', true)
            return
          }

          if (parsed.type === 'accepted') {
            if (parsed.sha256 !== session.sha256 || parsed.size !== session.size) {
              await this.failTransfer(session, 'Remote file metadata mismatch', true)
              return
            }
            const remoteOffset = parsed.offset ?? 0
            if (remoteOffset !== session.transferredBytes) {
              if (remoteOffset === 0 && session.transferredBytes > 0 && session.fileHandle) {
                // Remote peer does not support resume or fell back to 0; restart download from 0
                await session.fileHandle.truncate(0)
                session.hasher = createHash('sha256')
                session.transferredBytes = 0
                session.lastAckedBytes = 0
                session.resumedFromBytes = 0
              } else {
                await this.failTransfer(session, `Remote accepted unexpected offset: ${remoteOffset}`, false)
                return
              }
            }
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
            session.lastRejectedByPeerId = session.peerId
            await this.failTransfer(session, `Remote peer rejected transfer: ${parsed.code}`, true)
            return
          }

          if (parsed.type === 'cancel') {
            await this.cancelSession(session, false)
            return
          }
        } else {
          await this.failTransfer(session, 'Invalid control message from peer', true)
          return
        }
      } else {
        const chunkBuf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)

        if (session.state !== 'transferring') {
          await this.failTransfer(session, 'Received binary frame before acceptance', false)
          return
        }

        if (session.authContext && !this.callbacks.isAuthorized(session.authContext)) {
          await this.failTransfer(session, 'Transfer authorization revoked', false)
          return
        }

        if (chunkBuf.length < 8) {
          await this.failTransfer(session, 'Malformed binary frame (missing offset)', false)
          return
        }

        const offset = Number(chunkBuf.readBigUInt64LE(0))
        const chunk = chunkBuf.subarray(8)

        if (chunk.length > MAX_TRANSFER_CHUNK_SIZE) {
          await this.failTransfer(session, 'Chunk exceeds maximum allowed size', false)
          return
        }
        if (offset !== session.transferredBytes) {
          await this.failTransfer(session, `Offset gap: expected ${session.transferredBytes}, got ${offset}`, false)
          return
        }

        if (session.transferredBytes + chunk.length > session.size) {
          await this.failTransfer(session, 'Transfer exceeded advertised file size', false)
          return
        }

        const chunkOffset = session.transferredBytes
        session.transferredBytes += chunk.length
        session.hasher!.update(chunk)
        this.callbacks.onStateChange()

        // Send ACK after each 256 KiB written or EOF
        if (session.transferredBytes % ACK_INTERVAL_BYTES < chunk.length || session.transferredBytes === session.size) {
          const ackMsg: TransferControlMessageV2 = {
            v: 2,
            type: 'ack',
            groupId: session.groupId,
            transferId: session.id,
            receivedBytes: session.transferredBytes
          }
          channel.send(JSON.stringify(ackMsg))
        }

        session.writeQueue = (session.writeQueue || Promise.resolve())
          .then(async () => {
            if (session.fileHandle) {
              await session.fileHandle.write(chunk, 0, chunk.length, chunkOffset)
            }
          })
          .catch((writeErr) => {
            void this.failTransfer(
              session,
              `Disk write error: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
              true
            )
          })
      }
    }

    channel.addEventListener('close', () => {
      if (session.state === 'transferring' || session.state === 'connecting') {
        void this.failTransfer(session, 'Peer closed connection', true)
      }
    })
  }

  private async finalizeDownload(session: TransferSession): Promise<void> {
    try {
      if (session.writeQueue) {
        await session.writeQueue
      }

      if (session.fileHandle) {
        await session.fileHandle.close()
        session.fileHandle = undefined
      }

      if (session.state !== 'verifying') {
        return
      }

      if (session.authContext && !this.callbacks.isAuthorized(session.authContext)) {
        await this.failTransfer(session, 'Transfer authorization revoked')
        return
      }

      if (session.transferredBytes !== session.size) {
        throw new Error(`Size mismatch: expected ${session.size}, got ${session.transferredBytes}`)
      }

      const digest = session.hasher!.digest('hex')
      if (digest !== session.sha256) {
        throw new Error(`Hash mismatch: expected ${session.sha256}, calculated ${digest}`)
      }

      // Rename atomically to final destination
      await rename(session.partPath!, session.destinationPath!)
      await unlink(session.partPath!).catch(() => {})

      this.resumableDownloads.delete(session.id)
      session.canResume = false
      session.state = 'completed'
      session.message = 'Transfer completed and verified.'
      if (session.stallTimer) {
        clearTimeout(session.stallTimer)
        session.stallTimer = null
      }

      if (session.channel && session.channel.readyState === 'open') {
        const verifiedMsg: TransferControlMessageV2 = {
          v: 2,
          type: 'verified',
          groupId: session.groupId,
          transferId: session.id
        }
        try {
          session.channel.send(JSON.stringify(verifiedMsg))
        } catch {
          // ignore
        }
      }

      this.archiveSession(session)
      this.callbacks.onStateChange()
    } catch (err) {
      await this.failTransfer(session, `Finalization error: ${err instanceof Error ? err.message : String(err)}`, false)
    }
  }

  async handleIncomingChannel(
    fromPeerId: string,
    transferId: string,
    channel: RTCDataChannel,
    channelGroupContext: {
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
      const err: TransferControlMessageV2 = {
        v: 2,
        type: 'error',
        groupId: channelGroupContext.groupId,
        transferId,
        code: 'BUSY'
      }
      try {
        channel.send(JSON.stringify(err))
      } catch {}
      channel.close()
      return
    }

    const existingSession = this.transfers.get(transferId)
    if (existingSession) {
      if (existingSession.stallTimer) {
        clearTimeout(existingSession.stallTimer)
        existingSession.stallTimer = null
      }
      if (existingSession.readStream) {
        try { existingSession.readStream.destroy() } catch {}
        existingSession.readStream = undefined
      }
      if (existingSession.channel && existingSession.channel !== channel) {
        try { existingSession.channel.close() } catch {}
      }
      this.transfers.delete(transferId)
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
      groupKey: channelGroupContext.groupKey,
      groupId: channelGroupContext.groupId,
      epoch: channelGroupContext.epoch,
      fileId: '',
      remoteSessionId: channelGroupContext.remoteSessionId,
      localMembershipId: channelGroupContext.localMembershipId,
      remoteMembershipId: channelGroupContext.remoteMembershipId
    }

    this.transfers.set(session.id, session)
    this.resetStallTimer(session)
    this.callbacks.onStateChange()

    channel.onmessage = async (event) => {
      if (session.state === 'cancelled' || session.state === 'completed' || session.state === 'failed') return
      this.resetStallTimer(session)
      const data = event.data

      if (typeof data !== 'string') {
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
        if (parsed.groupId !== channelGroupContext.groupId || parsed.transferId !== session.id) {
          await this.failTransfer(session, 'Mismatched group context or transfer ID')
          return
        }

        if (parsed.type === 'request') {
          if (session.state !== 'connecting') {
            await this.failTransfer(session, 'Repeated request rejected')
            return
          }

          if (parsed.epoch !== channelGroupContext.epoch) {
            await this.failTransfer(session, 'Mismatched epoch context')
            return
          }
          if (parsed.requesterMembershipId !== channelGroupContext.remoteMembershipId) {
            await this.failTransfer(session, 'Mismatched requester membership')
            return
          }
          if (parsed.ownerMembershipId !== channelGroupContext.localMembershipId) {
            await this.failTransfer(session, 'Mismatched owner membership')
            return
          }

          session.fileId = parsed.fileId
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

          if (!this.callbacks.isAuthorized(authContext)) {
            const err: TransferControlMessageV2 = {
              v: 2,
              type: 'error',
              groupId: parsed.groupId,
              transferId: parsed.transferId,
              code: 'NOT_AUTHORIZED'
            }
            try { channel.send(JSON.stringify(err)) } catch {}
            await this.failTransfer(session, 'File not authorized for transfer')
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

          if (!this.callbacks.isAuthorized(authContext)) {
            const err: TransferControlMessageV2 = {
              v: 2,
              type: 'error',
              groupId: parsed.groupId,
              transferId: parsed.transferId,
              code: 'NOT_AUTHORIZED'
            }
            try { channel.send(JSON.stringify(err)) } catch {}
            await this.failTransfer(session, 'File authorization revoked during check')
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

          const startOffset = parsed.offset ?? 0
          if (
            startOffset < 0 ||
            !Number.isSafeInteger(startOffset) ||
            startOffset > authorized.size ||
            (startOffset === authorized.size && authorized.size > 0)
          ) {
            const err: TransferControlMessageV2 = {
              v: 2,
              type: 'error',
              groupId: parsed.groupId,
              transferId: parsed.transferId,
              code: 'OFFSET_OUT_OF_BOUNDS'
            }
            try { channel.send(JSON.stringify(err)) } catch {}
            await this.failTransfer(session, 'Invalid resume offset', false)
            return
          }

          session.fileName = sanitizeDestinationFileName(authorized.path.split(/[\\/]/).pop() || 'file')
          session.size = authorized.size
          session.sha256 = authorized.sha256
          session.filePath = authorized.path
          session.lastAckedBytes = startOffset
          session.transferredBytes = startOffset
          session.resumedFromBytes = startOffset
          session.state = 'transferring'
          session.message = startOffset > 0 ? `Resuming file data from byte ${startOffset}...` : 'Sending file data...'
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
            sha256: authorized.sha256,
            offset: startOffset
          }
          channel.send(JSON.stringify(acceptedMsg))

          void this.startStreamingUpload(session, channel, authorized.path, startOffset)
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
      } else {
        await this.failTransfer(session, 'Invalid control message from peer')
        return
      }
    }

    channel.addEventListener('close', () => {
      if (session.state === 'transferring' || session.state === 'connecting') {
        void this.failTransfer(session, 'Peer closed connection')
      }
    })
  }

  private async startStreamingUpload(
    session: TransferSession,
    channel: RTCDataChannel,
    filePath: string,
    startOffset = 0
  ): Promise<void> {
    if (session.size === 0 || startOffset >= session.size) {
      const endMsg: TransferControlMessageV2 = {
        v: 2,
        type: 'end',
        groupId: session.groupId,
        transferId: session.id,
        size: session.size,
        sha256: session.sha256
      }
      channel.send(JSON.stringify(endMsg))
      return
    }

    let offset = startOffset
    channel.bufferedAmountLowThreshold = LOW_WATER_BUFFER
    const stream = createReadStream(filePath, { start: startOffset, highWaterMark: CHUNK_SIZE })
    session.readStream = stream

    const resumeIfNeeded = (): void => {
      if (!stream.isPaused()) return
      if (session.authContext && !this.callbacks.isAuthorized(session.authContext)) {
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

    channel.bufferedAmountLow.subscribe(() => {
      resumeIfNeeded()
    })

    stream.on('data', (rawChunk: string | Buffer) => {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
      if (session.state !== 'transferring' || channel.readyState !== 'open') {
        stream.destroy()
        return
      }

      if (session.authContext && !this.callbacks.isAuthorized(session.authContext)) {
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

      const unacked = offset - (session.lastAckedBytes || 0)
      if (channel.bufferedAmount >= HIGH_WATER_BUFFER || unacked >= MAX_UNACK_BYTES) {
        stream.pause()
      }
    })

    stream.on('end', () => {
      if (session.state === 'transferring' && channel.readyState === 'open') {
        const endMsg: TransferControlMessageV2 = {
          v: 2,
          type: 'end',
          groupId: session.groupId,
          transferId: session.id,
          size: session.size,
          sha256: session.sha256
        }
        try {
          channel.send(JSON.stringify(endMsg))
        } catch {}
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
      return
    }
    const resumable = this.resumableDownloads.get(transferId)
    if (resumable) {
      this.resumableDownloads.delete(transferId)
      if (resumable.partPath) {
        await unlink(resumable.partPath).catch(() => {})
      }
      const hist = this.terminalHistory.find((t) => t.id === transferId)
      if (hist) {
        hist.canResume = false
        hist.state = 'cancelled'
        hist.message = 'Transfer cancelled.'
      }
      this.callbacks.onStateChange()
    }
  }

  interruptGroupTransfers(groupKey: string, reason: string): void {
    for (const session of this.transfers.values()) {
      if (session.groupKey === groupKey) {
        const preservePart = session.direction === 'download' && session.transferredBytes > 0
        void this.failTransfer(session, reason, preservePart)
      }
    }
  }

  interruptPeerTransfers(peerId: string, reason: string): void {
    for (const session of this.transfers.values()) {
      if (session.peerId === peerId) {
        const preservePart = session.direction === 'download' && session.transferredBytes > 0
        void this.failTransfer(session, reason, preservePart)
      }
    }
  }

  cancelGroup(groupKey: string): void {
    for (const session of this.transfers.values()) {
      if (session.groupKey === groupKey) {
        void this.cancelSession(session, true)
      }
    }
  }

  cancelFileTransfer(groupKey: string, fileId: string): void {
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
      const ch = session.channel
      if (notifyRemote) {
        try {
          const cancelMsg: TransferControlMessageV2 = {
            v: 2,
            type: 'cancel',
            groupId: session.groupId,
            transferId: session.id
          }
          ch.send(JSON.stringify(cancelMsg))
        } catch {
          // ignore
        }
        setTimeout(() => {
          try {
            if (ch.readyState !== 'closed') {
              ch.close()
            }
          } catch {
            // ignore
          }
        }, 1000).unref?.()
      } else {
        setImmediate(() => {
          try {
            ch.close()
          } catch {
            // ignore
          }
        })
      }
    }

    if (session.writeQueue) {
      try {
        await session.writeQueue
      } catch {}
    }

    if (session.fileHandle) {
      await session.fileHandle.close().catch(() => {})
      session.fileHandle = undefined
    }

    this.resumableDownloads.delete(session.id)
    session.canResume = false

    if (session.partPath) {
      await unlink(session.partPath).catch(() => {})
    }

    this.archiveSession(session)
    this.callbacks.onStateChange()
  }

  private async failTransfer(session: TransferSession, reason: string, preservePart = false): Promise<void> {
    if (session.state === 'completed' || session.state === 'cancelled' || session.state === 'failed') return
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
        const errMsg: TransferControlMessageV2 = {
          v: 2,
          type: 'error',
          groupId: session.groupId,
          transferId: session.id,
          code: reason.slice(0, 64)
        }
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

    if (session.writeQueue) {
      try {
        await session.writeQueue
      } catch {}
    }

    if (session.fileHandle) {
      await session.fileHandle.close().catch(() => {})
      session.fileHandle = undefined
    }

    session.state = 'failed'
    session.message = reason

    const isCurrentSession = this.transfers.get(session.id) === session

    if (preservePart && session.direction === 'download' && session.transferredBytes > 0 && session.partPath && session.destinationPath) {
      session.canResume = true
      const prev = this.resumableDownloads.get(session.id)
      this.resumableDownloads.set(session.id, {
        transferId: session.id,
        groupKey: session.groupKey,
        groupId: session.groupId,
        epoch: session.epoch,
        fileId: session.fileId,
        fileName: session.fileName,
        destinationPath: session.destinationPath,
        partPath: session.partPath,
        size: session.size,
        sha256: session.sha256,
        peerId: session.peerId,
        peerName: session.peerName,
        transferredBytes: session.transferredBytes,
        localMembershipId: session.localMembershipId,
        remoteMembershipId: session.remoteMembershipId,
        remoteSessionId: session.remoteSessionId,
        lastRejectedByPeerId: session.lastRejectedByPeerId || prev?.lastRejectedByPeerId
      })
    } else {
      session.canResume = false
      if (isCurrentSession) {
        this.resumableDownloads.delete(session.id)
      }
      if (session.partPath) {
        await unlink(session.partPath).catch(() => {})
      }
    }

    if (isCurrentSession) {
      this.archiveSession(session)
      this.callbacks.onStateChange()
    }
  }

  private archiveSession(session: TransferSession): void {
    if (this.transfers.get(session.id) === session) {
      this.transfers.delete(session.id)
    }
    this.terminalHistory.unshift({
      id: session.id,
      groupKey: session.groupKey,
      groupId: session.groupId,
      direction: session.direction,
      fileName: session.fileName,
      peerId: session.peerId,
      peerName: session.peerName,
      size: session.size,
      transferredBytes: session.transferredBytes,
      sha256: session.sha256,
      state: session.state,
      path: session.path,
      message: session.message,
      canResume: session.canResume,
      resumedFromBytes: session.resumedFromBytes
    })
    if (this.terminalHistory.length > 50) {
      this.terminalHistory.pop()
    }
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
