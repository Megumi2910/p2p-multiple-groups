import type { P2pFileMetadata } from './p2p.ts'

export const MAX_SIGNALING_MESSAGE_SIZE = 131072 // 128 KiB
export const MAX_CONTROL_MESSAGE_SIZE = 16384 // 16 KiB
export const MAX_TRANSFER_CONTROL_SIZE = 1024 // 1 KiB
export const MAX_TRANSFER_CHUNK_SIZE = 16384 // 16 KiB
export const MAX_CATALOG_BATCH_ENTRIES = 32
export const MAX_SEARCH_RESULTS_ENTRIES = 16
export const MAX_SEARCH_QUERY_LENGTH = 120

export interface SignalingIceServer {
  urls: string
  username?: string
  credential?: string
}

export interface SignalingIceConfig {
  expiresAt: number
  servers: SignalingIceServer[]
}

export interface SignalingRosterPeer {
  peerId: string
  sessionId: string
  joinOrder: number
  displayName: string
  supernodeEligible: boolean
}

// Client -> Server signaling messages
export type ClientSignalingMessage =
  | {
      v: 1
      type: 'join'
      roomId: string
      peerId: string
      displayName: string
      supernodeEligible: boolean
    }
  | {
      v: 1
      type: 'eligibility'
      supernodeEligible: boolean
    }
  | {
      v: 1
      type: 'leave'
    }
  | {
      v: 1
      type: 'ice-config'
    }
  | {
      v: 1
      type: 'signal'
      targetPeerId: string
      targetSessionId: string
      connectionId: string
      kind: 'request-offer' | 'offer' | 'answer' | 'candidate'
      payload: unknown
    }

// Server -> Client signaling messages
export type ServerSignalingMessage =
  | {
      v: 1
      type: 'welcome'
      sessionId: string
      epoch: string
      iceConfig: SignalingIceConfig
    }
  | {
      v: 1
      type: 'roster'
      epoch: string
      revision: number
      peers: SignalingRosterPeer[]
    }
  | {
      v: 1
      type: 'ice-config'
      iceConfig: SignalingIceConfig
    }
  | {
      v: 1
      type: 'signal'
      fromPeerId: string
      fromSessionId: string
      connectionId: string
      kind: 'request-offer' | 'offer' | 'answer' | 'candidate'
      payload: unknown
    }
  | {
      v: 1
      type: 'error'
      code: string
      message: string
    }

// Overlay control messages (kazaa-control-v1)
export interface OverlayHelloMessage {
  v: 1
  type: 'hello'
  epoch: string
  revision: number
  peerId: string
  sessionId: string
}

export interface OverlayPingMessage {
  v: 1
  type: 'ping'
  epoch: string
  revision: number
}

export interface OverlayPongMessage {
  v: 1
  type: 'pong'
  epoch: string
  revision: number
}

export interface OverlayCatalogBeginMessage {
  v: 1
  type: 'catalog-begin'
  epoch: string
  revision: number
  generation: number
  count: number
}

export interface OverlayCatalogBatchMessage {
  v: 1
  type: 'catalog-batch'
  epoch: string
  revision: number
  generation: number
  entries: P2pFileMetadata[]
}

export interface OverlayCatalogEndMessage {
  v: 1
  type: 'catalog-end'
  epoch: string
  revision: number
  generation: number
}

export interface OverlayCatalogAckMessage {
  v: 1
  type: 'catalog-ack'
  epoch: string
  revision: number
  generation: number
}

export interface OverlaySearchMessage {
  v: 1
  type: 'search'
  epoch: string
  revision: number
  queryId: string
  query: string
  ttl: number
}

export interface OverlaySearchForwardMessage {
  v: 1
  type: 'search-forward'
  epoch: string
  revision: number
  queryId: string
  query: string
  originPeerId: string
  ttl: number
}

export interface WireSearchResultEntry {
  ownerPeerId: string
  ownerSessionId: string
  file: P2pFileMetadata
}

export interface OverlaySearchResultsMessage {
  v: 1
  type: 'search-results'
  epoch: string
  revision: number
  queryId: string
  originPeerId: string
  entries: WireSearchResultEntry[]
  done: boolean
  partial: boolean
}

export type OverlayControlMessage =
  | OverlayHelloMessage
  | OverlayPingMessage
  | OverlayPongMessage
  | OverlayCatalogBeginMessage
  | OverlayCatalogBatchMessage
  | OverlayCatalogEndMessage
  | OverlayCatalogAckMessage
  | OverlaySearchMessage
  | OverlaySearchForwardMessage
  | OverlaySearchResultsMessage

// File transfer messages (kazaa-file-v1)
export type TransferControlMessage =
  | { v: 1; type: 'request'; fileId: string; size: number; sha256: string }
  | { v: 1; type: 'accepted'; size: number; sha256: string }
  | { v: 1; type: 'ack'; receivedBytes: number }
  | { v: 1; type: 'end'; size: number; sha256: string }
  | { v: 1; type: 'verified' }
  | { v: 1; type: 'cancel' }
  | { v: 1; type: 'error'; code: string }

// Validation helpers & type guards
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256_REGEX = /^[0-9a-f]{64}$/

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value)
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_REGEX.test(value)
}

export function isValidFileMetadata(val: unknown): val is P2pFileMetadata {
  if (!val || typeof val !== 'object') return false
  const r = val as Record<string, unknown>
  if (!isUuid(r.fileId)) return false
  if (typeof r.name !== 'string' || r.name.length === 0 || r.name.length > 255) return false
  if (r.name.includes('/') || r.name.includes('\\') || r.name === '.' || r.name === '..') return false
  if (typeof r.size !== 'number' || !Number.isInteger(r.size) || r.size < 0 || r.size > 1024 * 1024 * 1024) return false
  if (!isSha256(r.sha256)) return false
  return true
}

export function isClientSignalingMessage(val: unknown): val is ClientSignalingMessage {
  if (!val || typeof val !== 'object') return false
  const r = val as Record<string, unknown>
  if (r.v !== 1 || typeof r.type !== 'string') return false

  switch (r.type) {
    case 'join':
      return (
        typeof r.roomId === 'string' &&
        isUuid(r.peerId) &&
        typeof r.displayName === 'string' &&
        typeof r.supernodeEligible === 'boolean'
      )
    case 'eligibility':
      return typeof r.supernodeEligible === 'boolean'
    case 'leave':
    case 'ice-config':
      return true
    case 'signal':
      return (
        isUuid(r.targetPeerId) &&
        isUuid(r.targetSessionId) &&
        isUuid(r.connectionId) &&
        (r.kind === 'request-offer' || r.kind === 'offer' || r.kind === 'answer' || r.kind === 'candidate')
      )
    default:
      return false
  }
}

export function isServerSignalingMessage(val: unknown): val is ServerSignalingMessage {
  if (!val || typeof val !== 'object') return false
  const r = val as Record<string, unknown>
  if (r.v !== 1 || typeof r.type !== 'string') return false

  switch (r.type) {
    case 'welcome':
      return isUuid(r.sessionId) && isUuid(r.epoch) && Boolean(r.iceConfig)
    case 'roster':
      return (
        isUuid(r.epoch) &&
        typeof r.revision === 'number' &&
        Array.isArray(r.peers) &&
        r.peers.every(
          (p: unknown) =>
            p &&
            typeof p === 'object' &&
            isUuid((p as Record<string, unknown>).peerId) &&
            isUuid((p as Record<string, unknown>).sessionId) &&
            typeof (p as Record<string, unknown>).joinOrder === 'number' &&
            typeof (p as Record<string, unknown>).displayName === 'string' &&
            typeof (p as Record<string, unknown>).supernodeEligible === 'boolean'
        )
      )
    case 'ice-config':
      return Boolean(r.iceConfig)
    case 'signal':
      return (
        isUuid(r.fromPeerId) &&
        isUuid(r.fromSessionId) &&
        isUuid(r.connectionId) &&
        (r.kind === 'request-offer' || r.kind === 'offer' || r.kind === 'answer' || r.kind === 'candidate')
      )
    case 'error':
      return typeof r.code === 'string' && typeof r.message === 'string'
    default:
      return false
  }
}

export function isOverlayControlMessage(val: unknown): val is OverlayControlMessage {
  if (!val || typeof val !== 'object') return false
  const r = val as Record<string, unknown>
  if (r.v !== 1 || typeof r.type !== 'string' || !isUuid(r.epoch) || typeof r.revision !== 'number') {
    return false
  }

  switch (r.type) {
    case 'hello':
      return isUuid(r.peerId) && isUuid(r.sessionId)
    case 'ping':
    case 'pong':
      return true
    case 'catalog-begin':
      return (
        typeof r.generation === 'number' &&
        typeof r.count === 'number' &&
        r.count >= 0 &&
        r.count <= 1000
      )
    case 'catalog-batch':
      return (
        typeof r.generation === 'number' &&
        Array.isArray(r.entries) &&
        r.entries.length <= MAX_CATALOG_BATCH_ENTRIES &&
        r.entries.every(isValidFileMetadata)
      )
    case 'catalog-end':
    case 'catalog-ack':
      return typeof r.generation === 'number'
    case 'search':
      return (
        isUuid(r.queryId) &&
        typeof r.query === 'string' &&
        r.query.length >= 1 &&
        r.query.length <= MAX_SEARCH_QUERY_LENGTH &&
        typeof r.ttl === 'number'
      )
    case 'search-forward':
      return (
        isUuid(r.queryId) &&
        typeof r.query === 'string' &&
        r.query.length >= 1 &&
        r.query.length <= MAX_SEARCH_QUERY_LENGTH &&
        isUuid(r.originPeerId) &&
        typeof r.ttl === 'number'
      )
    case 'search-results':
      return (
        isUuid(r.queryId) &&
        isUuid(r.originPeerId) &&
        Array.isArray(r.entries) &&
        r.entries.length <= MAX_SEARCH_RESULTS_ENTRIES &&
        r.entries.every(
          (e: unknown) =>
            e &&
            typeof e === 'object' &&
            isUuid((e as Record<string, unknown>).ownerPeerId) &&
            isUuid((e as Record<string, unknown>).ownerSessionId) &&
            isValidFileMetadata((e as Record<string, unknown>).file)
        ) &&
        typeof r.done === 'boolean' &&
        typeof r.partial === 'boolean'
      )
    default:
      return false
  }
}

export function isTransferControlMessage(val: unknown): val is TransferControlMessage {
  if (!val || typeof val !== 'object') return false
  const r = val as Record<string, unknown>
  if (r.v !== 1 || typeof r.type !== 'string') return false

  switch (r.type) {
    case 'request':
    case 'accepted':
      return (
        typeof r.size === 'number' &&
        Number.isInteger(r.size) &&
        r.size >= 0 &&
        isSha256(r.sha256) &&
        (r.type !== 'request' || isUuid(r.fileId))
      )
    case 'ack':
      return typeof r.receivedBytes === 'number' && Number.isInteger(r.receivedBytes) && r.receivedBytes >= 0
    case 'end':
      return typeof r.size === 'number' && isSha256(r.sha256)
    case 'verified':
    case 'cancel':
      return true
    case 'error':
      return typeof r.code === 'string'
    default:
      return false
  }
}
