# Chapter 2: Shared Contracts, Preload Bridge & Signaling Code

> **Category**: Code Guide & Syntax Deep-Dive  
> **Language**: English  
> **Modules Analyzed**: `electron.vite.config.ts`, `src/shared/*`, `src/preload/index.ts`, `services/signaling/*`, `scripts/create-invite.ts`  
> **Architecture Version**: v2 (Multi-Group Overlay Network)  
> **Compatibility**: Node.js >=24.12.0, Electron 44.10.1, React 19.3.0, TypeScript 5.9.3, Vite 7.3.7  

---

## Table of Contents

1. [Build & Bundler Configuration (`electron.vite.config.ts`)](#electron-vite-config)
   - 1.1. `p2pCsp(isDev)` Plugin and `%P2P_CSP%` Token Injection
   - 1.2. Multi-Target Output: ES Module (`main`), CommonJS (`preload`), Browser SPA (`renderer`)
2. [IPC Contracts Registry (`src/shared/contracts.ts`)](#shared-contracts)
   - 2.1. The Canonical 22 IPC Channels Registry: `IPC_CHANNELS`
   - 2.2. The `P2pApi` Interface and `isThemePreference` Type Guard
3. [Domain Types & Strict Input Validators (`src/shared/p2p.ts`)](#shared-p2p)
   - 3.1. Standard Error Codes (`P2pErrorCode` - 15 Codes) and `ActionResult<T>`
   - 3.2. Canonical Group Identifiers: `GroupKey` (`JSON.stringify([signalingUrl, groupId])`)
   - 3.3. Group Creation and Joining Options: `CreateGroupOptions`, `JoinGroupOptions`, and `validateInviteCode`
   - 3.4. Input Validation Primitives: `validateSignalingUrl`, `validateGroupId`, `validateToken`, and `parseGroupInvitation`
4. [Wire Protocol & Runtime Type Guards (`src/shared/p2p-wire.ts`)](#shared-p2p-wire)
   - 4.1. File Channel Label Formats: `makeFileChannelLabelV2(groupId, transferId)`
   - 4.2. Signaling Wire Protocol Schemas: `ClientSignalingMessageV2` and `ServerSignalingMessageV2`
   - 4.3. Type Guards: `isClientSignalingMessageV2`, `isServerSignalingMessageV2`, `isOverlayControlMessageV2`, `isTransferControlMessageV2`
5. [Preload Security Bridge (`src/preload/index.ts`)](#preload-bridge)
   - 5.1. Context Isolation with `contextBridge.exposeInMainWorld('p2p', api)`
   - 5.2. Complete 19-Method `P2pMultipleGroupsP2pApi` Surface
6. [Signaling Service & CLI Tools (`services/signaling/*`, `scripts/create-invite.ts`)](#signaling-service)
   - 6.1. Environment Configuration Loader in `config.ts`
   - 6.2. Signaling Server Orchestrator in `server.ts`: Dynamic Group Creation, Constant-Time `ownerSecret` Verification, Invite Rotation, and Member Eviction
   - 6.3. CLI Utility: `scripts/create-invite.ts` (`--group-id`, `--code-only`)

---

<section id="electron-vite-config">

## 1. Build & Bundler Configuration (`electron.vite.config.ts`)

The `electron.vite.config.ts` configuration orchestrates the packaging and bundling of the three isolated Electron processes:

```typescript
// electron.vite.config.ts:19-52
export default defineConfig(({ command }) => {
  const isDev = command === 'serve'

  return {
    main: {
      build: {
        rollupOptions: {
          output: {
            format: 'es',              // Main process outputs ES Module
            entryFileNames: 'index.js'
          }
        }
      }
    },
    preload: {
      build: {
        rollupOptions: {
          output: {
            format: 'cjs',             // Preload script outputs CommonJS
            entryFileNames: 'index.cjs'
          }
        }
      }
    },
    renderer: {
      plugins: [react(), p2pCsp(isDev)],
      server: {
        host: '127.0.0.1',
        port: 5173,
        strictPort: true
      }
    }
  }
})
```

### 1.1. `p2pCsp(isDev)` Plugin and `%P2P_CSP%` Injection

The custom Vite plugin `p2pCsp(isDev)` injects the Content Security Policy into `src/renderer/index.html`:

```typescript
// electron.vite.config.ts:5-17
function p2pCsp(isDev: boolean): Plugin {
  const devCsp =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:5173; object-src 'none'; base-uri 'none'; form-action 'none'"
  const prodCsp =
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

  return {
    name: 'p2p-csp',
    transformIndexHtml(html: string): string {
      return html.replace('%P2P_CSP%', isDev ? devCsp : prodCsp)
    }
  }
}
```

In production, `connect-src 'none'` completely isolates the Renderer from network access, ensuring zero outbound HTTP/WebSocket requests can bypass the Preload IPC bridge.

</section>

---

<section id="shared-contracts">

## 2. IPC Contracts Registry (`src/shared/contracts.ts`)

All communication between the Main process and the Renderer process is governed by strictly typed IPC contracts.

### 2.1. The Canonical 22 IPC Channels

The codebase uses the canonical `p2p:*` channel names, frozen as literal types via `as const`:

```typescript
// src/shared/contracts.ts:14-37
export const IPC_CHANNELS = {
  THEME_GET: 'p2p:theme:get',
  THEME_SET: 'p2p:theme:set',
  COMMAND: 'p2p:command',
  P2P_V2_GET_STATE: 'p2p:getState',
  P2P_V2_STATE: 'p2p:state',
  P2P_V2_CREATE_GROUP: 'p2p:createGroup',
  P2P_V2_JOIN_GROUP: 'p2p:joinGroup',
  P2P_V2_RESUME_GROUP: 'p2p:resumeGroup',
  P2P_V2_LEAVE_GROUP: 'p2p:leaveGroup',
  P2P_V2_ROTATE_GROUP_INVITE: 'p2p:rotateGroupInvite',
  P2P_V2_REMOVE_GROUP_MEMBER: 'p2p:removeGroupMember',
  P2P_V2_SET_GROUP_AUTO_JOIN: 'p2p:setGroupAutoJoin',
  P2P_V2_SET_GROUP_ELIGIBILITY: 'p2p:setGroupEligibility',
  P2P_V2_FORGET_GROUP: 'p2p:forgetGroup',
  P2P_V2_DISCONNECT_ALL: 'p2p:disconnectAll',
  P2P_V2_ADD_FILES: 'p2p:addFiles',
  P2P_V2_RESCAN_LIBRARY: 'p2p:rescanLibrary',
  P2P_V2_REMOVE_FILE: 'p2p:removeFile',
  P2P_V2_SET_FILE_GROUPS: 'p2p:setFileGroups',
  P2P_V2_SEARCH: 'p2p:search',
  P2P_V2_DOWNLOAD: 'p2p:download',
  P2P_V2_CANCEL_TRANSFER: 'p2p:cancelTransfer'
} as const
```

### 2.2. The `P2pApi` Interface

The top-level `window.p2p` bridge implements `P2pApi`:

```typescript
// src/shared/contracts.ts:6-12
export interface P2pApi {
  readonly isMac: boolean
  getTheme(): Promise<ThemePreference>
  setTheme(theme: ThemePreference): Promise<ThemePreference>
  onCommand(listener: (command: ShellCommand) => void): () => void
  readonly p2p: P2pMultipleGroupsP2pApi
}
```

</section>

---

<section id="shared-p2p">

## 3. Domain Types & Strict Input Validators (`src/shared/p2p.ts`)

### 3.1. Standard Error Codes (`P2pErrorCode`)

The system defines exactly 15 standardized error code literals:

```typescript
// src/shared/p2p.ts:1-16
export type P2pErrorCode =
  | 'INVALID_INPUT'
  | 'AUTH_FAILED'
  | 'FORBIDDEN'
  | 'INVITATION_REQUIRED'
  | 'GROUP_EXISTS'
  | 'GROUP_FULL'
  | 'GROUP_NOT_FOUND'
  | 'SIGNALING_CLOSED'
  | 'SIGNALING_TIMEOUT'
  | 'SIGNALING_ERROR'
  | 'PEER_NOT_FOUND'
  | 'PEER_UNREACHABLE'
  | 'NO_SUPERNODE'
  | 'TRANSFER_FAILED'
  | 'TRANSFER_ABORTED'
```

### 3.2. Canonical `GroupKey`

A virtual group security boundary is identified by its canonical JSON-stringified key:

```typescript
// src/shared/p2p.ts:29-45
export type GroupKey = string & { readonly __brand: unique symbol }

export function makeGroupKey(signalingUrl: string, groupId: string): GroupKey {
  return JSON.stringify([signalingUrl, groupId]) as GroupKey
}

export function parseGroupKey(groupKey: string): { signalingUrl: string; groupId: string } {
  const parsed = JSON.parse(groupKey)
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    throw new Error(`Invalid group key format: ${groupKey}`)
  }
  return { signalingUrl: parsed[0], groupId: parsed[1] }
}
```

### 3.3. Group Creation and Joining Options

```typescript
// src/shared/p2p.ts:51-70
export interface CreateGroupOptions {
  groupId: string
  signalingUrl?: string
  supernodeEligible?: boolean
}

export interface JoinGroupOptions {
  invitation?: GroupInvitation
  inviteCode?: string
  signalingUrl?: string
  groupId?: string
  token?: string
  supernodeEligible?: boolean
}
```

Invite codes are validated using `validateInviteCode`:
```typescript
// /^[A-Za-z0-9_-]{8,64}$/
export function validateInviteCode(code: string): { valid: true; value: string } | { valid: false; error: string }
```

### 3.4. Input Validation Primitives

- `validateSignalingUrl(url)`: Enforces `ws://` or `wss://` protocols.
- `validateGroupId(groupId)`: Enforces alphanumeric characters, hyphens, and underscores (1–64 characters).
- `validateToken(token)`: Validates base64url-encoded 256-bit authentication tokens (43 characters).
- `parseGroupInvitation(input)`: Parses either a full V2 JSON string (`{ version: 2, signalingUrl, groupId, token }`) or a compact base64url short invite code.

</section>

---

<section id="shared-p2p-wire">

## 4. Wire Protocol & Runtime Type Guards (`src/shared/p2p-wire.ts`)

### 4.1. WebRTC Data Channel Label Format

WebRTC data channels for file transfers use the V2 format:

```typescript
// src/shared/p2p-wire.ts:15-17
export function makeFileChannelLabelV2(groupId: string, transferId: string): string {
  return `p2p-multiple-groups-file-v2:${groupId}:${transferId}`
}
```

### 4.2. Signaling Wire Protocol Schemas

Client messages sent over WebSocket to the signaling server:

```typescript
// src/shared/p2p-wire.ts:25-50
export type ClientSignalingMessageV2 =
  | { type: 'register'; peerId: string; displayName: string; supernodeEligible: boolean }
  | { type: 'create-group'; groupId: string }
  | { type: 'join-group'; groupId?: string; token: string; ownerSecret?: string; supernodeEligible: boolean }
  | { type: 'leave-group'; groupId: string }
  | { type: 'rotate-invite'; groupId: string; ownerSecret: string }
  | { type: 'remove-member'; groupId: string; targetPeerId: string; ownerSecret: string }
  | { type: 'heartbeat' }
  | { type: 'signal'; groupId: string; toPeerId: string; data: WebRtcSignalData }
```

Server messages returned to peers:

```typescript
// src/shared/p2p-wire.ts:52-85
export type ServerSignalingMessageV2 =
  | { type: 'registered'; peerId: string; sessionId: string; leaseMs: number }
  | { type: 'group-joined'; groupId: string; leaseMs: number; ownerPeerId?: string; inviteCode?: string }
  | { type: 'group-left'; groupId: string }
  | { type: 'invite-rotated'; groupId: string; inviteCode: string }
  | { type: 'group-kicked'; groupId: string; reason: string }
  | { type: 'roster'; groupId: string; epoch: number; revision: number; peers: SignalingRosterPeerV2[]; ownerPeerId?: string }
  | { type: 'signal'; groupId: string; fromPeerId: string; toPeerId: string; data: WebRtcSignalData }
  | { type: 'error'; code: string; message: string; groupId?: string }
```

</section>

---

<section id="preload-bridge">

## 5. Preload Security Bridge (`src/preload/index.ts`)

The preload script establishes a secure context bridge exposing `window.p2p`:

```typescript
// src/preload/index.ts
contextBridge.exposeInMainWorld('p2p', {
  isMac: process.platform === 'darwin',
  getTheme: () => ipcRenderer.invoke(IPC_CHANNELS.THEME_GET),
  setTheme: (theme) => ipcRenderer.invoke(IPC_CHANNELS.THEME_SET, theme),
  onCommand: (listener) => {
    const handler = (_event: unknown, command: ShellCommand) => listener(command)
    ipcRenderer.on(IPC_CHANNELS.COMMAND, handler)
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.COMMAND, handler) }
  },
  p2p: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_GET_STATE),
    onState: (listener) => {
      const handler = (_event: unknown, state: MultiGroupP2pState) => listener(state)
      ipcRenderer.on(IPC_CHANNELS.P2P_V2_STATE, handler)
      return () => { ipcRenderer.removeListener(IPC_CHANNELS.P2P_V2_STATE, handler) }
    },
    createGroup: (options) => ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_CREATE_GROUP, options),
    joinGroup: (options) => ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_JOIN_GROUP, options),
    rotateGroupInvite: (groupKey) => ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_ROTATE_GROUP_INVITE, groupKey),
    removeGroupMember: (groupKey, targetPeerId) => ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_REMOVE_GROUP_MEMBER, groupKey, targetPeerId),
    // ... all 19 P2pMultipleGroupsP2pApi methods
  }
})
```

</section>

---

<section id="signaling-service">

## 6. Signaling Service & CLI Tools (`services/signaling/*`, `scripts/create-invite.ts`)

### 6.1. Environment Configuration in `config.ts`

Loads configuration from environment variables with safe defaults:
- `P2P_MULTIPLE_GROUPS_SIGNALING_PORT` (default: `8787`)
- `P2P_MULTIPLE_GROUPS_PUBLIC_SIGNAL_URL` (default: `ws://127.0.0.1:8787/signal`)
- `P2P_MULTIPLE_GROUPS_GROUPS_JSON` (optional pre-seeded static groups)
- `P2P_MULTIPLE_GROUPS_TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`

### 6.2. Signaling Server Orchestration in `server.ts`

Key responsibilities:
1. **Dynamic Group Creation**: Peers create ad-hoc groups via `create-group`. The creator receives a 32-byte `ownerSecret`.
2. **Owner Verification**: `rotate-invite` and `remove-member` require constant-time validation of `ownerSecret` using `crypto.timingSafeEqual`.
3. **Owner Auto-Reseeding**: If a signaling server restarts and loses ephemeral group state, an owner reconnecting with their cached `ownerSecret` automatically restores the group with full ownership rights.
4. **Token-Bucket Rate Limiting**: Protects `/signal` WebSocket handshakes from denial-of-service attempts.
5. **Heartbeat Sweep**: Monitors peer leases every 2000ms. If a peer fails to heartbeat within 6000ms, it is removed from the roster and failover occurs.

### 6.3. CLI Utility: `scripts/create-invite.ts`

Generates invitations from the command line:

```bash
# Print full JSON invitation:
npm run signal:invite -- --group-id=engineering-team

# Print compact short invite code only:
npm run signal:invite -- --group-id=engineering-team --code-only
```

---

## Chapter Summary

1. `electron.vite.config.ts` uses `p2pCsp` to inject strict CSP `connect-src 'none'` into the production HTML.
2. The 22 `IPC_CHANNELS` provide unambiguous, type-safe communication between processes.
3. Groups are keyed by canonical JSON tuples: `JSON.stringify([signalingUrl, groupId])`.
4. Dynamic group ownership allows peers to create groups, rotate invite codes, and kick members with cryptographic `ownerSecret` tokens.
5. Next: Read [Chapter 3: Main Process & P2P Engine Core Walkthrough](03-main-process-and-p2p-engine-code.md).
