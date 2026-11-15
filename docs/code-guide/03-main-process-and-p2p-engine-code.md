# Chapter 3: Main Process & P2P Engine Core Walkthrough

> **Category**: Code Guide & Syntax Deep-Dive  
> **Language**: English  
> **Modules Analyzed**: `src/main/index.ts`, `menu.ts`, `theme-store.ts`, `profile-migration.ts`, and all modules in `src/main/p2p/*`  
> **Architecture Version**: v2 (Multi-Group Overlay Network)  
> **Compatibility**: Node.js >=24.12.0, Electron 44.10.1, React 19.3.0, TypeScript 5.9.3, Vite 7.3.7  

---

## Table of Contents

1. [Main Process & IPC Security Boundaries (`#main-entry`)](#main-entry)
   - 1.1. Application Bootstrapping, Single-Instance Lock, and Profile Migration
   - 1.2. The 4-Tier `validateSender` Defense-in-Depth Filter
   - 1.3. Trailing 200ms State Snapshot Throttling (`P2P_V2_STATE`)
   - 1.4. IPC Handlers Registration: `createGroup`, `rotateGroupInvite`, `removeGroupMember`
2. [Supernode Elections & Rendezvous Consistent Hashing (`#election-module`)](#election-module)
   - 2.1. `electSupernodes`: Join-Order and Lexicographical Tie-Breaking
   - 2.2. Rendezvous Hashing (`selectSupernodesForPeer`) via SHA-256
   - 2.3. Resilient Failover & Ring Buffering
3. [Local Storage, Hardware Encryption & Migration (`#storage-modules`)](#storage-modules)
   - 3.1. `SafeCredentialStore`: Windows DPAPI, macOS Keychain, and Memory Fallback (`${groupKey}:owner`)
   - 3.2. `MultiGroupPeerStore`: Atomic Staging (`.tmp`) and Crash-Resistant Renames
4. [Shared Library & Inverted Search Indexing (`#library-and-search-index`)](#library-and-search-index)
   - 4.1. `LibraryManager`: Stat Fingerprinting and Background SHA-256 Hashing Pipeline
   - 4.2. `SupernodeIndexManager`: Inverted Index Maintenance and NFKC Normalization
   - 4.3. `SearchResultsTracker`: Swarm Source Aggregation and Query Deduplication
5. [Signaling Client & Transport Multiplexing (`#signaling-and-transport`)](#signaling-and-transport)
   - 5.1. `SignalingClient`: Desired Group Reconciliation and Exponential Backoff Reconnection
   - 5.2. `TransportManager`: Connection Pooling, Dynamic Relay Switching, and WebRTC Glare Resolution
6. [File Transfers & SCTP Sliding-Window Flow Control (`#transfers-module`)](#transfers-module)
   - 6.1. `TransferManager`: 2-Upload / 2-Download Concurrency and 30-Second Stall Watchdog
   - 6.2. 16 KiB Streaming Loop and Mid-Transfer Capability Revocation
   - 6.3. Sliding-Window Flow Control (256 KiB ACKs, 512 KiB Cap) and Atomic Commit
7. [PeerEngine Concurrency Orchestrator (`#peer-engine`)](#peer-engine)
   - 7.1. `GroupRuntime` Architecture and `policyQueue` Promise Serialization
   - 7.2. 6000ms Roster Freshness Leases and Clean Engine Disposal

---

<section id="main-entry">

## 1. Main Process & IPC Security Boundaries (`src/main/index.ts`)

The Electron Main process holds full operating system access. It initializes the desktop window, establishes IPC security boundaries, and manages the lifecycle of the P2P engine.

### 1.1. Single-Instance Lock and Profile Migration

```typescript
// src/main/index.ts & profile-migration.ts
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
  return
}
```

- **Single-Instance Lock (`app.requestSingleInstanceLock`)**: Prevents multiple processes from writing concurrently to `peer-state.json`, eliminating database corruption.
- **Legacy Profile Migration (`profile-migration.ts`)**: Automatically checks for legacy profiles (e.g., from older `Kazaa` folders), migrating stored data atomically to the modern `p2p-multiple-groups` configuration directory.

### 1.2. The 4-Tier `validateSender` IPC Defense

Every incoming IPC invocation must pass a 4-tier origin validation check:

```typescript
// src/main/index.ts: validateSender
function validateSender(frame: WebFrameMain | null): boolean {
  if (!frame) return false
  if (frame !== mainWindow?.webContents.mainFrame) return false
  const url = new URL(frame.url)
  if (isDev) {
    return url.origin === 'http://127.0.0.1:5173'
  }
  return url.protocol === 'file:'
}
```

1. **Existence Verification**: Ensures the calling frame exists and is not orphaned.
2. **Main Frame Binding**: Confirms the sender is the top-level window frame, rejecting child iframes.
3. **URL Origin Parsing**: Validates the sender URL against authorized origins.
4. **Environment Isolation**: Allows only `http://127.0.0.1:5173` in development and strictly `file:` in production.

### 1.3. Trailing 200ms State Snapshot Throttling

State snapshots emitted by `PeerEngine` are throttled using a 200ms trailing timer before transmission over `IPC_CHANNELS.P2P_V2_STATE`:

```typescript
// src/main/index.ts
let stateThrottleTimer: NodeJS.Timeout | null = null
let pendingStateSnapshot: MultiGroupP2pState | null = null

function dispatchStateToWindow(state: MultiGroupP2pState): void {
  pendingStateSnapshot = state
  if (!stateThrottleTimer) {
    stateThrottleTimer = setTimeout(() => {
      stateThrottleTimer = null
      if (pendingStateSnapshot && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.P2P_V2_STATE, pendingStateSnapshot)
        pendingStateSnapshot = null
      }
    }, 200)
  }
}
```

### 1.4. IPC Handlers Registration

All 22 channels are wired in `src/main/index.ts`, including the dynamic group ownership actions:
- `IPC_CHANNELS.P2P_V2_CREATE_GROUP`: Invokes `peerEngine.createGroup(options)`
- `IPC_CHANNELS.P2P_V2_ROTATE_GROUP_INVITE`: Invokes `peerEngine.rotateGroupInvite(groupKey)`
- `IPC_CHANNELS.P2P_V2_REMOVE_GROUP_MEMBER`: Invokes `peerEngine.removeGroupMember(groupKey, targetPeerId)`

</section>

---

<section id="election-module">

## 2. Supernode Elections & Rendezvous Consistent Hashing (`src/main/p2p/election.ts`)

### 2.1. Deterministic Supernode Election

The `electSupernodes` function partitions active group members into Supernodes and Ordinary peers:
1. Filters candidates where `supernodeEligible === true`.
2. Sorts candidates by ascending `joinOrder`.
3. Breaks ties lexicographically using `peerId.localeCompare(otherPeerId)`.
4. Elects up to the target supernode ratio (e.g., top $S = \min(M, \lceil N / K \rceil)$).

### 2.2. Rendezvous Hashing (HRW)

Ordinary peers choose their supervising supernodes using Highest Random Weight (HRW) consistent hashing:

$$\text{Weight}(P_{\text{client}}, S_i) = \text{SHA256}(P_{\text{client}} \mathbin{\Vert} S_i)$$

Each ordinary peer scores every active supernode and connects to the highest-scoring candidate. When a supernode departs, only $\frac{1}{|S|}$ of clients are reassigned, preventing re-hashing storms.

</section>

---

<section id="storage-modules">

## 3. Local Storage, Hardware Encryption & Migration (`src/main/p2p/*`)

### 3.1. Hardware-Backed Credential Storage (`SafeCredentialStore`)

Stored in `credentials.enc`, secrets are encrypted using Electron's `safeStorage` (Windows DPAPI, macOS Keychain, Linux Secret Service):
- **Group Tokens**: Stored under key `groupKey`.
- **Owner Secrets**: Stored under key `${groupKey}:owner` (authorizes invite rotation and member removal).
- **Headless Fallback**: If running without OS keychain access (e.g., in headless Linux tests), the store operates transparently in RAM.

### 3.2. Atomic Staging in `MultiGroupPeerStore`

To guarantee crash resilience, peer profile updates are staged in a temporary file and committed atomically:
1. Serialize state to `peer-state.json.tmp.<pid>.<timestamp>`.
2. Flush buffers to disk.
3. Atomically rename the staging file over `peer-state.json`.

</section>

---

<section id="library-and-search-index">

## 4. Shared Library & Inverted Search Indexing

### 4.1. `LibraryManager` Background Hashing

Files added to the shared library are indexed by their filesystem stat fingerprint (`size`, `mtimeMs`, `ino`). Files are hashed using a 2-concurrency streaming SHA-256 pipeline, ensuring UI responsiveness.

### 4.2. Inverted Indexing & Unicode NFKC Normalization

Supernodes maintain in-memory inverted catalog indexes:
- File names are normalized using Unicode NFKC and converted to lowercase.
- Queries enforce Boolean AND semantics: all search tokens must match.

### 4.3. Swarm Source Aggregation

`SearchResultsTracker` de-duplicates incoming search responses by `sha256:size`. If multiple peers share identical files, they are grouped into a multi-source swarm for parallel or failover downloads.

</section>

---

<section id="signaling-and-transport">

## 5. Signaling Client & Transport Multiplexing

### 5.1. Reconnection & Desired Groups

`SignalingClient` maintains a desired set of virtual groups. Upon network disconnects, it performs exponential backoff reconnection and re-subscribes to all active groups.

### 5.2. Transport Multiplexing over Shared WebRTC Associations

Peers share a single underlying `RTCPeerConnection` across multiple virtual groups. Transfer channels are uniquely tagged using `makeFileChannelLabelV2(groupId, transferId)`, ensuring strict cryptographic isolation between swarms.

</section>

---

<section id="transfers-module">

## 6. File Transfers & SCTP Sliding-Window Flow Control

### 6.1. Concurrency Caps & Watchdog Timers

- Hard concurrency limits: Maximum 2 concurrent uploads and 2 concurrent downloads.
- 30-second stall watchdog timers abort frozen transfers and release system resources.

### 6.2. 16 KiB Streaming & Instant Capability Revocation

Files are transmitted in 16 KiB chunks over WebRTC SCTP data channels. If an owner evicts a member or revokes a file sharing grant during an active download, the sender immediately tears down the transfer channel.

### 6.3. Sliding-Window Flow Control

- **ACK Interval**: Cumulative acknowledgments sent every 256 KiB.
- **Window Cap**: Inflight buffer capped at 512 KiB.
- **Atomic File Commit**: Incomplete downloads stage in `.tmp.<transferId>` and atomically rename upon SHA-256 verification.

</section>

---

<section id="peer-engine">

## 7. PeerEngine Concurrency Orchestrator

`PeerEngine` coordinates all subsystems through a serialized `policyQueue`:
- Serializes `createGroup`, `joinGroup`, `rotateGroupInvite`, `removeGroupMember`, and library changes.
- Monitors 6000ms roster leases via `setInterval`.
- Dynamically responds to `invite-rotated` and `group-kicked` signaling events.

---

## Chapter Summary

1. The Main process isolates OS privileges, protecting IPC via 4-tier sender validation.
2. Supernodes are elected deterministically via join-order and Rendezvous consistent hashing.
3. Credentials (including `${groupKey}:owner`) are encrypted using OS keychains via `SafeCredentialStore`.
4. File transfers feature 16 KiB chunks, 256 KiB sliding-window ACKs, and atomic staging.
5. Next: Read [Chapter 4: React Renderer UI & Inquiry Test Q&A Bank](04-renderer-ui-and-inquiry-qa.md).
