export type P2pErrorCode =
  | 'INVALID_INPUT'
  | 'AUTH_FAILED'
  | 'DISCONNECTED'
  | 'NO_SUPERNODE'
  | 'UNREACHABLE'
  | 'NOT_FOUND'
  | 'FILE_CHANGED'
  | 'DESTINATION_EXISTS'
  | 'IO_ERROR'
  | 'BUSY'
  | 'PROTOCOL_ERROR'

export type ActionResult =
  | { ok: true }
  | { ok: false; code: P2pErrorCode; message: string }

export interface NetworkInvitation {
  version: 1
  signalingUrl: string
  roomId: string
  token: string
}

export interface ConnectOptions {
  signalingUrl: string
  roomId: string
  token: string
  displayName: string
  supernodeEligible: boolean
  relayOnly: boolean
}

export type P2pRole = 'ordinary' | 'supernode'

export type P2pNetworkStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'recovering'
  | 'degraded'
  | 'error'

export type P2pLinkState = 'connecting' | 'open' | 'failed'

export type P2pCandidatePath = 'direct' | 'relay' | 'unknown'

export interface P2pPeerLink {
  peerId: string
  state: P2pLinkState
  path: P2pCandidatePath
}

export interface P2pRosterMember {
  peerId: string
  sessionId: string
  joinOrder: number
  displayName: string
  supernodeEligible: boolean
  role: P2pRole
}

export interface P2pFileMetadata {
  fileId: string
  name: string
  size: number
  sha256: string
}

export type P2pLibraryFileStatus = 'hashing' | 'shared' | 'unavailable' | 'error'

export interface P2pLibraryFile {
  fileId: string
  name: string
  size: number | null
  sha256: string | null
  status: P2pLibraryFileStatus
  message: string | null
}

export interface P2pSearchResult {
  resultId: string
  ownerPeerId: string
  ownerSessionId: string
  ownerName: string
  file: P2pFileMetadata
}

export type P2pTransferDirection = 'upload' | 'download'

export type P2pTransferState =
  | 'connecting'
  | 'transferring'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface P2pTransfer {
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
}

export type P2pRecoveryEventType =
  | 'supernode-lost'
  | 'role-changed'
  | 'route-changed'
  | 'index-ready'
  | 'membership-unavailable'
  | 'recovered'

export interface P2pRecoveryEvent {
  id: string
  at: string
  type: P2pRecoveryEventType
  peerIds: string[]
  epoch: string | null
  membershipRevision: number
  durationMs: number | null
  message: string
}

export interface P2pNetworkState {
  status: P2pNetworkStatus
  peerId: string
  sessionId: string | null
  displayName: string
  supernodeEligible: boolean
  signalingUrl: string
  roomId: string
  role: P2pRole
  epoch: string | null
  membershipRevision: number
  primaryPeerId: string | null
  standbyPeerId: string | null
  members: P2pRosterMember[]
  links: P2pPeerLink[]
  message: string | null
}

export interface P2pLibraryState {
  status: 'idle' | 'scanning'
  files: P2pLibraryFile[]
  advertisedGeneration: number | null
  acknowledgedGeneration: number | null
}

export interface P2pSearchState {
  queryId: string | null
  query: string
  status: 'idle' | 'searching' | 'complete' | 'partial' | 'error'
  results: P2pSearchResult[]
  message: string | null
}

export interface P2pState {
  revision: number
  network: P2pNetworkState
  library: P2pLibraryState
  search: P2pSearchState
  transfers: P2pTransfer[]
  recoveryEvents: P2pRecoveryEvent[]
}

export interface KazaaP2pApi {
  getState(): Promise<P2pState>
  onState(listener: (state: P2pState) => void): () => void
  connect(options: ConnectOptions): Promise<ActionResult>
  disconnect(): Promise<ActionResult>
  setSupernodeEligible(eligible: boolean): Promise<ActionResult>
  addFiles(): Promise<ActionResult>
  rescanLibrary(): Promise<ActionResult>
  removeFile(fileId: string): Promise<ActionResult>
  search(query: string): Promise<ActionResult>
  download(resultId: string): Promise<ActionResult>
  cancelTransfer(transferId: string): Promise<ActionResult>
}

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const BASE64URL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{42,44}$/
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/

export function validateSignalingUrl(rawUrl: string): { valid: true; url: string } | { valid: false; error: string } {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return { valid: false, error: 'Signaling URL is required' }
  }
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { valid: false, error: 'Invalid signaling URL format' }
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: 'Signaling URL must not contain credentials' }
  }
  if (parsed.search || parsed.hash) {
    return { valid: false, error: 'Signaling URL must not contain query parameters or fragments' }
  }
  if (parsed.pathname !== '/signal') {
    return { valid: false, error: 'Signaling URL pathname must be /signal' }
  }

  const hostname = parsed.hostname
  if (parsed.protocol === 'ws:') {
    if (hostname !== '127.0.0.1' && hostname !== '[::1]' && hostname !== 'localhost') {
      return { valid: false, error: 'Insecure ws: protocol is permitted only for loopback addresses' }
    }
  } else if (parsed.protocol === 'wss:') {
    // wss is valid for any host
  } else {
    return { valid: false, error: 'Signaling URL protocol must be wss: (or ws: on loopback)' }
  }

  return { valid: true, url: parsed.toString().replace(/\/$/, '') }
}

export function validateRoomId(roomId: string): { valid: true; value: string } | { valid: false; error: string } {
  if (typeof roomId !== 'string' || !ROOM_ID_PATTERN.test(roomId)) {
    return { valid: false, error: 'Room ID must be 1 to 32 characters of [A-Za-z0-9_-]' }
  }
  return { valid: true, value: roomId }
}

export function validateToken(token: string): { valid: true; value: string } | { valid: false; error: string } {
  if (typeof token !== 'string' || !BASE64URL_TOKEN_PATTERN.test(token)) {
    return { valid: false, error: 'Token must be a 32-byte base64url string' }
  }
  return { valid: true, value: token }
}

export function validateDisplayName(name: string): { valid: true; value: string } | { valid: false; error: string } {
  if (typeof name !== 'string') {
    return { valid: false, error: 'Display name must be a string' }
  }
  const trimmed = name.trim()
  if (trimmed.length < 1 || trimmed.length > 40) {
    return { valid: false, error: 'Display name must be 1 to 40 characters' }
  }
  if (CONTROL_CHAR_PATTERN.test(trimmed)) {
    return { valid: false, error: 'Display name must not contain control characters' }
  }
  return { valid: true, value: trimmed }
}

export function parseNetworkInvitation(raw: string): NetworkInvitation | null {
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw.trim()) as unknown
    const result = validateInvitation(parsed)
    return result.valid ? result.value : null
  } catch {
    return null
  }
}

export function validateInvitation(
  invitation: unknown
): { valid: true; value: NetworkInvitation } | { valid: false; error: string } {
  if (!invitation || typeof invitation !== 'object') {
    return { valid: false, error: 'Invitation must be an object' }
  }
  const record = invitation as Record<string, unknown>
  if (record.version !== 1) {
    return { valid: false, error: 'Invitation version must be 1' }
  }
  const urlCheck = validateSignalingUrl(record.signalingUrl as string)
  if (!urlCheck.valid) return urlCheck
  const roomCheck = validateRoomId(record.roomId as string)
  if (!roomCheck.valid) return roomCheck
  const tokenCheck = validateToken(record.token as string)
  if (!tokenCheck.valid) return tokenCheck

  return {
    valid: true,
    value: {
      version: 1,
      signalingUrl: urlCheck.url,
      roomId: roomCheck.value,
      token: tokenCheck.value
    }
  }
}

export function validateConnectOptions(
  options: unknown
): { valid: true; value: ConnectOptions } | { valid: false; error: string } {
  if (!options || typeof options !== 'object') {
    return { valid: false, error: 'Connect options must be an object' }
  }
  const record = options as Record<string, unknown>
  const urlCheck = validateSignalingUrl(record.signalingUrl as string)
  if (!urlCheck.valid) return urlCheck
  const roomCheck = validateRoomId(record.roomId as string)
  if (!roomCheck.valid) return roomCheck
  const tokenCheck = validateToken(record.token as string)
  if (!tokenCheck.valid) return tokenCheck
  const nameCheck = validateDisplayName(record.displayName as string)
  if (!nameCheck.valid) return nameCheck

  return {
    valid: true,
    value: {
      signalingUrl: urlCheck.url,
      roomId: roomCheck.value,
      token: tokenCheck.value,
      displayName: nameCheck.value,
      supernodeEligible: Boolean(record.supernodeEligible),
      relayOnly: Boolean(record.relayOnly)
    }
  }
}
