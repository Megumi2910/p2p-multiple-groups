# Architecture: Wire Protocol Specification

This document provides the formal wire protocol specifications for **Signaling V2**, **Overlay Control V2**, and **Transfer Control V2**, as implemented in `src/shared/p2p-wire.ts`.

---

## 1. Framing, Channel Labeling & Buffer Limits

All control messages across WebSocket and WebRTC data channels are serialized as UTF-8 encoded JSON payloads. Binary transfer chunks are transmitted as raw ArrayBuffer slices.

### Protocol Size Constants

| Metric | Constant | Value | Purpose |
|---|---|---|---|
| Max Signaling Message | `MAX_SIGNALING_MESSAGE_SIZE` | $128\text{ KiB}$ ($131,072\text{ B}$) | Bounds incoming WebSocket frame allocations. |
| Max Control Message | `MAX_CONTROL_MESSAGE_SIZE` | $16\text{ KiB}$ ($16,384\text{ B}$) | Bounds SCTP control channel payloads. |
| Max Transfer Control | `MAX_TRANSFER_CONTROL_SIZE` | $1\text{ KiB}$ ($1,024\text{ B}$) | Bounds transfer signaling control overhead. |
| Max Transfer Chunk | `MAX_TRANSFER_CHUNK_SIZE` | $16\text{ KiB}$ ($16,384\text{ B}$) | Raw binary chunk MTU alignment. |
| Max Catalog Batch | `MAX_CATALOG_BATCH_ENTRIES` | $32\text{ entries}$ | Bounds catalog publication batch sizes. |
| Max Search Results | `MAX_SEARCH_RESULTS_ENTRIES` | $16\text{ entries}$ | Bounds incremental search results frames. |
| Max Query Length | `MAX_SEARCH_QUERY_LENGTH` | $120\text{ characters}$ | Prevents regex and memory exhaustion. |
| Freshness Lease Duration | `ROSTER_FRESHNESS_LEASE_MS` | $6,000\text{ ms}$ | Authoritative membership validity window. |

### WebRTC Data Channel Naming Convention
1. **Multiplexed Control Channel**:
   $$\text{Label} = \text{"p2p-multiple-groups-control-v2"}$$
2. **Dedicated File Transfer Channel**:
   $$\text{Label} = \text{"p2p-multiple-groups-file-v2:"} \parallel \text{groupId} \parallel \text{":"} \parallel \text{transferId}$$

---

## 2. Signaling Protocol V2 (WebSocket)

Signaling coordinates initial group admission, roster broadcasts, and ICE candidate negotiation.

### Client -> Server Messages (`ClientSignalingMessageV2`)

#### 1. `register`
Initial handshake when establishing the physical WebSocket link:
```typescript
{
  v: 2,
  type: 'register',
  peerId: string,         // UUIDv4
  displayName: string     // 1-32 characters
}
```

#### 2. `join-group`
Join a specific virtual group on this signaling server:
```typescript
{
  v: 2,
  type: 'join-group',
  groupId: string,        // 1-32 chars alphanumeric/dash/underscore
  token: string,          // Secret access token
  supernodeEligible: boolean
}
```

#### 3. `leave-group`
Gracefully unregister from a virtual group:
```typescript
{
  v: 2,
  type: 'leave-group',
  groupId: string
}
```

#### 4. `eligibility`
Update election candidate status in an active group:
```typescript
{
  v: 2,
  type: 'eligibility',
  groupId: string,
  supernodeEligible: boolean
}
```

#### 5. `signal`
Exchange SDP offers, answers, or ICE candidates targeted to a specific peer:
```typescript
{
  v: 2,
  type: 'signal',
  groupId: string,
  targetPeerId: string,
  targetSessionId: string,
  connectionId: string,
  kind: 'request-offer' | 'offer' | 'answer' | 'candidate',
  payload: unknown
}
```

---

### Server -> Client Messages (`ServerSignalingMessageV2`)

#### 1. `welcome`
Sent immediately upon successful WebSocket upgrade and registration:
```typescript
{
  v: 2,
  type: 'welcome',
  sessionId: string,      // Transient connection UUID
  iceConfig: SignalingIceConfig
}
```

#### 2. `group-joined`
Confirmed admission to a virtual group:
```typescript
{
  v: 2,
  type: 'group-joined',
  groupId: string,
  membershipId: string,   // Ephemeral membership UUID
  epoch: string,          // Server session UUID
  revision: number,       // Monotonic revision counter
  peers: SignalingRosterPeerV2[]
}
```

#### 3. `roster`
Authoritative group membership broadcast (triggers supernode re-election):
```typescript
{
  v: 2,
  type: 'roster',
  groupId: string,
  epoch: string,
  revision: number,
  peers: Array<{
    peerId: string,
    sessionId: string,
    membershipId: string,
    joinOrder: number,
    displayName: string,
    supernodeEligible: boolean
  }>
}
```

#### 4. `error`
Authentication failure or invalid operation:
```typescript
{
  v: 2,
  type: 'error',
  groupId?: string,
  code: string,           // e.g. "AUTH_FAILED", "INVALID_INPUT"
  message: string
}
```

---

## 3. Overlay Control Protocol V2 (SCTP Data Channel)

Control messages flow directly between peers over `p2p-multiple-groups-control-v2`.

### Heartbeat & Routing Messages

#### `ping` / `pong`
```typescript
{
  v: 2,
  type: 'ping' | 'pong',
  groupId: string,
  epoch: string,
  revision: number,
  senderMembershipId: string
}
```

### Inverted Catalog Index Synchronization

#### `catalog-begin`
Initiates a new catalog publication stream, evicting previous generations:
```typescript
{
  v: 2,
  type: 'catalog-begin',
  groupId: string,
  epoch: string,
  revision: number,
  senderMembershipId: string,
  generation: number,
  count: number           // Total expected files
}
```

#### `catalog-batch`
Transmits up to 32 catalog entries per frame:
```typescript
{
  v: 2,
  type: 'catalog-batch',
  groupId: string,
  epoch: string,
  revision: number,
  senderMembershipId: string,
  generation: number,
  entries: Array<{
    fileId: string,
    name: string,
    size: number,
    sha256: string,
    groupKeys?: string[]
  }>
}
```

#### `catalog-end`
Atomically commits the staged catalog:
```typescript
{
  v: 2,
  type: 'catalog-end',
  groupId: string,
  epoch: string,
  revision: number,
  senderMembershipId: string,
  generation: number
}
```

#### `catalog-ack`
Acknowledges successful index ingestion:
```typescript
{
  v: 2,
  type: 'catalog-ack',
  groupId: string,
  epoch: string,
  revision: number,
  senderMembershipId: string,
  generation: number
}
```

---

### Search Routing Messages

#### `search`
Dispatched by leaf to primary supernode:
```typescript
{
  v: 2,
  type: 'search',
  groupId: string,
  epoch: string,
  revision: number,
  senderMembershipId: string,
  queryId: string,        // UUID
  query: string,          // <= 120 chars
  ttl: number             // Initial hop limit
}
```

#### `search-forward`
Forwarded by primary supernode to standby supernode:
```typescript
{
  v: 2,
  type: 'search-forward',
  groupId: string,
  epoch: string,
  revision: number,
  senderMembershipId: string,
  queryId: string,
  query: string,
  originPeerId: string,
  originMembershipId: string,
  ttl: number
}
```

#### `search-results`
Batched matches returned to the querying peer:
```typescript
{
  v: 2,
  type: 'search-results',
  groupId: string,
  epoch: string,
  revision: number,
  senderMembershipId: string,
  responderPeerId: string,
  responderMembershipId: string,
  queryId: string,
  originPeerId: string,
  originMembershipId: string,
  entries: Array<{
    ownerPeerId: string,
    ownerSessionId: string,
    ownerMembershipId: string,
    file: { fileId: string, name: string, size: number, sha256: string }
  }>,
  done: boolean,
  partial: boolean
}
```

---

## 4. Transfer Control Protocol V2

Transfer control messages govern individual file streams over dedicated data channels (`p2p-multiple-groups-file-v2:<groupId>:<transferId>`).

```typescript
export type TransferControlMessageV2 =
  | {
      v: 2,
      type: 'request',
      groupId: string,
      transferId: string,
      epoch: string,
      requesterMembershipId: string,
      ownerMembershipId: string,
      fileId: string,
      size: number,
      sha256: string
    }
  | {
      v: 2,
      type: 'accepted',
      groupId: string,
      transferId: string,
      epoch: string,
      requesterMembershipId: string,
      ownerMembershipId: string,
      fileId: string,
      size: number,
      sha256: string
    }
  | {
      v: 2,
      type: 'ack',
      groupId: string,
      transferId: string,
      receivedBytes: number
    }
  | {
      v: 2,
      type: 'end',
      groupId: string,
      transferId: string,
      size: number,
      sha256: string
    }
  | {
      v: 2,
      type: 'verified',
      groupId: string,
      transferId: string
    }
  | {
      v: 2,
      type: 'cancel',
      groupId: string,
      transferId: string
    }
  | {
      v: 2,
      type: 'error',
      groupId: string,
      transferId: string,
      code: string
    }
```
