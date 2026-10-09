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
  | 'FORBIDDEN'
  | 'INVITATION_REQUIRED'

export type ActionResult =
  | { ok: true }
  | { ok: false; code: P2pErrorCode; message: string }

export interface NetworkInvitation {
  version: 1
  signalingUrl: string
  roomId: string
  token: string
}

export interface GroupInvitation {
  version: 2
  signalingUrl: string
  groupId: string
  token: string
}

export type GroupKey = string

export function makeGroupKey(signalingUrl: string, groupId: string): GroupKey {
  return JSON.stringify([signalingUrl, groupId])
}

export function parseGroupKey(key: string): { signalingUrl: string; groupId: string } | null {
  if (typeof key !== 'string') return null
  try {
    const parsed = JSON.parse(key) as unknown
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return { signalingUrl: parsed[0], groupId: parsed[1] }
    }
  } catch {
    // ignore parsing failure
  }
  return null
}

export interface ConnectOptions {
  signalingUrl: string
  roomId: string
  token: string
  displayName: string
  supernodeEligible: boolean
  relayOnly: boolean
}

export interface JoinGroupOptions {
  invitation: GroupInvitation
  displayName: string
  supernodeEligible: boolean
  relayOnly: boolean
  rememberInvitation: boolean
  autoJoin?: boolean
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

export interface MultiGroupRosterMember {
  peerId: string
  sessionId: string
  membershipId: string
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

export interface MultiGroupLibraryFile {
  fileId: string
  name: string
  size: number | null
  sha256: string | null
  status: P2pLibraryFileStatus
  message: string | null
  groupKeys: GroupKey[]
}

export interface P2pSearchResult {
  resultId: string
  ownerPeerId: string
  ownerSessionId: string
  ownerName: string
  file: P2pFileMetadata
}

export interface MultiGroupSearchResult {
  resultId: string
  groupKey: GroupKey
  ownerPeerId: string
  ownerSessionId: string
  ownerMembershipId: string
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

export interface MultiGroupTransfer {
  id: string
  groupKey: GroupKey
  groupId: string
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

export interface MultiGroupNetworkState {
  status: P2pNetworkStatus
  peerId: string
  sessionId: string | null
  membershipId: string | null
  displayName: string
  supernodeEligible: boolean
  signalingUrl: string
  groupId: string
  role: P2pRole
  epoch: string | null
  membershipRevision: number
  primaryPeerId: string | null
  standbyPeerId: string | null
  members: MultiGroupRosterMember[]
  links: P2pPeerLink[]
  message: string | null
}

export interface P2pLibraryState {
  status: 'idle' | 'scanning'
  files: P2pLibraryFile[]
  advertisedGeneration: number | null
  acknowledgedGeneration: number | null
}

export interface P2pGroupCatalogState {
  advertisedGeneration: number
  acknowledgedGeneration: number | null
}

export interface P2pSearchState {
  queryId: string | null
  query: string
  status: 'idle' | 'searching' | 'complete' | 'partial' | 'error'
  results: P2pSearchResult[]
  message: string | null
}

export interface P2pGroupState {
  groupKey: GroupKey
  groupId: string
  signalingUrl: string
  autoJoin: boolean
  credentialStatus: 'memory' | 'stored' | 'required'
  network: MultiGroupNetworkState
  catalog: P2pGroupCatalogState
  search: P2pSearchState
  recoveryEvents: P2pRecoveryEvent[]
}

export interface P2pState {
  revision: number
  network: P2pNetworkState
  library: P2pLibraryState
  search: P2pSearchState
  transfers: P2pTransfer[]
  recoveryEvents: P2pRecoveryEvent[]
}

export interface MultiGroupP2pState {
  revision: number
  identity: {
    peerId: string
    displayName: string
  }
  relayOnly: boolean
  groups: P2pGroupState[]
  library: {
    status: 'idle' | 'scanning'
    files: MultiGroupLibraryFile[]
  }
  transfers: MultiGroupTransfer[]
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

export interface P2pMultipleGroupsP2pApi {
  getState(): Promise<MultiGroupP2pState>
  onState(listener: (state: MultiGroupP2pState) => void): () => void
  joinGroup(options: JoinGroupOptions): Promise<ActionResult>
  resumeGroup(groupKey: GroupKey): Promise<ActionResult>
  leaveGroup(groupKey: GroupKey): Promise<ActionResult>
  setGroupAutoJoin(groupKey: GroupKey, autoJoin: boolean): Promise<ActionResult>
  forgetGroup(groupKey: GroupKey): Promise<ActionResult>
  disconnectAll(): Promise<ActionResult>
  addFiles(groupKey: GroupKey | null): Promise<ActionResult>
  rescanLibrary(): Promise<ActionResult>
  removeFile(fileId: string): Promise<ActionResult>
  setFileGroups(fileId: string, groupKeys: GroupKey[]): Promise<ActionResult>
  search(groupKey: GroupKey, query: string): Promise<ActionResult>
  download(groupKey: GroupKey, resultId: string): Promise<ActionResult>
  cancelTransfer(transferId: string): Promise<ActionResult>
}

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const GROUP_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const BASE64URL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
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

export function validateGroupId(groupId: string): { valid: true; value: string } | { valid: false; error: string } {
  if (typeof groupId !== 'string' || !GROUP_ID_PATTERN.test(groupId)) {
    return { valid: false, error: 'Group ID must be 1 to 32 characters of [A-Za-z0-9_-]' }
  }
  return { valid: true, value: groupId }
}

export function validateToken(token: string): { valid: true; value: string } | { valid: false; error: string } {
  if (typeof token !== 'string' || !BASE64URL_TOKEN_PATTERN.test(token)) {
    return { valid: false, error: 'Token must be a 32-byte base64url string' }
  }

  try {
    const base64 = token.replace(/-/g, '+').replace(/_/g, '/') + '='
    if (typeof atob !== 'function' || typeof btoa !== 'function') {
      return { valid: false, error: 'Base64 decoder is not available' }
    }
    const binary = atob(base64)
    if (binary.length !== 32) {
      return { valid: false, error: 'Token must decode to exactly 32 bytes' }
    }

    // Verify canonical representation (no non-zero padding bits)
    const reencoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    if (reencoded !== token) {
      return { valid: false, error: 'Token must be canonical base64url' }
    }
  } catch {
    return { valid: false, error: 'Invalid token format' }
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

export function parseGroupInvitation(raw: string): GroupInvitation | null {
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw.trim()) as unknown
    const result = validateGroupInvitation(parsed)
    return result.valid ? result.value : null
  } catch {
    return null
  }
}

export function validateGroupInvitation(
  invitation: unknown
): { valid: true; value: GroupInvitation } | { valid: false; error: string } {
  if (!invitation || typeof invitation !== 'object') {
    return { valid: false, error: 'Invitation must be an object' }
  }
  const record = invitation as Record<string, unknown>
  const urlCheck = validateSignalingUrl(record.signalingUrl as string)
  if (!urlCheck.valid) return urlCheck
  const tokenCheck = validateToken(record.token as string)
  if (!tokenCheck.valid) return tokenCheck

  if (record.version === 2) {
    const groupCheck = validateGroupId(record.groupId as string)
    if (!groupCheck.valid) return groupCheck
    return {
      valid: true,
      value: {
        version: 2,
        signalingUrl: urlCheck.url,
        groupId: groupCheck.value,
        token: tokenCheck.value
      }
    }
  }

  if (record.version === 1) {
    const roomCheck = validateRoomId(record.roomId as string)
    if (!roomCheck.valid) return roomCheck
    return {
      valid: true,
      value: {
        version: 2,
        signalingUrl: urlCheck.url,
        groupId: roomCheck.value,
        token: tokenCheck.value
      }
    }
  }

  return { valid: false, error: 'Unsupported invitation version' }
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

export function validateJoinGroupOptions(
  options: unknown
): { valid: true; value: JoinGroupOptions } | { valid: false; error: string } {
  if (!options || typeof options !== 'object') {
    return { valid: false, error: 'Join group options must be an object' }
  }
  const record = options as Record<string, unknown>

  const invitationCheck = validateGroupInvitation(record.invitation)
  if (!invitationCheck.valid) return invitationCheck

  const nameCheck = validateDisplayName(record.displayName as string)
  if (!nameCheck.valid) return nameCheck

  if (typeof record.supernodeEligible !== 'boolean') {
    return { valid: false, error: 'supernodeEligible must be a boolean' }
  }
  if (typeof record.relayOnly !== 'boolean') {
    return { valid: false, error: 'relayOnly must be a boolean' }
  }
  if (typeof record.rememberInvitation !== 'boolean') {
    return { valid: false, error: 'rememberInvitation must be a boolean' }
  }
  if (record.autoJoin !== undefined && typeof record.autoJoin !== 'boolean') {
    return { valid: false, error: 'autoJoin must be a boolean' }
  }

  return {
    valid: true,
    value: {
      invitation: invitationCheck.value,
      displayName: nameCheck.value,
      supernodeEligible: record.supernodeEligible,
      relayOnly: record.relayOnly,
      rememberInvitation: record.rememberInvitation,
      autoJoin: typeof record.autoJoin === 'boolean' ? record.autoJoin : true
    }
  }
}
