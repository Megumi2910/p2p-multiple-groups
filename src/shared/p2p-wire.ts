import type { P2pFileMetadata } from './p2p.ts'

export const MAX_SIGNALING_MESSAGE_SIZE = 131072 // 128 KiB
export const MAX_CONTROL_MESSAGE_SIZE = 16384 // 16 KiB
export const MAX_TRANSFER_CONTROL_SIZE = 1024 // 1 KiB
export const MAX_TRANSFER_CHUNK_SIZE = 16384 // 16 KiB
export const MAX_CATALOG_BATCH_ENTRIES = 32
export const MAX_SEARCH_RESULTS_ENTRIES = 16
export const MAX_SEARCH_QUERY_LENGTH = 120
export const ROSTER_FRESHNESS_LEASE_MS = 6000

export const CONTROL_CHANNEL_LABEL_V2 = 'p2p-multiple-groups-control-v2'
export const FILE_CHANNEL_LABEL_PREFIX_V2 = 'p2p-multiple-groups-file-v2:'

export function makeFileChannelLabelV2(groupId: string, transferId: string): string {
  return `${FILE_CHANNEL_LABEL_PREFIX_V2}${groupId}:${transferId}`
}

export function parseFileChannelLabelV2(label: string): { groupId: string; transferId: string } | null {
  if (typeof label !== 'string' || !label.startsWith(FILE_CHANNEL_LABEL_PREFIX_V2)) {
    return null
  }
  const rest = label.slice(FILE_CHANNEL_LABEL_PREFIX_V2.length)
  const parts = rest.split(':')
  if (parts.length !== 2) return null
  const [groupId, transferId] = parts
  if (!isUuid(transferId) || !/^[A-Za-z0-9_-]{1,32}$/.test(groupId)) {
    return null
  }
  return { groupId, transferId }
}

export interface SignalingIceServer {
  urls: string
  username?: string
  credential?: string
}

export interface SignalingIceConfig {
  expiresAt: number
  servers: SignalingIceServer[]
}

// ==========================================
// V2 Wire Contracts (Group-Aware Multiplexed)
// ==========================================

export interface SignalingRosterPeerV2 {
  peerId: string
  sessionId: string
  membershipId: string
  joinOrder: number
  displayName: string
  supernodeEligible: boolean
}

// Client -> Server signaling messages v2
export type ClientSignalingMessageV2 =
  | {
      v: 2
      type: 'register'
      peerId: string
      displayName: string
    }
  | {
      v: 2
      type: 'create-group'
      groupId: string
      ownerSecret: string
      supernodeEligible: boolean
    }
  | {
      v: 2
      type: 'join-group'
      groupId?: string
      token: string
      ownerSecret?: string
      supernodeEligible: boolean
    }
  | {
      v: 2
      type: 'leave-group'
      groupId: string
    }
  | {
      v: 2
      type: 'rotate-invite'
      groupId: string
      ownerSecret: string
    }
  | {
      v: 2
      type: 'remove-member'
      groupId: string
      targetPeerId: string
      ownerSecret: string
    }
  | {
      v: 2
      type: 'eligibility'
      groupId: string
      supernodeEligible: boolean
    }
  | {
      v: 2
      type: 'profile'
      displayName: string
    }
  | {
      v: 2
      type: 'ice-config'
    }
  | {
      v: 2
      type: 'signal'
      groupId: string
      targetPeerId: string
      targetSessionId: string
      connectionId: string
      kind: 'request-offer' | 'offer' | 'answer' | 'candidate'
      payload: unknown
    }

export interface GroupJoinedMessage {
  v: 2
  type: 'group-joined'
  groupId: string
  membershipId: string
  epoch: string
  revision: number
  peers: SignalingRosterPeerV2[]
  ownerPeerId?: string | null
  inviteCode?: string
}

// Server -> Client signaling messages v2
export type ServerSignalingMessageV2 =
  | {
      v: 2
      type: 'welcome'
      sessionId: string
      iceConfig: SignalingIceConfig
    }
  | GroupJoinedMessage
  | {
      v: 2
      type: 'roster'
      groupId: string
      epoch: string
      revision: number
      peers: SignalingRosterPeerV2[]
      ownerPeerId?: string | null
    }
  | {
      v: 2
      type: 'group-left'
      groupId: string
    }
  | {
      v: 2
      type: 'invite-rotated'
      groupId: string
      inviteCode: string
    }
  | {
      v: 2
      type: 'group-kicked'
      groupId: string
      reason: string
    }
  | {
      v: 2
      type: 'ice-config'
      iceConfig: SignalingIceConfig
    }
  | {
      v: 2
      type: 'signal'
      groupId: string
      fromPeerId: string
      fromSessionId: string
      connectionId: string
      kind: 'request-offer' | 'offer' | 'answer' | 'candidate'
      payload: unknown
    }
  | {
      v: 2
      type: 'error'
      groupId?: string
      code: string
      message: string
    }

// Physical Peer Hello (No group scope)
export interface PeerHelloMessage {
  v: 2
  type: 'hello'
  peerId: string
  sessionId: string
  connectionId: string
}

// Overlay control messages v2 (Scoped to group)
export interface OverlayPingMessageV2 {
  v: 2
  type: 'ping'
  groupId: string
  epoch: string
  revision: number
  senderMembershipId: string
}

export interface OverlayPongMessageV2 {
  v: 2
  type: 'pong'
  groupId: string
  epoch: string
  revision: number
  senderMembershipId: string
}

export interface OverlayCatalogBeginMessageV2 {
  v: 2
  type: 'catalog-begin'
  groupId: string
  epoch: string
  revision: number
  senderMembershipId: string
  generation: number
  count: number
}

export interface OverlayCatalogBatchMessageV2 {
  v: 2
  type: 'catalog-batch'
  groupId: string
  epoch: string
  revision: number
  senderMembershipId: string
  generation: number
  entries: P2pFileMetadata[]
}

export interface OverlayCatalogEndMessageV2 {
  v: 2
  type: 'catalog-end'
  groupId: string
  epoch: string
  revision: number
  senderMembershipId: string
  generation: number
}

export interface OverlayCatalogAckMessageV2 {
  v: 2
  type: 'catalog-ack'
  groupId: string
  epoch: string
  revision: number
  senderMembershipId: string
  generation: number
}

export interface OverlaySearchMessageV2 {
  v: 2
  type: 'search'
  groupId: string
  epoch: string
  revision: number
  senderMembershipId: string
  queryId: string
  query: string
  ttl: number
}

export interface OverlaySearchForwardMessageV2 {
  v: 2
  type: 'search-forward'
  groupId: string
  epoch: string
  revision: number
  senderMembershipId: string
  queryId: string
  query: string
  originPeerId: string
  originMembershipId: string
  ttl: number
}

export interface WireSearchResultEntryV2 {
  ownerPeerId: string
  ownerSessionId: string
  ownerMembershipId?: string
  file: P2pFileMetadata
}

export interface OverlaySearchResultsMessageV2 {
  v: 2
  type: 'search-results'
  groupId: string
  epoch: string
  revision: number
  senderMembershipId: string
  queryId: string
  originPeerId: string
  originMembershipId: string
  responderPeerId: string
  responderMembershipId: string
  entries: WireSearchResultEntryV2[]
  done: boolean
  partial: boolean
}

export type OverlayControlMessageV2 =
  | PeerHelloMessage
  | OverlayPingMessageV2
  | OverlayPongMessageV2
  | OverlayCatalogBeginMessageV2
  | OverlayCatalogBatchMessageV2
  | OverlayCatalogEndMessageV2
  | OverlayCatalogAckMessageV2
  | OverlaySearchMessageV2
  | OverlaySearchForwardMessageV2
  | OverlaySearchResultsMessageV2

// Transfer Control Messages v2 (Scoped to group)
export type TransferControlMessageV2 =
  | {
      v: 2
      type: 'request'
      groupId: string
      transferId: string
      epoch: string
      requesterMembershipId: string
      ownerMembershipId: string
      fileId: string
      size: number
      sha256: string
    }
  | {
      v: 2
      type: 'accepted'
      groupId: string
      transferId: string
      epoch: string
      requesterMembershipId: string
      ownerMembershipId: string
      fileId: string
      size: number
      sha256: string
    }
  | {
      v: 2
      type: 'ack'
      groupId: string
      transferId: string
      receivedBytes: number
    }
  | {
      v: 2
      type: 'end'
      groupId: string
      transferId: string
      size: number
      sha256: string
    }
  | {
      v: 2
      type: 'verified'
      groupId: string
      transferId: string
    }
  | {
      v: 2
      type: 'cancel'
      groupId: string
      transferId: string
    }
  | {
      v: 2
      type: 'error'
      groupId: string
      transferId: string
      code: string
    }

// ==========================================
// Validation Helpers & Type Guards
// ==========================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256_REGEX = /^[0-9a-f]{64}$/
const GROUP_ID_REGEX = /^[A-Za-z0-9_-]{1,32}$/

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value)
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_REGEX.test(value)
}

const INVITE_CODE_REGEX = /^[A-Za-z0-9_-]{8,64}$/

export function isValidInviteCode(val: unknown): val is string {
  return typeof val === 'string' && INVITE_CODE_REGEX.test(val)
}

export function isValidGroupId(value: unknown): value is string {
  return typeof value === 'string' && GROUP_ID_REGEX.test(value)
}

export function isNonNegativeSafeInteger(val: unknown): val is number {
  return typeof val === 'number' && Number.isSafeInteger(val) && val >= 0
}

export function isValidSignalPayload(kind: string, payload: unknown): boolean {
  if (kind === 'request-offer') return payload === null
  if (!payload || typeof payload !== 'object') return false
  const p = payload as Record<string, unknown>

  switch (kind) {
    case 'offer':
    case 'answer':
      return (
        p.type === kind &&
        typeof p.sdp === 'string' &&
        p.sdp.length > 0 &&
        p.sdp.length <= 65536
      )
    case 'candidate':
      if (p.candidate === null || p.candidate === undefined) return true
      return (
        typeof p.candidate === 'string' &&
        p.candidate.length <= 4096 &&
        (p.sdpMid === undefined || p.sdpMid === null || typeof p.sdpMid === 'string') &&
        (p.sdpMLineIndex === undefined ||
          p.sdpMLineIndex === null ||
          (typeof p.sdpMLineIndex === 'number' && Number.isInteger(p.sdpMLineIndex)))
      )
    default:
      return false
  }
}
export function isValidFileMetadata(val: unknown): val is P2pFileMetadata {
  if (!val || typeof val !== 'object') return false
  const r = val as Record<string, unknown>
  if (!isUuid(r.fileId)) return false
  if (typeof r.name !== 'string' || r.name.length === 0 || r.name.length > 255) return false
  if (r.name.includes('/') || r.name.includes('\\') || r.name === '.' || r.name === '..') return false
  if (!isNonNegativeSafeInteger(r.size) || r.size > 1024 * 1024 * 1024) return false
  if (!isSha256(r.sha256)) return false
  return true
}

export function isValidIceConfig(val: unknown): val is SignalingIceConfig {
  if (!val || typeof val !== 'object') return false
  const r = val as Record<string, unknown>
  if (!isNonNegativeSafeInteger(r.expiresAt) || !Array.isArray(r.servers)) return false
  return r.servers.every((s: unknown) => {
    if (!s || typeof s !== 'object') return false
    const srv = s as Record<string, unknown>
    if (typeof srv.urls !== 'string' || srv.urls.length === 0) return false
    if (srv.username !== undefined && typeof srv.username !== 'string') return false
    if (srv.credential !== undefined && typeof srv.credential !== 'string') return false
    return true
  })
}

// ------------------------------------------
// V2 Type Guards
// ------------------------------------------

export function isClientSignalingMessageV2(val: unknown): val is ClientSignalingMessageV2 {
  if (!val || typeof val !== 'object') return false
  const r = val as Record<string, unknown>
  if (r.v !== 2 || typeof r.type !== 'string') return false

  switch (r.type) {
    case 'register':
      return isUuid(r.peerId) && typeof r.displayName === 'string' && r.displayName.length >= 1 && r.displayName.length <= 40
    case 'create-group':
      return (
        isValidGroupId(r.groupId) &&
        typeof r.ownerSecret === 'string' &&
        r.ownerSecret.length >= 8 &&
        r.ownerSecret.length <= 64 &&
        typeof r.supernodeEligible === 'boolean'
      )
    case 'join-group':
      return (
        (r.groupId === undefined || isValidGroupId(r.groupId)) &&
        typeof r.token === 'string' &&
        (r.ownerSecret === undefined || (typeof r.ownerSecret === 'string' && r.ownerSecret.length >= 8 && r.ownerSecret.length <= 64)) &&
        typeof r.supernodeEligible === 'boolean'
      )
    case 'leave-group':
      return isValidGroupId(r.groupId)
    case 'rotate-invite':
      return (
        isValidGroupId(r.groupId) &&
        typeof r.ownerSecret === 'string' &&
        r.ownerSecret.length >= 8 &&
        r.ownerSecret.length <= 64
      )
    case 'remove-member':
      return (
        isValidGroupId(r.groupId) &&
        isUuid(r.targetPeerId) &&
        typeof r.ownerSecret === 'string' &&
        r.ownerSecret.length >= 8 &&
        r.ownerSecret.length <= 64
      )
    case 'eligibility':
      return isValidGroupId(r.groupId) && typeof r.supernodeEligible === 'boolean'
    case 'profile':
      return typeof r.displayName === 'string' && r.displayName.length >= 1 && r.displayName.length <= 40
    case 'ice-config':
      return true
    case 'signal':
      return (
        isValidGroupId(r.groupId) &&
        isUuid(r.targetPeerId) &&
        isUuid(r.targetSessionId) &&
        isUuid(r.connectionId) &&
        (r.kind === 'request-offer' || r.kind === 'offer' || r.kind === 'answer' || r.kind === 'candidate') &&
        isValidSignalPayload(r.kind, r.payload)
      )
    default:
      return false
  }
}

export function isServerSignalingMessageV2(val: unknown): val is ServerSignalingMessageV2 {
  if (!val || typeof val !== 'object') return false
  const r = val as Record<string, unknown>
  if (r.v !== 2 || typeof r.type !== 'string') return false

  switch (r.type) {
    case 'welcome':
      return isUuid(r.sessionId) && isValidIceConfig(r.iceConfig)
    case 'group-joined':
    case 'roster':
      return (
        isValidGroupId(r.groupId) &&
        (r.type !== 'group-joined' || isUuid((r as Record<string, unknown>).membershipId)) &&
        isUuid(r.epoch) &&
        isNonNegativeSafeInteger(r.revision) &&
        (r.ownerPeerId === undefined || r.ownerPeerId === null || isUuid(r.ownerPeerId)) &&
        (r.type !== 'group-joined' || (r as Record<string, unknown>).inviteCode === undefined || isValidInviteCode((r as Record<string, unknown>).inviteCode)) &&
        Array.isArray(r.peers) &&
        r.peers.every(
          (p: unknown) =>
            p &&
            typeof p === 'object' &&
            isUuid((p as Record<string, unknown>).peerId) &&
            isUuid((p as Record<string, unknown>).sessionId) &&
            isUuid((p as Record<string, unknown>).membershipId) &&
            isNonNegativeSafeInteger((p as Record<string, unknown>).joinOrder) &&
            typeof (p as Record<string, unknown>).displayName === 'string' &&
            typeof (p as Record<string, unknown>).supernodeEligible === 'boolean'
        )
      )
    case 'group-left':
      return isValidGroupId(r.groupId)
    case 'invite-rotated':
      return isValidGroupId(r.groupId) && isValidInviteCode(r.inviteCode)
    case 'group-kicked':
      return isValidGroupId(r.groupId) && typeof r.reason === 'string'
    case 'ice-config':
      return isValidIceConfig(r.iceConfig)
    case 'signal':
      return (
        isValidGroupId(r.groupId) &&
        isUuid(r.fromPeerId) &&
        isUuid(r.fromSessionId) &&
        isUuid(r.connectionId) &&
        (r.kind === 'request-offer' || r.kind === 'offer' || r.kind === 'answer' || r.kind === 'candidate') &&
        isValidSignalPayload(r.kind, r.payload)
      )
    case 'error':
      return (
        (r.groupId === undefined || isValidGroupId(r.groupId)) &&
        typeof r.code === 'string' &&
        typeof r.message === 'string'
      )
    default:
      return false
  }
}

export function isPeerHelloMessage(val: unknown): val is PeerHelloMessage {
  if (!val || typeof val !== 'object') return false
  const r = val as Record<string, unknown>
  return r.v === 2 && r.type === 'hello' && isUuid(r.peerId) && isUuid(r.sessionId) && isUuid(r.connectionId)
}

export function isOverlayControlMessageV2(val: unknown): val is OverlayControlMessageV2 {
  if (!val || typeof val !== 'object') return false
  const r = val as Record<string, unknown>
  if (r.v !== 2 || typeof r.type !== 'string') return false

  if (r.type === 'hello') {
    return isPeerHelloMessage(r)
  }

  if (
    !isValidGroupId(r.groupId) ||
    !isUuid(r.epoch) ||
    !isNonNegativeSafeInteger(r.revision) ||
    !isUuid(r.senderMembershipId)
  ) {
    return false
  }

  switch (r.type) {
    case 'ping':
    case 'pong':
      return true
    case 'catalog-begin':
      return isNonNegativeSafeInteger(r.generation) && isNonNegativeSafeInteger(r.count) && r.count <= 1000
    case 'catalog-batch':
      return (
        isNonNegativeSafeInteger(r.generation) &&
        Array.isArray(r.entries) &&
        r.entries.length <= MAX_CATALOG_BATCH_ENTRIES &&
        r.entries.every(isValidFileMetadata)
      )
    case 'catalog-end':
    case 'catalog-ack':
      return isNonNegativeSafeInteger(r.generation)
    case 'search':
      return (
        isUuid(r.queryId) &&
        typeof r.query === 'string' &&
        r.query.length >= 1 &&
        r.query.length <= MAX_SEARCH_QUERY_LENGTH &&
        (r.ttl === 0 || r.ttl === 1)
      )
    case 'search-forward':
      return (
        isUuid(r.queryId) &&
        typeof r.query === 'string' &&
        r.query.length >= 1 &&
        r.query.length <= MAX_SEARCH_QUERY_LENGTH &&
        isUuid(r.originPeerId) &&
        isUuid(r.originMembershipId) &&
        (r.ttl === 0 || r.ttl === 1)
      )
    case 'search-results':
      return (
        isUuid(r.queryId) &&
        isUuid(r.originPeerId) &&
        isUuid(r.originMembershipId) &&
        isUuid(r.responderPeerId) &&
        isUuid(r.responderMembershipId) &&
        Array.isArray(r.entries) &&
        r.entries.length <= MAX_SEARCH_RESULTS_ENTRIES &&
        r.entries.every(
          (e: unknown) =>
            e &&
            typeof e === 'object' &&
            isUuid((e as Record<string, unknown>).ownerPeerId) &&
            isUuid((e as Record<string, unknown>).ownerSessionId) &&
            ((e as Record<string, unknown>).ownerMembershipId === undefined ||
              typeof (e as Record<string, unknown>).ownerMembershipId === 'string') &&
            isValidFileMetadata((e as Record<string, unknown>).file)
        ) &&
        typeof r.done === 'boolean' &&
        typeof r.partial === 'boolean'
      )
    default:
      return false
  }
}

export function isTransferControlMessageV2(val: unknown): val is TransferControlMessageV2 {
  if (!val || typeof val !== 'object') return false
  const r = val as Record<string, unknown>
  if (r.v !== 2 || typeof r.type !== 'string' || !isValidGroupId(r.groupId) || !isUuid(r.transferId)) {
    return false
  }

  switch (r.type) {
    case 'request':
    case 'accepted':
      return (
        isUuid(r.epoch) &&
        isUuid(r.requesterMembershipId) &&
        (isUuid(r.ownerMembershipId) || r.ownerMembershipId === '') &&
        isUuid(r.fileId) &&
        isNonNegativeSafeInteger(r.size) &&
        isSha256(r.sha256)
      )
    case 'ack':
      return isNonNegativeSafeInteger(r.receivedBytes)
    case 'end':
      return isNonNegativeSafeInteger(r.size) && isSha256(r.sha256)
    case 'verified':
    case 'cancel':
      return true
    case 'error':
      return typeof r.code === 'string' && r.code.length <= 64
    default:
      return false
  }
}
