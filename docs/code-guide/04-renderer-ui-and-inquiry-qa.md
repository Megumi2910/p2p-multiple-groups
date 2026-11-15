# Chapter 4: React Renderer UI, Code Locator & Inquiry Defense Q&A Bank

> **Category**: Code Guide & Syntax Deep-Dive  
> **Language**: English  
> **Modules Analyzed**: `src/renderer/src/*` (Bootstrap, Hooks, Views, Commands)  
> **Special Content**: 30+ Code Mechanism Locator Table & 32 Comprehensive Viva Defense Questions  
> **Architecture Version**: v2 (Multi-Group Overlay Network)  
> **Compatibility**: Node.js >=24.12.0, Electron 44.10.1, React 19.3.0, TypeScript 5.9.3, Vite 7.3.7  

---

## Table of Contents

1. [Renderer Bootstrap & State Hook (`#renderer-bootstrap-and-hook`)](#renderer-bootstrap-and-hook)
   - 1.1. Window Global Type Declaration Merging in `env.d.ts`
   - 1.2. React 19 Root Mounting in `main.tsx`
   - 1.3. `usePeerState` Custom Hook: IPC Subscription, Monotonic Revision Guard, and Auto-Selection
2. [Application Shell & Functional Views (`#renderer-views`)](#renderer-views)
   - 2.1. Central Shell in `App.tsx`: Navigation, Theme Sync, and Global Shortcuts
   - 2.2. Network View `Network.tsx`: Dynamic Group Creation, Short Invite Codes, Owner Controls, and Roster
   - 2.3. Shared Library View `Library.tsx`: File Picking, Byte Formatting, and Multi-Group Grants
   - 2.4. Search View `Search.tsx`: Group Scope Selector, Swarm Aggregation, and Source Selection
   - 2.5. Transfers View `Transfers.tsx`: Active vs Completed, Direct/Relay Detection, and Cancellation
   - 2.6. Command Palette `CommandPalette.tsx` & Theme Dialog: Native `<dialog>` Modal Mechanics
3. [Master Code Locator Table for 30+ Core Mechanisms (`#bang-tra-cuu-vi-tri-code`)](#bang-tra-cuu-vi-tri-code)
4. [Comprehensive Viva Defense Q&A Bank (32 Questions) (`#bo-cau-hoi-van-dap-inquiry-test`)](#bo-cau-hoi-van-dap-inquiry-test)
   - Group A: JS, TypeScript & React 19 Syntax Fundamentals (Questions 1 – 8)
   - Group B: Electron Three-Process Architecture & Security Boundaries (Questions 9 – 16)
   - Group C: Signaling, HRW Supernode Elections & Multiplexing (Questions 17 – 24)
   - Group D: File Fingerprinting, Inverted Search & SCTP Transfers (Questions 25 – 32)

---

<section id="renderer-bootstrap-and-hook">

## 1. Renderer Bootstrap & State Hook

### 1.1. Window Global Type Declaration Merging in `env.d.ts`

TypeScript's default browser DOM environment declares `window` with standard web APIs. To safely access methods exposed by the Preload bridge without compilation errors, `src/renderer/src/env.d.ts` uses **Declaration Merging**:

```typescript
// src/renderer/src/env.d.ts:1-8
/// <reference types="vite/client" />
import type { P2pApi } from '../../shared/contracts.ts'

declare global {
  interface Window {
    p2p: P2pApi
  }
}
```

This ensures `window.p2p` is statically typed across all React views and hooks.

### 1.2. React 19 Root Mounting in `main.tsx`

`src/renderer/src/main.tsx` mounts the application using React 19's `ReactDOM.createRoot` API:

```typescript
// src/renderer/src/main.tsx
const rootElement = document.getElementById('root')
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}
```

### 1.3. `usePeerState` Custom Hook

Located in `src/renderer/src/features/network/usePeerState.ts`, this hook encapsulates state synchronization between the Electron Main process and the React UI:
- Subscribes to `window.p2p.p2p.onState((incomingState) => { ... })`.
- Enforces monotonic revision checking: discards incoming snapshots if `incomingState.revision < lastRevisionRef.current`.
- Exposes typed actions: `createGroup`, `joinGroup`, `rotateGroupInvite`, `removeGroupMember`, `leaveGroup`, `addFiles`, `search`, and `download`.

</section>

---

<section id="renderer-views">

## 2. Application Shell & Functional Views

### 2.1. Central Shell in `App.tsx`

Manages top-level navigation tabs (`Home`, `Network`, `Library`, `Search`, `Transfers`, `Appearance`), synchronizes dark/light themes via `window.p2p.getTheme()` / `setTheme()`, and listens for global keyboard shortcuts (`Ctrl+K` for Command Palette, `Ctrl+1` through `Ctrl+6` for view switching).

### 2.2. Network View `Network.tsx`

Handles virtual group lifecycle operations:
- **Create Group vs. Join Group Modes**: Peers can create a new group dynamically as owner (`createGroup`) or join an existing group (`joinGroup`).
- **Flexible Joining**: Accepts either compact 8–64 character base64url short invite codes or full V2 JSON invitations.
- **Owner Controls**: If the local peer is the group owner (`isOwner === true`), the UI displays an Owner badge, allows copying the short invite code, rotating the invite code (`rotateGroupInvite`), and evicting members (`removeGroupMember`).
- **Active Roster Table**: Lists all group members with session IDs, join order, and Supernode vs. Ordinary peer roles.

### 2.3. Shared Library View `Library.tsx`

Provides local file inventory management:
- Triggers native OS file dialogs via `window.p2p.p2p.addFiles()`.
- Formats file sizes using standard binary suffixes (KiB, MiB, GiB).
- Toggles per-file group access grants dynamically via checkboxes (`setFileGroups`).

### 2.4. Search View `Search.tsx`

- **Group Scope Selector**: Limits search queries to a specific group or across all active groups.
- **Swarm Aggregation**: Multi-source swarms are grouped by `${item.file.sha256}:${item.file.size}` into a `GroupedResult`, preventing duplicate search result entries.
- **Source Selection**: Users can select which peer to download from, prioritizing Direct connections over Relayed TURN routes.

### 2.5. Transfers View `Transfers.tsx`

- Separates active transfers (`transferring`, `connecting`, `verifying`) from completed transfers (`completed`, `failed`, `cancelled`).
- Displays real-time progress bars, chunk speed metrics, route badges (`Direct` vs. `Relayed`), and instant transfer cancellation controls.

### 2.6. Command Palette `CommandPalette.tsx` & Native `<dialog>`

Implements quick keyboard navigation using the HTML5 `<dialog>` element:
```typescript
const dialogRef = useRef<HTMLDialogElement>(null)
dialogRef.current?.showModal()
```

</section>

---

<section id="bang-tra-cuu-vi-tri-code">

## 3. Master Code Locator Table for 30+ Core Mechanisms

| Technical Mechanism | Source File | Function / Class / Symbol | Key Line / Implementation Detail |
|---|---|---|---|
| **Supernode Election by joinOrder** | `src/main/p2p/election.ts` | `electSupernodes` | Filters `supernodeEligible`, sorts `a.joinOrder - b.joinOrder` |
| **Rendezvous Hashing (HRW)** | `src/main/p2p/election.ts` | `selectSupernodesForPeer` | `createHash('sha256').update(`${peerId}:${s.peerId}`)` |
| **Recovery Event Ring Buffer (100 items)** | `src/main/p2p/election.ts` | `RecoveryEventRingBuffer` | `this.events.unshift(event); if (len > 100) pop()` |
| **Single-Instance Application Lock** | `src/main/index.ts` | `app.requestSingleInstanceLock` | Exits immediately if another instance holds the lock |
| **4-Tier IPC Sender Validation** | `src/main/index.ts` | `validateSender` | Verifies window liveness, webContents identity, parent===null, and origin match |
| **200ms Trailing State Throttle** | `src/main/index.ts` | `dispatchStateToWindow` | `setTimeout(..., 200)` coalesces snapshots before IPC dispatch |
| **Graceful 5s Application Teardown** | `src/main/index.ts` | `before-quit` handler | `Promise.race([peerEngine.dispose(), timeout5s])` |
| **Legacy Profile Migration** | `src/main/profile-migration.ts` | `findLegacyProfileDirectory` | Detects legacy `Kazaa/kazaa` directories and copies atomically |
| **Hardware Credential Store (DPAPI/Keychain)** | `src/main/p2p/credential-store.ts` | `SafeCredentialStore` | `safeStorage.encryptString`, POSIX `0o600` permissions |
| **Memory Fallback for Headless Tests** | `src/main/p2p/credential-store.ts` | `memoryCache` | Fallback when `isEncryptionAvailable() === false` |
| **State Upgrade V1 to V2** | `src/main/p2p/peer-store.ts` | `migratePeerStateV1` | Generates `peer-state.v1.backup.json` and upgrades schema |
| **Atomic Disk Staging (.tmp rename)** | `src/main/p2p/peer-store.ts` | `writeQueue` | Writes to `.tmp` file, then atomically commits via `rename()` |
| **File Stat Fingerprinting** | `src/main/p2p/library.ts` | `statFingerprint` | Compares `{ size, mtimeMs, ino }` to avoid re-hashing unchanged files |
| **2-Concurrency Background Hashing Queue** | `src/main/p2p/library.ts` | `MAX_CONCURRENT_HASHING` | Caps simultaneous SHA-256 workers to 2 to prevent CPU saturation |
| **Multi-Group File Grants** | `src/main/p2p/library.ts` | `setFileGroups` | Updates `groupKeys: []` array on file record |
| **Supernode Catalog Staging Buffer (5s)** | `src/main/p2p/search-index.ts` | `CATALOG_STAGING_TTL_MS` | 5000ms TTL timer auto-purges incomplete catalog streams |
| **Unicode NFKC & Boolean AND Search** | `src/main/p2p/search-index.ts` | `matchesQuery` | `fileName.normalize('NFKC')` & `tokens.every(...)` |
| **Query Cache (256 items, 30s TTL)** | `src/main/p2p/search-index.ts` | `queryCache` | Caches last 256 search results for 30 seconds |
| **Search Result Deduplication (200 items)** | `src/main/p2p/search-index.ts` | `SearchResultsTracker` | Keyed by `${ownerPeerId}:${fileId}`, caps results at 200 |
| **Swarm Aggregation by sha256 & size** | `src/renderer/src/features/search/Search.tsx` | `groupedMap` | Groups swarm sources by `${sha256}:${size}` |
| **Monotonic UI Revision Guard** | `src/renderer/src/features/network/usePeerState.ts` | `lastRevisionRef` | `if (incoming.revision >= lastRevisionRef.current)` |
| **Monotonic Wire Revision Guard** | `src/main/p2p/signaling-client.ts` | `handleMessage` | Drops stale signaling messages with outdated revisions |
| **Exponential Backoff Reconnect with Jitter** | `src/main/p2p/signaling-client.ts` | `scheduleReconnect` | Backs off 1s, 2s, 4s up to 30s with random jitter |
| **Transport Pooling (1 PeerConnection / Pair)**| `src/main/p2p/transport.ts` | `connections` Map | 1 `RTCPeerConnection` shared across all virtual groups |
| **Deterministic WebRTC Glare Tie-Breaker** | `src/main/p2p/transport.ts` | `initiateOrRequestConnection` | `this.localPeerId < remotePeer.peerId` initiates Offer |
| **16 KiB Data Channel Streaming** | `src/main/p2p/transfers.ts` | `CHUNK_SIZE = 16384` | Slices files into 16 KiB chunks for SCTP delivery |
| **Mid-Transfer Capability Revocation** | `src/main/p2p/transfers.ts` | `isPeerAuthorized` | Verifies group grant before streaming each 16 KiB chunk |
| **Sliding-Window Backpressure & ACKs** | `src/main/p2p/transfers.ts` | `HIGH_WATER_BUFFER` | ACKs sent every 256 KiB; pauses disk read if unacked >= 512 KiB |
| **Atomic Transfer Commit via link()** | `src/main/p2p/transfers.ts` | `link(partPath, dest)` | Atomically creates target file and catches `EEXIST` |
| **Policy Queue Promise Serialization** | `src/main/p2p/engine.ts` | `queueAction` | `policyQueue = enqueued.then(() => {}, () => {})` |
| **Roster Freshness Lease Monitor (6s)** | `src/main/p2p/engine.ts` | `monitorTimer` | 2s sweep checking `ROSTER_FRESHNESS_LEASE_MS = 6000` |
| **Token-Bucket Rate Limiter** | `services/signaling/server.ts`| `checkRateLimit` | 60-token bucket with 30 tokens/sec refill rate |
| **Constant-Time Token Verification** | `services/signaling/server.ts`| `timingSafeEqual` | Constant-time buffer comparison to defeat timing attacks |
| **RFC 5766 HMAC-SHA1 Ephemeral Auth** | `services/signaling/server.ts`| `createHmac('sha1')` | Issues 24-hour temporary Coturn credentials |
| **WeakMap Socket Memory Management** | `services/signaling/server.ts`| `upgradeGroupIdMap` | `new WeakMap<WebSocket, string>()` prevents memory leaks |
| **Dev vs Prod CSP Injection** | `electron.vite.config.ts` | `p2pCsp` plugin | Injects dev CSP with `ws:` vs prod CSP with `connect-src 'none'` |

</section>

---

<section id="bo-cau-hoi-van-dap-inquiry-test">

## 4. Comprehensive Viva Defense Q&A Bank (32 Questions)

---

### Group A: JS, TypeScript & React 19 Syntax Fundamentals

#### Q1: What is the primary difference between `interface` and `type` in TypeScript? Why is `ActionResult` a `type` while `GroupInvitation` is an `interface`?
**Answer:**  
`interface` defines the shape of an object and supports declaration merging and inheritance via `extends`. `GroupInvitation` is an `interface` because it represents an extensible domain entity. Conversely, `type` can represent union types (`A | B`), primitives, tuples, and mapped types. `ActionResult` must be a `type` because it is a Tagged / Discriminated Union (`{ ok: true; data: T } | { ok: false; code: P2pErrorCode; message: string }`), which `interface` cannot directly declare.

#### Q2: How does a Discriminated Union work in `ActionResult` and `ServerSignalingMessageV2`?
**Answer:**  
A Discriminated Union is a set of distinct object shapes that share a common literal tag property (e.g., `ok` or `type`). When developers check the tag (e.g., `if (!res.ok)` or `switch (msg.type)`), TypeScript performs **Type Narrowing**: inside the `!res.ok` branch, TypeScript guarantees the object has `code` and `message` properties without manual casting.

#### Q3: What is the benefit of `as const` in `IPC_CHANNELS`?
**Answer:**  
Without `as const`, TypeScript widens object properties to general types (e.g., `'p2p:joinGroup'` becomes `string`). Applying `as const` marks all properties as deeply `readonly` and preserves exact string literal types. This prevents typos and enables type-safe indexing at compile time.

#### Q4: How does `queueAction<T>` in `src/main/p2p/engine.ts` isolate errors? Why attach two empty functions `enqueued.then(() => {}, () => {})`?
**Answer:**  
`queueAction` implements the Promise Chain Serialization pattern. The trailing `.then(() => {}, () => {})` catches and swallows errors for the global `policyQueue` chain itself. If action A rejects, the error is swallowed on the queue tail so `policyQueue` returns to the Fulfilled state. Action B behind it continues execution without interruption, while the caller of action A still receives their specific error via the returned `enqueued` Promise.

#### Q5: Why do `usePeerState.ts` and `App.tsx` use `useRef` for `lastRevisionRef` and `isSavingThemeRef` instead of `useState`?
**Answer:**  
Updating `useState` forces React to re-render the component. `lastRevisionRef` and `isSavingThemeRef` are internal state trackers. Storing them in a mutable `ref.current` allows synchronous reads and writes without triggering unwanted, costly re-renders.

#### Q6: In `useEffect`, why is returning a cleanup function (`return () => unsubscribe()`) mandatory?
**Answer:**  
React calls the cleanup function when a component unmounts or before re-running the effect. The cleanup calls `ipcRenderer.removeListener` to discard the event listener. Omitting it would cause stale listeners to accumulate in RAM on every re-mount, resulting in memory leaks and duplicate message execution.

#### Q7: What constraints does Node.js 24 Native Type Stripping impose on TypeScript code?
**Answer:**  
Node 24 native type stripping parses `.ts` files in memory by replacing type annotations with whitespace. This requires **Erasable Syntax Only** (enforced by `"erasableSyntaxOnly": true` in `tsconfig.node.json`): all type-only imports must use `import type`, and non-erasable TypeScript features like legacy runtime `enum` or parameter properties in constructors are strictly forbidden.

#### Q8: How does the project use `unknown` with user-defined type guards instead of `any`?
**Answer:**  
`any` completely disables static type checking. `unknown` is type-safe: TypeScript forbids operations on `unknown` values until they are narrowed. The codebase assigns `unknown` to untrusted JSON from disk, WebSocket packets, and IPC arguments, then validates them using type guards (e.g., `isThemePreference(val): val is ThemePreference`). When a type guard returns `true`, TypeScript safely narrows the type.

---

### Group B: Electron Three-Process Architecture & Security Boundaries

#### Q9: Explain Electron's three-process architecture. Why shouldn't the React UI connect to WebRTC directly?
**Answer:**  
The three processes are:
1. **Main Process**: Privileged Node.js runtime managing WebRTC (Werift), disk I/O, and OS keychain credentials.
2. **Preload Script**: Isolated security bridge exposing safe APIs via `contextBridge`.
3. **Renderer Process**: Sandboxed React 19 UI running in Chromium.  
The UI must not access WebRTC directly because the Renderer is an untrusted sandbox. If network sockets were opened directly in the Renderer, an XSS vulnerability could allow an attacker to pivot into the local network or exfiltrate private files. Isolating networking to the Main process guarantees centralized policy enforcement.

#### Q10: Explain the 4-tier security validation in `validateSender(event)` in `src/main/index.ts`.
**Answer:**  
1. **Window Liveness**: Confirms `mainWindow` exists and is not destroyed.
2. **Sender Identity**: Compares `event.sender === mainWindow.webContents` to ensure the call originated from the primary window.
3. **Top-Level Frame**: Checks `event.senderFrame.parent === null` to block requests from embedded `<iframe>` elements.
4. **Origin Match**: Enforces `http://127.0.0.1:5173` in development and internal static `file:` protocol in production.

#### Q11: How is the Content Security Policy configured in development vs. production?
**Answer:**  
The `p2pCsp` Vite plugin injects CSP into `index.html`:
- **Development**: `connect-src 'self' ws://127.0.0.1:5173` to allow Vite HMR WebSockets.
- **Production**: `connect-src 'none'`. All direct network calls from the browser context are blocked.

#### Q12: Why is `contextBridge.exposeInMainWorld` safer than direct `window` assignment?
**Answer:**  
Directly assigning APIs to `window` with context isolation disabled allows untrusted scripts to access Node.js prototypes and perform privilege escalation. `contextBridge.exposeInMainWorld` leverages Chromium's Context Isolation to create an immutable proxy bridge on `window.p2p`. The Preload and Renderer processes run in separate memory contexts, making it impossible for UI scripts to tamper with IPC handlers or internal closures.

#### Q13: How does `SafeCredentialStore` protect group tokens and owner secrets across operating systems?
**Answer:**  
- **Windows / macOS**: Uses `electron.safeStorage` to encrypt tokens with Windows DPAPI or macOS Keychain before writing them to `credentials.enc` with POSIX `0o600` permissions.
- **Headless Linux / Tests**: If encryption is unavailable, it automatically falls back to in-memory storage (`memoryCache`), allowing CI pipelines and unit tests to execute without failing.

#### Q14: How does atomic file writing via `.tmp` staging prevent corruption in `peer-store.ts`?
**Answer:**  
Writing directly to `peer-state.json` risks leaving the file corrupted or empty if power fails mid-write. Atomic staging writes new data to a unique temporary file (`peer-state.json.<id>.tmp`), flushes buffers to disk, and calls the OS `rename()` system call. On modern filesystems, `rename()` is atomic: the file either retains its old content or transitions entirely to the new content.

#### Q15: Why is `sanitizeDestinationFileName` necessary during file downloads?
**Answer:**  
File names sent by remote peers are untrusted. Malicious actors could include path traversal sequences like `../../../../etc/shadow` or `..\System32\malicious.dll`. `sanitizeDestinationFileName` strips directory separators (`/`, `\`) and `..` sequences, extracting only the safe basename before appending it to the user's download directory.

#### Q16: Why is `app.requestSingleInstanceLock` essential for this application?
**Answer:**  
The application persists state to disk in `peer-state.json` and `credentials.enc`. If two instances run simultaneously against the same directory, concurrent writes will corrupt state. `app.requestSingleInstanceLock()` ensures only one instance runs; any secondary instance immediately quits after focusing the primary window.

---

### Group C: Signaling, HRW Supernode Elections & Multiplexing

#### Q17: What constitutes a `GroupKey`? Why isn't `groupId` sufficient?
**Answer:**  
A `GroupKey` is a serialized JSON tuple: `JSON.stringify([signalingUrl, groupId])`. A plain `groupId` is insufficient because peers can connect to multiple independent signaling servers where group IDs might collide (e.g., two servers having a `general` group). Combining `signalingUrl` and `groupId` creates a globally unique identifier.

#### Q18: Explain the `electSupernodes` algorithm in `src/main/p2p/election.ts`.
**Answer:**  
Up to 2 Supernodes are elected per group:
1. Filter candidates where `supernodeEligible === true`.
2. Sort candidates by:
   - **Primary**: Ascending `joinOrder` (prioritizing longer-lived, stable peers).
   - **Tie-Breaker**: Lexicographical comparison of `peerId` (`a.peerId.localeCompare(b.peerId)`).
3. The top two candidates become Supernodes; others remain ordinary peers.

#### Q19: What problem does Highest Random Weight (HRW) consistent hashing solve?
**Answer:**  
Ordinary peers must connect to a Supernode to submit file catalogs and query swarms. HRW assigns peers deterministically without a central coordinator:  
`hash = SHA256(peerId + ":" + supernodeId)`  
The Supernode yielding the highest hash becomes the Primary Supernode; the second becomes Standby. When a Supernode departs, only $\frac{1}{|S|}$ of clients are reassigned, avoiding cascading re-hashing storms.

#### Q20: What is Transport Pooling in `TransportManager`?
**Answer:**  
Between any two physical peers, the engine maintains exactly **one** `RTCPeerConnection`, regardless of how many virtual groups they share. Control messages across all groups are multiplexed over a single data channel (`p2p-multiple-groups-control-v2`). This minimizes duplicate ICE/DTLS handshakes, saves network sockets, and conserves CPU/RAM.

#### Q21: When does WebRTC Glare occur, and how is it resolved?
**Answer:**  
Glare occurs when Node A and Node B discover each other simultaneously via signaling and both generate and send SDP Offers. Both nodes end up waiting for Answers, stalling the connection. The codebase resolves Glare deterministically: only the peer with the lexicographically smaller `peerId` (`this.localPeerId < remotePeer.peerId`) generates an Offer; the other waits to receive it.

#### Q22: How does the signaling server defend against timing attacks on group tokens?
**Answer:**  
Standard string comparison (`===`) terminates on the first mismatched byte, leaking secrets through timing differences. The signaling server uses `crypto.timingSafeEqual(providedBuf, expectedBuf)`, which compares all bytes in constant time regardless of correctness, preventing timing-based secret extraction.

#### Q23: How is the signaling Token-Bucket Rate Limiter configured?
**Answer:**  
Each WebSocket connection receives a dedicated token bucket:
- Capacity: 60 tokens (accommodates initial bursts).
- Refill Rate: 30 tokens per second.  
Each message consumes 1 token. If the bucket empties, the server rejects messages with `RATE_LIMITED`, blocking spam and DoS attempts.

#### Q24: What is the purpose of `ROSTER_FRESHNESS_LEASE_MS = 6000`?
**Answer:**  
In a decentralized overlay, Supernode authority must be time-bounded to prevent split-brain scenarios. A membership lease lasts 6000ms. A 2000ms watchdog timer verifies that signaling refreshes are received within 6000ms. If the server becomes unreachable for more than 6 seconds, the node revokes its Supernode authority and falls back to a recovery state.

---

### Group D: File Fingerprinting, Inverted Search & SCTP Transfers

#### Q25: How does `statFingerprint` optimize library rescans?
**Answer:**  
Computing SHA-256 digests over large files is CPU-intensive. `LibraryManager` stores a filesystem stat fingerprint: `{ size, mtimeMs, ino }`. On rescans, it queries OS metadata via `fs.stat`. If `size` and `mtimeMs` match, it reuses the existing SHA-256 digest from `peer-state.json`, scanning thousands of files in milliseconds.

#### Q26: Why is `MAX_CONCURRENT_HASHING = 2` enforced?
**Answer:**  
Streaming SHA-256 over disk reads can saturate CPU cores. Limiting background hashing to 2 parallel streams ensures the desktop UI remains responsive and active WebRTC transfers are not starved of CPU cycles.

#### Q27: Why do Supernodes use a 5-second Staging Buffer (`CATALOG_STAGING_TTL_MS = 5000`) for catalog uploads?
**Answer:**  
Catalogs are transmitted in chunks (`catalog-begin`, `catalog-batch`, `catalog-end`). Supernodes buffer chunks in a temporary map with a 5000ms TTL. If a peer disconnects before sending `catalog-end`, the buffer automatically expires and frees memory, preventing partial catalog contamination and memory exhaustion attacks.

#### Q28: How does `matchesQuery` implement Unicode NFKC normalization and Boolean AND logic?
**Answer:**  
1. **NFKC Normalization**: Converts accented characters and composite glyphs to standard forms (`fileName.normalize('NFKC').toLowerCase()`), ensuring reliable matching across different keyboard input engines.
2. **Boolean AND**: Splits search queries into tokens and verifies that all tokens are present using `tokens.every((token) => normalizedName.includes(token))`.

#### Q29: How does SCTP sliding-window flow control work during file transfers?
**Answer:**  
1. Files stream in 16 KiB chunks (`CHUNK_SIZE = 16384`).
2. Receivers send cumulative `ack` packets every 256 KiB.
3. Senders monitor unacknowledged bytes (`offset - lastAckedBytes`).
4. If unacknowledged bytes exceed 512 KiB or the data channel buffer exceeds 256 KiB, the sender pauses disk reads (`stream.pause()`).
5. When an ACK arrives and the buffer drains below 128 KiB, reading resumes (`stream.resume()`).

#### Q30: How is mid-transfer capability revocation implemented?
**Answer:**  
Before dispatching each 16 KiB chunk in `src/main/p2p/transfers.ts`, the sender calls `isPeerAuthorized(groupId, remotePeerId, remoteSessionId, fileId)`. If an owner revokes a member's group grant while a download is 50% complete, the check immediately fails. The sender tears down the transfer channel and notifies the receiver with `FORBIDDEN`, halting the transfer.

#### Q31: How does atomic file commit via `link()` and `unlink()` work, and why catch `EEXIST`?
**Answer:**  
1. Downloads write to a temporary hidden file: `.<name>.tmp.<transferId>`.
2. Upon completion, the received SHA-256 digest is verified against the metadata.
3. The temporary file is committed via `fs.link(partPath, destPath)`, creating an atomic hard link.
4. Catching `EEXIST`: If a file with the destination name already exists, `link()` throws `EEXIST`. The engine catches this and returns `DESTINATION_EXISTS`, preventing accidental data overwrites.
5. `fs.unlink(partPath)` removes the temporary reference after successful linking.

#### Q32: What is Swarm Aggregation in `Search.tsx`, and how does it benefit users?
**Answer:**  
When multiple peers share identical files, individual results clutter the UI. `Search.tsx` aggregates results sharing the same `${sha256}:${size}` key into a single `GroupedResult`. This presents a clean, deduplicated table and allows the user to choose their preferred download source (e.g., favoring Direct connections over Relayed TURN nodes).

---

## Chapter Summary

1. The React 19 UI isolates privileged operations via `window.p2p`.
2. Group ownership controls allow dynamic group creation, invite rotation, and member evictions.
3. Swarm aggregation and sliding-window SCTP transfers deliver resilient, high-speed P2P downloads.
4. The 32-question inquiry bank provides a complete reference for technical defense and architectural reviews.
