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
  | 'GROUP_EXISTS'
  | 'GROUP_FULL'

export type ActionResult =
  | { ok: true }
  | { ok: false; code: P2pErrorCode; message: string }

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

export interface CreateGroupOptions {
  signalingUrl?: string
  groupId: string
  displayName: string
  supernodeEligible: boolean
  autoJoin?: boolean
  relayOnly?: boolean
  rememberInvitation?: boolean
}

export interface JoinGroupOptions {
  invitation?: GroupInvitation
  inviteCode?: string
  signalingUrl?: string
  displayName: string
  supernodeEligible: boolean
  autoJoin?: boolean
  relayOnly?: boolean
  rememberInvitation?: boolean
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

export interface MultiGroupLibraryFile {
  fileId: string
  name: string
  size: number | null
  sha256: string | null
  status: P2pLibraryFileStatus
  message: string | null
  groupKeys: GroupKey[]
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

export interface MultiGroupNetworkState {
  status: P2pNetworkStatus
  peerId: string
  sessionId: string | null
  membershipId: string | null
  displayName: string
  supernodeEligible: boolean
  signalingUrl: string
  groupId: string
  ownerPeerId: string | null
  isOwner: boolean
  role: P2pRole
  epoch: string | null
  membershipRevision: number
  primaryPeerId: string | null
  standbyPeerId: string | null
  members: MultiGroupRosterMember[]
  links: P2pPeerLink[]
  message: string | null
}

export interface P2pGroupCatalogState {
  advertisedGeneration: number
  acknowledgedGeneration: number | null
}

export interface P2pSearchState {
  queryId: string | null
  query: string
  status: 'idle' | 'searching' | 'complete' | 'partial' | 'error'
  results: MultiGroupSearchResult[]
  message: string | null
}

export interface P2pGroupState {
  groupKey: GroupKey
  groupId: string
  signalingUrl: string
  ownerPeerId: string | null
  isOwner: boolean
  inviteCode: string | null
  autoJoin: boolean
  credentialStatus: 'memory' | 'stored' | 'required'
  network: MultiGroupNetworkState
  catalog: P2pGroupCatalogState
  search: P2pSearchState
  recoveryEvents: P2pRecoveryEvent[]
}

export interface MultiGroupP2pState {
  revision: number
  identity: {
    peerId: string
    displayName: string
  }
  defaultSignalingUrl: string
  relayOnly: boolean
  groups: P2pGroupState[]
  library: {
    status: 'idle' | 'scanning'
    files: MultiGroupLibraryFile[]
  }
  transfers: MultiGroupTransfer[]
}

export interface P2pMultipleGroupsP2pApi {
  getState(): Promise<MultiGroupP2pState>
  onState(listener: (state: MultiGroupP2pState) => void): () => void
  createGroup(options: CreateGroupOptions): Promise<ActionResult>
  joinGroup(options: JoinGroupOptions): Promise<ActionResult>
  resumeGroup(groupKey: GroupKey): Promise<ActionResult>
  leaveGroup(groupKey: GroupKey): Promise<ActionResult>
  rotateGroupInvite(groupKey: GroupKey): Promise<ActionResult>
  removeGroupMember(groupKey: GroupKey, targetPeerId: string): Promise<ActionResult>
  setGroupAutoJoin(groupKey: GroupKey, autoJoin: boolean): Promise<ActionResult>
  setGroupEligibility(groupKey: GroupKey, eligible: boolean): Promise<ActionResult>
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

const GROUP_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const BASE64URL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const INVITE_CODE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/
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

export function validateGroupId(groupId: string): { valid: true; value: string } | { valid: false; error: string } {
  if (typeof groupId !== 'string' || !GROUP_ID_PATTERN.test(groupId.trim())) {
    return { valid: false, error: 'Group ID must be 1 to 32 characters of [A-Za-z0-9_-]' }
  }
  return { valid: true, value: groupId.trim() }
}

export function validateToken(token: string): { valid: true; value: string } | { valid: false; error: string } {
  if (typeof token !== 'string' || !BASE64URL_TOKEN_PATTERN.test(token)) {
    return { valid: false, error: 'Token must be a 32-byte base64url string' }
  }

  // Canonical base64url representation check (trailing bits must be 0)
  try {
    const base64 = token.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = atob(base64)
    if (decoded.length !== 32) {
      return { valid: false, error: 'Token must decode to exactly 32 bytes' }
    }
    const reEncoded = btoa(decoded)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    if (reEncoded !== token) {
      return { valid: false, error: 'Token is not canonically encoded' }
    }
  } catch {
    return { valid: false, error: 'Token is not valid base64url' }
  }

  return { valid: true, value: token }
}

export function validateInviteCode(code: string): { valid: true; value: string } | { valid: false; error: string } {
  if (typeof code !== 'string') {
    return { valid: false, error: 'Invite code must be a string' }
  }
  const trimmed = code.trim()
  if (!INVITE_CODE_PATTERN.test(trimmed)) {
    return { valid: false, error: 'Invite code must be 8 to 64 characters of [A-Za-z0-9_-]' }
  }
  return { valid: true, value: trimmed }
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

export function parseGroupInvitation(raw: string, fallbackSignalingUrl?: string): GroupInvitation | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const result = validateGroupInvitation(parsed)
      return result.valid ? result.value : null
    } catch {
      return null
    }
  }

  const codeCheck = validateInviteCode(trimmed)
  if (!codeCheck.valid) return null

  if (!fallbackSignalingUrl) return null
  const urlCheck = validateSignalingUrl(fallbackSignalingUrl)
  if (!urlCheck.valid) return null

  return {
    version: 2,
    signalingUrl: urlCheck.url,
    groupId: '',
    token: codeCheck.value
  }
}

export function validateGroupInvitation(
  invitation: unknown
): { valid: true; value: GroupInvitation } | { valid: false; error: string } {
  if (!invitation || typeof invitation !== 'object') {
    return { valid: false, error: 'Invitation must be an object' }
  }
  const record = invitation as Record<string, unknown>
  if (record.version !== 2) {
    return { valid: false, error: 'Invitation version must be 2' }
  }
  const urlCheck = validateSignalingUrl(record.signalingUrl as string)
  if (!urlCheck.valid) return urlCheck
  const groupCheck = validateGroupId(record.groupId as string)
  if (!groupCheck.valid) return groupCheck
  const tokenCheck = validateInviteCode(record.token as string)
  if (!tokenCheck.valid) return tokenCheck

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

export function validateCreateGroupOptions(
  options: unknown,
  defaultSignalingUrl?: string
): { valid: true; value: CreateGroupOptions & { signalingUrl: string } } | { valid: false; error: string } {
  if (!options || typeof options !== 'object') {
    return { valid: false, error: 'Create group options must be an object' }
  }
  const record = options as Record<string, unknown>
  const groupCheck = validateGroupId(record.groupId as string)
  if (!groupCheck.valid) return groupCheck

  const nameCheck = validateDisplayName(record.displayName as string)
  if (!nameCheck.valid) return nameCheck

  const rawUrl = (record.signalingUrl as string | undefined) || defaultSignalingUrl
  if (!rawUrl) {
    return { valid: false, error: 'Signaling URL is required' }
  }
  const urlCheck = validateSignalingUrl(rawUrl)
  if (!urlCheck.valid) return urlCheck

  if (typeof record.supernodeEligible !== 'boolean') {
    return { valid: false, error: 'supernodeEligible must be a boolean' }
  }
  if (record.relayOnly !== undefined && typeof record.relayOnly !== 'boolean') {
    return { valid: false, error: 'relayOnly must be a boolean' }
  }
  if (record.rememberInvitation !== undefined && typeof record.rememberInvitation !== 'boolean') {
    return { valid: false, error: 'rememberInvitation must be a boolean' }
  }
  if (record.autoJoin !== undefined && typeof record.autoJoin !== 'boolean') {
    return { valid: false, error: 'autoJoin must be a boolean' }
  }

  return {
    valid: true,
    value: {
      signalingUrl: urlCheck.url,
      groupId: groupCheck.value,
      displayName: nameCheck.value,
      supernodeEligible: record.supernodeEligible,
      relayOnly: typeof record.relayOnly === 'boolean' ? record.relayOnly : undefined,
      rememberInvitation: typeof record.rememberInvitation === 'boolean' ? record.rememberInvitation : true,
      autoJoin: typeof record.autoJoin === 'boolean' ? record.autoJoin : true
    }
  }
}

export function validateJoinGroupOptions(
  options: unknown,
  defaultSignalingUrl?: string
): { valid: true; value: JoinGroupOptions & { invitation: GroupInvitation } } | { valid: false; error: string } {
  if (!options || typeof options !== 'object') {
    return { valid: false, error: 'Join group options must be an object' }
  }
  const record = options as Record<string, unknown>

  let invitation: GroupInvitation
  if (record.invitation) {
    const invRecord = record.invitation as Record<string, unknown>
    if (invRecord && typeof invRecord === 'object' && invRecord.version === 2 && invRecord.groupId === '') {
      const urlCheck = validateSignalingUrl(invRecord.signalingUrl as string)
      if (!urlCheck.valid) return urlCheck
      const tokenCheck = validateInviteCode(invRecord.token as string)
      if (!tokenCheck.valid) return tokenCheck
      invitation = {
        version: 2,
        signalingUrl: urlCheck.url,
        groupId: '',
        token: tokenCheck.value
      }
    } else {
      const invitationCheck = validateGroupInvitation(record.invitation)
      if (!invitationCheck.valid) return invitationCheck
      invitation = invitationCheck.value
    }
  } else if (record.inviteCode) {
    const codeCheck = validateInviteCode(record.inviteCode as string)
    if (!codeCheck.valid) return codeCheck
    const rawUrl = (record.signalingUrl as string | undefined) || defaultSignalingUrl
    if (!rawUrl) {
      return { valid: false, error: 'Signaling URL is required' }
    }
    const urlCheck = validateSignalingUrl(rawUrl)
    if (!urlCheck.valid) return urlCheck
    invitation = {
      version: 2,
      signalingUrl: urlCheck.url,
      groupId: '',
      token: codeCheck.value
    }
  } else {
    return { valid: false, error: 'Either invitation or inviteCode is required' }
  }

  const nameCheck = validateDisplayName(record.displayName as string)
  if (!nameCheck.valid) return nameCheck

  if (typeof record.supernodeEligible !== 'boolean') {
    return { valid: false, error: 'supernodeEligible must be a boolean' }
  }
  if (record.relayOnly !== undefined && typeof record.relayOnly !== 'boolean') {
    return { valid: false, error: 'relayOnly must be a boolean' }
  }
  if (record.rememberInvitation !== undefined && typeof record.rememberInvitation !== 'boolean') {
    return { valid: false, error: 'rememberInvitation must be a boolean' }
  }
  if (record.autoJoin !== undefined && typeof record.autoJoin !== 'boolean') {
    return { valid: false, error: 'autoJoin must be a boolean' }
  }

  return {
    valid: true,
    value: {
      invitation,
      displayName: nameCheck.value,
      supernodeEligible: record.supernodeEligible,
      relayOnly: typeof record.relayOnly === 'boolean' ? record.relayOnly : undefined,
      rememberInvitation: typeof record.rememberInvitation === 'boolean' ? record.rememberInvitation : true,
      autoJoin: typeof record.autoJoin === 'boolean' ? record.autoJoin : true
    }
  }
}
