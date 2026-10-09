# Checkpoint: Multi-Group P2P Migration & Project Rename

**Date**: 2026-10-08  
**Repository**: `p2p-multiple-groups`  
**Status**: Phase 0 Complete — Paused before Phase 1 per user request.

---

## 1. Current Implementation Progress

### Phase 0: Baseline & Pre-migration Fixes (COMPLETED & VERIFIED)

1. **Wait Bounding & Race Condition Fixes in Integration Suites**:
   - `tests/p2p-transfers.test.ts`, `tests/p2p-library-search.test.ts`, `tests/p2p-transfers-survival.test.ts`:
     - Implemented bounded `waitForState` helper with clear failure assertions, immediate state evaluation upon subscription, 25-second state/channel timeout, and 120-second transfer timeout.
     - Always cleans up timers and unregisters subscriptions on completion/failure.

2. **Catalog Publication Lifecycle & Announcement Coalescing**:
   - `src/main/p2p/library.ts`:
     - Introduced `subscribeMetadata(listener: () => void): () => void` and `notifyMetadata()`.
     - Differentiates actual catalog metadata changes (file hashing completed into `'shared'`, removal, re-verification, withdrawal) from UI/acknowledgement notifications (`notify()`).
     - Bumps `currentGeneration` and clears `acknowledgedGeneration = null` upon metadata readiness.
     - `setAcknowledgedGeneration()` notifies UI listeners only, eliminating notification loops.
   - `src/main/p2p/engine.ts`:
     - Added `scheduleAnnounceCatalogue()` using `queueMicrotask` to coalesce multiple synchronous metadata updates (such as zero-byte files finishing immediately alongside binary files) into a single coordinated catalog announcement.
     - Replaced uncoordinated 5s/8s `setInterval` polling loops with deterministic dispatch and prompt cleanup on search completion (`msg.done` / local completion) and engine disposal.

3. **WebRTC Control Channel Handshake & Single-Flight Connection Robustness**:
   - `src/main/p2p/transport.ts`:
     - Fixed `setupControlChannel`: In WebRTC/Werift, incoming data channels on the receiver (`ondatachannel`) are already in `readyState === 'open'`. Registered `sendHello` to run immediately if `channel.readyState === 'open'` so the receiver reliably transmits its `hello` handshake frame.
     - Immediate link state transition: dispatches `onLinkStateChange(record.peerId, 'open', record.path)` immediately upon valid handshake completion, updating the detected path asynchronously via `detectPath(record)` once stats resolve.
     - Single-flight connection policy: ignores redundant `request-offer` and `offer` signals when an open or connecting connection already exists for the same session.

4. **Electron Desktop E2E Bounded Resolution**:
   - `tests/electron-e2e.test.ts`:
     - Dynamically resolves installed Electron executable via `import electron from 'electron'`.
     - Allocates dynamic, collision-free CDP ports via `getFreePort()`.
     - Uses standard DOM `MouseEvent('click')` dispatch for reliable synthetic view navigation under CDP.

---

## 2. Verification Results (Phase 0 Baseline)

All checks pass cleanly with 0 failures and prompt exit:

- `npm run typecheck`: **PASS** (both `tsconfig.node.json` and `tsconfig.web.json`).
- `npm run build`: **PASS** (SSR main/preload and Vite renderer production build).
- `npm test`: **PASS** (21 tests in ~6.1 seconds):
  - `tests/theme-store.test.ts` (4 pass)
  - `tests/p2p-protocol.test.ts` (11 pass)
  - `tests/p2p-integration.test.ts` (4 pass)
  - `tests/p2p-transfers.test.ts` (2 pass)
- `node --test tests/signaling-server.test.ts`: **PASS** (5 pass, ~0.5s).
- `node --test tests/p2p-library-search.test.ts`: **PASS** (8 pass, ~5.2s).
- `node --test tests/p2p-transfers-survival.test.ts`: **PASS** (1 pass, ~3.5s).
- `node --test tests/electron-e2e.test.ts`: **PASS** (2 pass, ~2.3s).

---

## 3. Modified Files in Working Tree

```
M src/main/p2p/engine.ts
M src/main/p2p/library.ts
M src/main/p2p/transport.ts
M tests/electron-e2e.test.ts
M tests/p2p-library-search.test.ts
M tests/p2p-transfers-survival.test.ts
M tests/p2p-transfers.test.ts
```

All existing user code outside these specific bug fixes and tests has been preserved.

---

## 4. Known Issues & Root Causes Solved During Phase 0

1. **Pre-existing transfer suite 300s timeout hang**:
   - *Cause 1*: Receiver side of Werift `ondatachannel` was already open, so `channel.onopen` listener never fired. Receiver never sent `hello` handshake frame. When receiver later sent `catalog-begin`, the initiator rejected it as `// Bad handshake` and destroyed the connection.
   - *Cause 2*: Duplicate `request-offer` / `offer` signaling was destroying already-open connections in `createPeerConnection`.
   - *Cause 3*: Zero-byte and binary files finished hashing in the same event tick, causing interleaved uncoordinated catalog announcements with mismatched generations.
   - *Resolution*: Immediate hello on already-open channel, single-flight signal filtering, and microtask announcement coalescing resolved all timeouts.

---

## 5. Next Steps (To Resume Tomorrow)

When resuming, start directly from **Phase 1**:

1. **Phase 1: Shared Contracts & Persistence**:
   - `src/shared/p2p.ts`: Add `GroupInvitation` (v2 + normalized v1 reader), `GroupKey`, `makeGroupKey`, `JoinGroupOptions`, `P2pGroupState`, `MultiGroupP2pState`, `P2pMultipleGroupsP2pApi`, and error codes `'FORBIDDEN'`, `'INVITATION_REQUIRED'`.
   - `src/shared/p2p-wire.ts`: Introduce v2 signaling messages (`ClientSignalingMessageV2`, `ServerSignalingMessageV2`, `GroupJoinedMessage`, `OverlayControlMessageV2`, `TransferControlMessageV2`) alongside v1 types during staged cutover.
   - `src/main/p2p/peer-store.ts`: Schema v2 with atomic migration from v1, backup preservation (`peer-state.v1.backup.json`), and queued concurrent writes.
   - `src/main/profile-migration.ts` & `tests/profile-migration.test.ts`: Create default directory migration helper handling `<appData>/Kazaa` / `<appData>/kazaa` -> `<appData>/p2p-multiple-groups` with singleton lock verification.
   - `package.json` / `package-lock.json`: Update root name to `p2p-multiple-groups`.

2. **Phase 2: Multi-group Signaling & Invitations**:
   - `services/signaling/server.ts`, `services/signaling/config.ts`, `scripts/create-invite.ts`.

3. **Phase 3: Peer Engine, Transport & Supernodes**:
   - `src/main/p2p/signaling-client.ts`, `src/main/p2p/engine.ts`, `src/main/p2p/transport.ts`.

4. **Phase 4: File Grants, Catalogs, Searches & Transfers**:
   - Scoped file permissions, multi-group transfers, security tests.

5. **Phase 5: Electron IPC, Preload, UI & Desktop Rename**:
   - IPC prefix switch, React multi-group selector, branding updates.

6. **Phase 6: Credentials, Operations & Final Verification**:
   - Secure remembering via safeStorage, deployment templates, full test suite.
