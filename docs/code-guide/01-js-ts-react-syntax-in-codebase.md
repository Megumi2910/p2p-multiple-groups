# Chapter 1: JS, TS, Node.js & React 19 Syntax in the Codebase

> **Category**: Code Guide & Syntax Deep-Dive  
> **Language**: English  
> **Architecture Version**: v2 (Multi-Group Overlay Network)  
> **Compatibility**: Node.js >=24.12.0, Electron 44.10.1, React 19.3.0, TypeScript 5.9.3, Vite 7.3.7  

---

## Table of Contents

1. [Core JavaScript Syntax](#cu-phap-js-cot-loi)
   - 1.1. Variable Declarations (`const` vs `let`) and Block Scope
   - 1.2. Strict Equality (`===`, `!==`) and Truthiness/Falsiness
   - 1.3. Short-Circuit Evaluation (`&&`, `||`), Nullish Coalescing (`??`), and Optional Chaining (`?.`)
   - 1.4. Template Literals, Object Property Shorthand, and Destructuring Assignment
   - 1.5. Arrow Functions and Higher-Order Array Methods (`.filter()`, `.map()`, `.some()`, `.every()`, `.find()`, `.sort()`)
2. [ES Modules and Dynamic Imports](#es-modules-va-import)
   - 2.1. Named Exports, Default Exports, and Type-Only Imports (`import type`)
   - 2.2. Dynamic Import with Top-Level Await in Hybrid Environments
3. [TypeScript Type System in the Project](#he-thong-kieu-typescript)
   - 3.1. `interface` vs `type` Aliases
   - 3.2. Literal Types and Tagged / Discriminated Unions
   - 3.3. Intersection Types and `readonly` Modifiers
   - 3.4. Const Assertions (`as const`) and Indexed Access Types
   - 3.5. Utility Types (`Partial`, `Record`, `Extract`, `Parameters`)
   - 3.6. Generics (`<T>`) in Asynchronous Concurrency Queues
   - 3.7. `unknown` vs `any` and User-Defined Type Guards
   - 3.8. Function Overloads in TypeScript Interfaces
4. [Asynchrony, Promises, and Concurrency Queues](#bat-dong-bo-promise-async-await)
   - 4.1. Event Loop, Microtask Queue, and Promises
   - 4.2. Promise Chain Serialization Pattern
   - 4.3. Timer Management and the 200ms Trailing State Throttle
5. [Data Structures and Node.js Built-in APIs](#cau-truc-du-lieu-va-node-api)
   - 5.1. `Map`, `Set`, and Automatic Garbage Collection with `WeakMap`
   - 5.2. Binary Buffers, Streaming SHA-256 Hashes, RFC 5766 HMAC-SHA1, and Constant-Time Equality (`timingSafeEqual`)
6. [React 19 & JSX Mechanics](#react-19-jsx-va-hooks)
   - 6.1. JSX Syntax and Rendering Rules
   - 6.2. The Core Quartet of React Hooks: `useState`, `useEffect`, `useCallback`, `useRef`

---

<section id="cu-phap-js-cot-loi">

## 1. Core JavaScript Syntax

The entire business and networking logic of `p2p-multiple-groups` is built on modern JavaScript (ECMAScript 2022+). Below are the foundational syntax patterns that appear across every file in the project.

### 1.1. Variable Declarations (`const` vs `let`) and Block Scope

In this codebase, `var` is strictly forbidden. Only two variable declaration keywords are used:

- **`const`**: Creates an immutable binding. A variable declared with `const` cannot be reassigned using `=`, though nested properties within objects or elements within `Map`/`Set` instances remain mutable.
- **`let`**: Used exclusively when a variable's reference must be reassigned over time (e.g., counters, state flags, or queue tail pointers).

```typescript
// src/main/p2p/credential-store.ts
export class SafeCredentialStore implements CredentialStore {
  private readonly filePath: string                          // Immutable class field
  private readonly memoryCache = new Map<string, string>()  // Map reference is const, but contents are mutable
  private isLoaded = false                                   // State flag reassigned on load
  private queue: Promise<void> = Promise.resolve()           // Promise queue tail pointer reassigned on each enqueue
```

**Block Scope:**  
Both `const` and `let` obey lexical block scoping (enclosed within curly braces `{}`). When execution exits an `if`, `for`, or `try/catch` block, local variables are immediately destroyed:

```typescript
// src/main/p2p/search-index.ts
if (tokens.length === 0) return false
{
  const normalizedName = fileName.normalize('NFKC').toLowerCase()
  // normalizedName exists only within this block
}
```

### 1.2. Strict Equality (`===`, `!==`) and Truthiness/Falsiness

Loose equality operators `==` and `!=` are banned to eliminate JavaScript's implicit type coercion hazards (e.g., `0 == ''` evaluates to `true`, while `0 === ''` is correctly `false`).

- **Falsy values** in JavaScript comprise exactly 8 values: `false`, `0`, `-0`, `0n` (BigInt zero), `""` (empty string), `null`, `undefined`, and `NaN`.
- All other values—including empty arrays `[]` and empty plain objects `{}`—are **Truthy**!

```typescript
// src/shared/p2p.ts:349
export function validateDisplayName(name: string): { valid: true; value: string } | { valid: false; error: string } {
  if (typeof name !== 'string') {
    return { valid: false, error: 'Display name must be a string' }
  }
  const trimmed = name.trim()
  if (trimmed.length < 2 || trimmed.length > 32) {
    return { valid: false, error: 'Display name must be between 2 and 32 characters' }
  }
  return { valid: true, value: trimmed }
}
```

### 1.3. Short-Circuit Evaluation (`&&`, `||`), Nullish Coalescing (`??`), and Optional Chaining (`?.`)

- **Logical AND (`&&`)**: Evaluates from left to right; returns the first falsy operand or the last truthy operand.
  ```typescript
  // Render owner badge if and only if isOwner is true
  {isOwner && <span className="badge badge-warning">Owner</span>}
  ```
- **Nullish Coalescing (`??`)**: Unlike `||` (which falls back on any falsy value, including `0` or `""`), `??` falls back **only** when the left-hand operand is strictly `null` or `undefined`.
  ```typescript
  // Preserves 0 if joinOrder is 0, falling back to 999 only when null/undefined
  const order = peer.joinOrder ?? 999
  ```
- **Optional Chaining (`?.`)**: Safely accesses nested object properties or invokes nullable functions without throwing `TypeError: Cannot read properties of undefined`.
  ```typescript
  // Safely calls close() if activeConnection is non-null
  this.activeConnection?.close()
  ```

### 1.4. Template Literals, Object Shorthand, and Destructuring

- **Template Literals**: Enclosed in backticks (`` ` ``) with embedded expressions `${...}`:
  ```typescript
  const storageKey = `${groupKey}:owner`
  ```
- **Object Property Shorthand**: When variable name matches property key, redundant repetition is omitted:
  ```typescript
  const options = { groupId, signalingUrl, token }
  ```
- **Destructuring Assignment**: Extracts properties directly into local scope:
  ```typescript
  const { groupId, signalingUrl } = parseGroupKey(groupKey)
  ```

### 1.5. Higher-Order Array Methods

The codebase favors immutable functional array transformations:

1. **`.filter()`**: Creates a new array with elements that pass the predicate.
2. **`.sort()`**: In-place array sort with deterministic tie-breaking:
   ```typescript
   // src/main/p2p/election.ts
   eligiblePeers.sort((a, b) => {
     if (a.joinOrder !== b.joinOrder) return a.joinOrder - b.joinOrder
     return a.peerId.localeCompare(b.peerId)
   })
   ```
3. **`.every()`**: Returns `true` if and only if all elements satisfy the predicate (Boolean AND):
   ```typescript
   // src/main/p2p/search-index.ts
   return tokens.every((token) => normalizedName.includes(token))
   ```
4. **`.some()`**: Returns `true` if at least one element satisfies the predicate (Boolean OR).
5. **`.find()`**: Finds the first matching element or returns `undefined`.
6. **`.map()`**: Transforms every element into a new representation.

</section>

---

<section id="es-modules-va-import">

## 2. ES Modules and Dynamic Imports

### 2.1. Named Exports, Default Exports, and Type-Only Imports (`import type`)

The repository sets `"type": "module"` in `package.json`. All source files use ECMAScript Modules (ESM).

- **Named Exports**: `export function electSupernodes(...)` — Enables granular tree-shaking by Rollup/esbuild.
- **Default Exports**: Used for the root React component (`export default function App()`) and Vite config.
- **Type-Only Imports**:
  ```typescript
  import type { SafeStorage } from 'electron'
  import { type ActionResult, makeGroupKey } from '../../shared/p2p.js'
  ```

Node.js 24 native type stripping requires pure types to be unambiguously marked with `import type` so the in-memory AST parser can erase them cleanly. This is enforced by `"erasableSyntaxOnly": true` in `tsconfig.node.json`.

### 2.2. Dynamic Import with Top-Level Await in Hybrid Environments

`SafeCredentialStore` runs in both the full Electron desktop app (where `electron.safeStorage` exists) and standalone Node.js unit tests (where Electron binaries are absent). To prevent `ERR_MODULE_NOT_FOUND` during `npm test`, it employs top-level dynamic imports:

```typescript
// src/main/p2p/credential-store.ts:33-42
let electronSafeStorage: SafeStorage | null = null

try {
  const electron = await import('electron')
  if (electron && typeof electron === 'object' && 'safeStorage' in electron && electron.safeStorage) {
    electronSafeStorage = electron.safeStorage as SafeStorage
  }
} catch {
  // Catch block triggers in headless Node.js tests; safely falls back to memoryCache
}
```

</section>

---

<section id="he-thong-kieu-typescript">

## 3. TypeScript Type System in the Project

### 3.1. `interface` vs `type` Aliases

- `interface` defines object contracts and supports extension via `extends`:
  ```typescript
  // src/shared/p2p.ts:22-27
  export interface GroupInvitation {
    version: 2
    signalingUrl: string
    groupId: string
    token: string
  }
  ```
- `type` is used for union types, primitive aliases, and intersections:
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

### 3.2. Literal Types and Tagged / Discriminated Unions

Discriminated unions ensure type safety at network and IPC boundaries by sharing a common discriminant property:

```typescript
// src/shared/p2p.ts
export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: P2pErrorCode; message: string }
```

When checking `result.ok`, TypeScript automatically narrows the type:

```typescript
const result = await window.p2p.p2p.joinGroup(options)
if (!result.ok) {
  // TypeScript narrows result to error variant; code and message are guaranteed!
  console.error(`Error [${result.code}]: ${result.message}`)
  return
}
```

### 3.3. Const Assertions (`as const`)

`as const` turns mutable objects or arrays into deeply read-only literal types:

```typescript
// src/shared/contracts.ts
export const IPC_CHANNELS = {
  THEME_GET: 'p2p:theme:get',
  THEME_SET: 'p2p:theme:set',
  P2P_V2_CREATE_GROUP: 'p2p:createGroup',
  P2P_V2_JOIN_GROUP: 'p2p:joinGroup',
  P2P_V2_STATE: 'p2p:state'
  // ...
} as const
```

### 3.4. User-Defined Type Guards

Type guards use the `value is T` return type predicate to inform TypeScript's control-flow analysis:

```typescript
// src/shared/contracts.ts
export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}
```

</section>

---

<section id="bat-dong-bo-promise-async-await">

## 4. Asynchrony, Promises, and Concurrency Queues

### 4.1. Event Loop and Asynchronous Execution

Node.js executes JavaScript on a single-threaded Event Loop backed by `libuv`:
1. **Call Stack**: Synchronous code execution.
2. **Microtask Queue**: Resolved Promise callbacks and `queueMicrotask` (executed immediately when the Call Stack empties, before I/O).
3. **Macrotask Queue**: I/O callbacks, `setTimeout`, and network packet events.

### 4.2. Promise Chain Serialization Pattern

To serialize concurrent mutations without race conditions, `PeerEngine`, `MultiGroupPeerStore`, and `SafeCredentialStore` implement sequential Promise chaining:

```typescript
// src/main/p2p/engine.ts
let policyQueue: Promise<void> = Promise.resolve()

function queueAction<T>(action: () => Promise<T>): Promise<T> {
  const enqueued = policyQueue.then(() => {
    if (isDisposed) {
      return Promise.reject(new Error('Engine disposed'))
    }
    return action()
  })

  // Crucial: Swallow errors on the queue tail so a failure in action A does not abort action B!
  policyQueue = enqueued.then(
    () => {},
    () => {}
  )

  return enqueued
}
```

### 4.3. Timer Management and Trailing 200ms State Throttle

High-frequency P2P state changes are coalesced before IPC dispatching to protect the React UI from frame drops:

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

</section>

---

<section id="cau-truc-du-lieu-va-node-api">

## 5. Data Structures and Node.js Built-in APIs

### 5.1. `Map`, `Set`, and Memory Leak Prevention via `WeakMap`

- `Map<GroupKey, GroupRuntime>`: $O(1)$ lookup table for active group runtimes.
- `WeakMap<WebSocket, string>`: Holds weak references to active client sockets. When a socket closes and its reference drops, the garbage collector automatically reclaims the memory, preventing leaks.

### 5.2. Cryptographic Security Primitives

1. **Streaming SHA-256 Digest**:
   ```typescript
   import { createHash } from 'node:crypto'
   const hasher = createHash('sha256')
   for await (const chunk of stream) hasher.update(chunk)
   const finalSha256 = hasher.digest('hex')
   ```
2. **RFC 5766 HMAC-SHA1 Ephemeral TURN Tokens**:
   ```typescript
   import { createHmac } from 'node:crypto'
   const turnPassword = createHmac('sha1', turnSecret).update(username).digest('base64')
   ```
3. **Timing-Attack Defense (`timingSafeEqual`)**:
   Standard string equality (`===`) short-circuits on the first mismatched byte, creating timing side channels. Node's `timingSafeEqual` verifies buffers in constant time:
   ```typescript
   import { timingSafeEqual } from 'node:crypto'
   if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
     return sendError(ws, 'INVALID_TOKEN', 'Group token rejected')
   }
   ```

</section>

---

<section id="react-19-jsx-va-hooks">

## 6. React 19 & JSX Mechanics

### 6.1. JSX Syntax and Reconciliation

React 19 compiles JSX tags into optimized `jsx()` calls. Key conventions include:
- `className` instead of `class`.
- Unique, stable `key` attributes on list items (e.g., `<tr key={peer.peerId}>`).
- Synthetic event handlers (`onClick`, `onChange`, `onSubmit`).

### 6.2. Core React Hooks in the UI

1. **`useState`**: Manages reactive view state.
2. **`useEffect`**: Subscribes to IPC state updates and always returns a cleanup function:
   ```typescript
   useEffect(() => {
     const unsubscribe = window.p2p.p2p.onState((incomingState) => {
       if (incomingState.revision >= lastRevisionRef.current) {
         lastRevisionRef.current = incomingState.revision
         setState(incomingState)
       }
     })
     return () => { unsubscribe() }
   }, [])
   ```
3. **`useCallback`**: Memoizes function references to prevent unnecessary child re-renders.
4. **`useRef`**: Holds mutable values across renders without triggering a re-render (e.g., `<dialog>` DOM references or monotonic revision counters).

---

## Chapter Summary

1. Variable immutability (`const`, `readonly`) and functional array operators (`.filter()`, `.map()`, `.every()`) ensure deterministic state.
2. Discriminated unions and user-defined type guards secure network and IPC contracts at compile time.
3. The `policyQueue` Promise chaining pattern eliminates concurrency race conditions while isolating errors.
4. Memory management is proactive: `WeakMap` prevents socket leaks and `useEffect` cleanups discard stale IPC listeners.
5. Next: Read [Chapter 2: Shared Contracts, Preload Bridge & Signaling Code](02-shared-preload-and-signaling-code.md) to inspect the concrete implementation of these principles.
