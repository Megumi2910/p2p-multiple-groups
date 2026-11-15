# JS, TS, Node.js & npm Fundamentals: A Java Developer's Deep Dive & Build Pipeline Reference

> **Who is this guide for?** This comprehensive reference is designed for Java, Maven, Gradle, C#, C++, or backend engineers who are navigating JavaScript (JS), TypeScript (TS), Node.js, and `npm` in the **`p2p-multiple-groups`** repository. It maps familiar Java/JVM and build-tool abstractions directly to modern JS/TS concepts, demystifies the multi-process Electron architecture and TypeScript configuration split, dissects every single line of `npm run build` terminal output, and documents all 19 CLI commands in exhaustive detail.

---

## Quick Navigation Index

1. [Section 1: Core Ecosystem & Mental Model for Java Developers](#he-sinh-thai-js-ts-node-npm)
2. [Section 2: Three-Process Electron Architecture & Three tsconfig Configurations](#kien-truc-build-electron-vite)
3. [Section 3: Anatomy of npm run build: Output, Entry Points, Bundling Pipeline & ./out/ Artifacts](#giai-phau-lenh-npm-run-build)
4. [Section 4: Complete Quick-Reference Table of All 19 CLI Commands](#bang-tra-cuu-nhanh-cac-lenh)
5. [Section 5: In-Depth Breakdown of All 19 Commands](#giai-thich-chi-tiet-tung-lenh)
6. [Section 6: Practical Step-by-Step Workflows](#quy-trinh-thuc-te)

---

## <a id="he-sinh-thai-js-ts-node-npm"></a>1. Core Ecosystem & Mental Model for Java Developers

Coming from the Java/JVM ecosystem (or C#, Go, and C++), looking at a repository filled with `.js`, `.ts`, `.tsx`, `.cjs`, `package.json`, `tsconfig*.json`, and `node_modules/` can feel disorienting. However, almost every concept in the modern Node.js and TypeScript ecosystem has a direct 1:1 equivalent in Java, Maven, and the JVM.

### 1.1. Java-to-JS/TS/Node/npm Rosetta Stone

The table below bridges your existing Java and Maven/Gradle knowledge directly to this codebase:

| Java / Maven / Gradle Concept | TypeScript / Node / npm Equivalent | Architectural Role & Implementation Details in This Codebase |
|---|---|---|
| **Source File (`.java`)** | **`src/**/*.ts`, `src/**/*.tsx`** | Statically typed source code. Files ending in `.tsx` contain React 19 JSX markup embedded directly inside TypeScript. |
| **Bytecode (`.class`)** | **Compiled JavaScript (`.js`, `.cjs`)** | Browsers and Node.js cannot execute TypeScript directly. TypeScript relies on **Type Erasure**: all type annotations, `interface`, and `type` declarations are stripped away, producing standard ECMAScript. |
| **JVM (HotSpot Runtime)** | **Node.js `>=24.12.0` (V8 + libuv)** & **Chromium V8** | Node.js provides the headless execution runtime (Google V8 JS engine + `libuv` C library for asynchronous non-blocking event-driven I/O) for the Main process, signaling service, and tests. Chromium V8 executes the UI Renderer process. |
| **Threads & `CompletableFuture<T>`** | **Single-Threaded Event Loop with `Promise<T>` & `async`/`await`** | Node.js does not spawn OS threads for concurrency; instead, a single-threaded Event Loop handles microtasks and macrotasks. `async`/`await` provides synchronous-looking syntax over asynchronous `Promise` pipelines. |
| **`pom.xml` / `build.gradle`** | **`package.json`** | The declarative manifest at the repository root defining package metadata, runtime engine constraints (`"node": ">=24.12.0"`), task scripts, and library dependencies. |
| **`gradle.lockfile` / Maven checksums** | **`package-lock.json`** | Exact tree of resolved dependencies with cryptographic SHA-512 integrity digests, guaranteeing byte-for-byte reproducible builds across developer machines and CI/CD pipelines. |
| **`~/.m2/repository` (Local Cache)** | **`./node_modules/`** | The project-local directory where `npm` installs third-party dependency packages. Unlike `~/.m2`, `node_modules` is scoped to the repository and is strictly excluded from version control (`.gitignore`). |
| **Maven `<scope>compile</scope>`** | **`"dependencies"`** | Runtime dependencies packaged into the production application: `react@19.3.0`, `react-dom@19.3.0`, `werift@^0.24.4` (pure Node.js WebRTC), and `ws@^8.21.3` (RFC 6455 WebSockets). |
| **Maven `<scope>provided` / `test`** | **`"devDependencies"`** | Tooling and build-time dependencies: `electron@44.10.1`, `electron-vite@5.0.0`, `vite@7.3.7`, `typescript@5.9.3`, `@vitejs/plugin-react@5.2.0`, and `@types/*`. |
| **Stub JARs / C Header Files (`.h`)** | **Type Definition Packages (`@types/*`)** | Packages like `@types/node`, `@types/react`, `@types/react-dom`, and `@types/ws` contain zero executable JavaScript. They are pure `.d.ts` declaration headers providing static type definitions for libraries written in untyped JS or C++ native bindings. |
| **Maven Plugins (`<build><plugins>`)** | **`"scripts"` in `package.json` + `electron.vite.config.ts`** | Build lifecycle task runners. Running `npm run build` invokes `tsc` and Vite/Rollup bundling pipelines according to `electron.vite.config.ts`. |
| **JUnit 5 (`@Test`, `Assertions.*`)** | **Node.js Native Test Runner (`node:test`, `node:assert/strict`)** | Zero-dependency built-in testing engine in Node.js 24 using `describe()`, `it()`, and `assert.strictEqual()`, executed directly via `node --test`. |

### 1.2. Module Systems: ECMAScript Modules (ESM) vs. CommonJS (CJS)

In the Java ecosystem, Java 9 introduced the Java Module System (`module-info.java`). In JavaScript, two major module specifications coexist:

1. **ECMAScript Modules (ESM)**: The official modern JavaScript standard.
   - Syntax: `import { foo } from './bar.js'` and `export const bar = 42`.
   - In `package.json:5`, `"type": "module"` is configured. This instructs Node.js to treat all `.js` and `.ts` files as modern ES modules by default.
2. **CommonJS (CJS)**: The legacy Node.js module format.
   - Syntax: `const foo = require('./bar')` and `module.exports = { bar }`.
   - **Why does `.cjs` still exist in this project?**
     - Electron's Preload script (`out/preload/index.cjs`) runs in an isolated bridge context that requires CommonJS format when loaded by Electron's native browser window manager (`webPreferences.preload`).
     - Test launcher fixtures such as `tests/fixtures/electron-profile-launcher.cjs` use CommonJS to hook directly into Electron's early process bootstrapping before ES module loaders initialize.

### 1.3. The Two Ways TypeScript Executes in This Project

A critical distinction in this repository is that **TypeScript is not always pre-compiled to disk**:

```
                               ┌──────────────────────────────────────────────────────────┐
                               │                 TypeScript Source Code                   │
                               │               (.ts / .tsx in src, tests)                 │
                               └────────────────────────────┬─────────────────────────────┘
                                                            │
                         ┌──────────────────────────────────┴──────────────────────────────────┐
                         │                                                                     │
                         ▼                                                                     ▼
               [ PATH A: Zero-Build ]                                                 [ PATH B: Bundled ]
        Direct Node.js 24 Native Type Stripping                                  electron-vite / Vite / Rollup
  (services/signaling, scripts/*.ts, tests/**/*.ts)                                 (src/main, src/preload, src/renderer)
                         │                                                                     │
                         ▼                                                                     ▼
        Node.js >=24.12.0 in-memory AST parser                                Vite/Rollup compiles, bundles, tree-shakes,
       strips type annotations; executes pure JS                               and outputs optimized JS/CJS/HTML/CSS to:
             directly with 0 disk overhead.                                                   ./out/
```

- **Path A — Direct Node.js 24 Execution (Zero-Build Type Stripping)**:
  - Used by: `services/signaling/index.ts`, `scripts/create-invite.ts`, and all test suites under `tests/**/*.test.ts`.
  - Node.js version `>=24.12.0` natively implements **TypeScript Type Stripping**. When executing `node services/signaling/index.ts`, Node.js strips types in memory and runs the code instantly. No intermediate build tool, no `ts-node`, and no disk compilation is required.
  - To guarantee that only syntax safely strippable by Node.js 24 is used, `tsconfig.node.json` enforces:
    - `"erasableSyntaxOnly": true`: Disallows legacy non-erasable TypeScript features (such as runtime `enum` or `namespace`).
    - `"rewriteRelativeImportExtensions": true`: Enables clean module resolution for TypeScript execution.
- **Path B — Bundled Multi-Target Execution (`electron-vite`)**:
  - Used by: The desktop application (`src/main`, `src/preload`, `src/renderer`).
  - Electron requires packaging and bundling for sandboxing, tree-shaking, React JSX transpilation, and Content Security Policy injection. This is orchestrated by `electron-vite build`, outputting artifacts into `./out/`.

### 1.4. Ground-Truth Data Contracts: TypeScript Interfaces

In TypeScript, an `interface` defines a compile-time structural shape. During compilation, the interface undergoes **Type Erasure** and disappears completely from the runtime output.

For example, the canonical group invitation contract defined in `src/shared/p2p.ts:22-27` is:

```typescript
export interface GroupInvitation {
  version: 2
  signalingUrl: string
  groupId: string
  token: string
}
```

If any component attempts to construct or deserialize an invitation without `token` or with `version: 1`, the TypeScript compiler flags the error immediately during `npm run typecheck`, preventing runtime errors across the P2P swarm.

---

## <a id="kien-truc-build-electron-vite"></a>2. Three-Process Electron Architecture & Three tsconfig Configurations

### 2.1. Electron's Process Isolation Model

Electron applications do not run as a single monolithic process. Instead, they mirror modern multi-process browser architecture:

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                             MAIN PROCESS (Node.js Runtime)                                  │
│  src/main/index.ts -> out/main/index.js                                                     │
│  - Full OS access: file system (node:fs), WebRTC (werift), WebSocket (ws), OS Keychain      │
│  - PeerEngine, GroupRuntime, Highest Random Weight (HRW) Supernode Elections                │
│  - SafeCredentialStore (Windows DPAPI / macOS Keychain / Linux Secret Service)              │
│  - IPC Main Handlers: p2p:createGroup, p2p:joinGroup, p2p:rotateInvite, p2p:removeMember    │
└──────────────────────────────▲──────────────────────────────────▲───────────────────────────┘
                               │                                  │
                 IPC (ipcRenderer.invoke)            IPC State Broadcast (p2p:state)
                               │                                  │
┌──────────────────────────────┴──────────────────────────────────┴───────────────────────────┐
│                           PRELOAD SCRIPT (Sandbox Bridge Context)                           │
│  src/preload/index.ts -> out/preload/index.cjs                                              │
│  - Executes with contextIsolation: true                                                     │
│  - Strips Node.js internals and exposes window.p2p via contextBridge.exposeInMainWorld      │
│  - Validates IPC channel names against 22 strict IPC_CHANNELS contracts                     │
└──────────────────────────────────────────────▲──────────────────────────────────────────────┘
                                               │
                                 window.p2p Typed API
                                               │
┌──────────────────────────────────────────────┴──────────────────────────────────────────────┐
│                         RENDERER PROCESS (Chromium Web Sandbox)                             │
│  src/renderer/index.html -> out/renderer/index.html (React 19 SPA)                         │
│  - Zero Node.js access (process, require, Buffer are undefined)                             │
│  - Strict Content Security Policy (connect-src 'none' in production) injected by p2pCsp     │
│  - UI Views: Network, Shared Library, Search & Discovery, Transfers, Appearance            │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2. Content Security Policy (`p2pCsp`) Injection

In `electron.vite.config.ts:5-17`, the custom `p2pCsp(isDev)` Vite plugin intercepts the HTML build and replaces the `%P2P_CSP%` token in `src/renderer/index.html:5`:

- **Development (`npm run dev`)**:
  `connect-src 'self' ws://127.0.0.1:5173` allows Vite Hot Module Replacement (HMR) WebSockets to update the React UI live.
- **Production (`npm run build`)**:
  `connect-src 'none'` completely forbids the Renderer process from establishing any outbound HTTP or WebSocket connections. All networking MUST flow through the Main process via `window.p2p`.

### 2.3. The Three `tsconfig` Files Explained

TypeScript projects manage different execution environments using **Project References**. In this repository, `tsconfig.json` acts as the root coordinator, pointing to two distinct configurations:

```
                         tsconfig.json (Root Coordinator)
                         { "references": [
                             { "path": "./tsconfig.node.json" },
                             { "path": "./tsconfig.web.json" }
                         ]}
                                  │
            ┌─────────────────────┴─────────────────────┐
            ▼                                           ▼
   tsconfig.node.json                         tsconfig.web.json
   Target: Node.js Environment                Target: Chromium Browser Sandbox
   Types: ["node"]                            Types: ["vite/client"]
   Files: main, preload, services, tests      Files: renderer (React 19 .tsx)
```

The compiler options configured across these files include:

- `"composite": true`: Allows TypeScript to build Project References incrementally and verify boundaries between Node and Web environments.
- `"target": "ESNext"` & `"module": "ESNext"`: Emits modern ECMAScript standard syntax without generating verbose legacy ES5 polyfills.
- `"moduleResolution": "Bundler"`: Uses modern bundler-aware module resolution compatible with Vite and Rollup.
- `"strict": true`: Enables all strict type-checking options (`noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`).
- `"verbatimModuleSyntax": true`: Enforces explicit `import type { Foo }` syntax for type-only imports so that bundlers can drop them with 100% certainty during Type Erasure.
- `"erasableSyntaxOnly": true`: Guarantees code compatibility with Node 24 native in-memory type stripping.
- `"rewriteRelativeImportExtensions": true`: Enables seamless relative import path mapping across TypeScript files.
- `"jsx": "react-jsx"`: Configured in `tsconfig.web.json` to enable React 19's automatic JSX transform without requiring `import React from 'react'` in every file.
- `"skipLibCheck": true`: Skips type checking of `.d.ts` declaration files inside `node_modules/` to drastically reduce typecheck duration.

---

## <a id="giai-phau-lenh-npm-run-build"></a>3. Anatomy of `npm run build`: Terminal Output, Entry Points, Bundling Pipeline & `./out/` Artifacts

When you execute `npm run build` in the terminal, `electron-vite` performs an optimized, multi-phase build. Below is the exact terminal output captured directly from this repository, followed by an exhaustive breakdown of every phase and artifact.

### 3.1. Terminal Output Trace

```text
> p2p-multiple-groups@0.1.0 build
> npm run typecheck && electron-vite build

> p2p-multiple-groups@0.1.0 typecheck
> npm run typecheck:node && npm run typecheck:web

> p2p-multiple-groups@0.1.0 typecheck:node
> tsc --noEmit -p tsconfig.node.json --composite false

> p2p-multiple-groups@0.1.0 typecheck:web
> tsc --noEmit -p tsconfig.web.json --composite false

vite v7.3.7 building ssr environment for production...
transforming...
✓ 16 modules transformed.
rendering chunks...
out/main/index.js  217.90 kB
✓ built in 324ms

vite v7.3.7 building ssr environment for production...
transforming...
✓ 2 modules transformed.
rendering chunks...
out/preload/index.cjs  4.01 kB
✓ built in 19ms

vite v7.3.7 building client environment for production...
transforming...
✓ 37 modules transformed.
rendering chunks...
../../out/renderer/index.html                   0.62 kB
../../out/renderer/assets/index-B2QFJOqy.css   15.37 kB
../../out/renderer/assets/index-DaQqRAeS.js   739.87 kB
✓ built in 660ms
```

### 3.2. Phase 1: Static Typecheck (`npm run typecheck`)

Before invoking Vite, `package.json:20` chains `npm run typecheck`:
1. `npm run typecheck:node`: Executes `tsc --noEmit -p tsconfig.node.json --composite false`.
2. `npm run typecheck:web`: Executes `tsc --noEmit -p tsconfig.web.json --composite false`.

- **Why is there no terminal output on success?**
  Following standard Unix/POSIX CLI conventions, the compiler remains silent when zero errors are found and exits with status code `0`.
- **Why `--noEmit`?**
  `tsc` is used exclusively as a static type analyzer. It writes zero files to disk, leaving file generation entirely to Vite.

### 3.3. Phase 2: Multi-Target Bundling via `electron-vite build`

`electron-vite` reads `electron.vite.config.ts` and sequentially runs **three distinct Vite builds**:

#### Build 1: Main Process Target (`out/main/index.js`)
- **Vite Banner**: `vite v7.3.7 building ssr environment for production...`
- **Why does it say `ssr environment`?**
  In Vite terminology, any compilation target designed to run in a Node.js runtime (rather than inside a browser DOM) is designated as an **SSR (Server-Side Runtime) environment**.
  In SSR mode, Vite **externalizes** Node.js built-in modules (`node:fs`, `node:crypto`, `node:path`, `node:http`) and heavy npm dependencies (`electron`, `werift`, `ws`). These dependencies are loaded directly from `node_modules` at runtime rather than being bundled into `index.js`.
- **Entry Point**: Defaults to `src/main/index.ts`. Configured in `electron.vite.config.ts:23-32` with `output: { format: 'es', entryFileNames: 'index.js' }`.
- **Transformed Modules (`✓ 16 modules transformed`)**:
  Vite traces the import graph from `src/main/index.ts`:
  `menu.ts`, `theme-store.ts`, `profile-migration.ts`, `p2p/engine.ts`, `p2p/election.ts`, `p2p/credential-store.ts`, `p2p/peer-store.ts`, `p2p/library.ts`, `p2p/search-index.ts`, `p2p/signaling-client.ts`, `p2p/transport.ts`, `p2p/transfers.ts`, and shared contracts.
- **Output Artifact**: `./out/main/index.js` (~217.90 kB). Matches `"main": "./out/main/index.js"` in `package.json:6`.

#### Build 2: Preload Script Target (`out/preload/index.cjs`)
- **Vite Banner**: `vite v7.3.7 building ssr environment for production...`
- **Why `ssr environment` again?**
  The Preload script executes in Electron's Node-enabled sandbox bridge context before the web page loads, so it is built as a second Node/SSR target.
- **Entry Point**: Defaults to `src/preload/index.ts`. Configured in `electron.vite.config.ts:33-42` with `output: { format: 'cjs', entryFileNames: 'index.cjs' }`.
- **Transformed Modules (`✓ 2 modules transformed`)**:
  `src/preload/index.ts` and `src/shared/contracts.ts` (all type-only imports from `src/shared/p2p.ts` are erased during compilation).
- **Output Artifact**: `./out/preload/index.cjs` (~4.01 kB). CommonJS bundle loaded by `src/main/index.ts` when instantiating `BrowserWindow`.

#### Build 3: Renderer Process Target (`out/renderer/`)
- **Vite Banner**: `vite v7.3.7 building client environment for production...`
- **Why `client environment`?**
  The Renderer runs inside sandboxed Chromium with zero Node.js access. Vite treats it as a standard client-side browser Single-Page Application (SPA), bundling React 19 and React DOM directly into the output JavaScript.
- **Entry Point**: `src/renderer/index.html`. Enhanced by plugins `[react(), p2pCsp(isDev)]` in `electron.vite.config.ts:43-50`.
- **Output Artifacts (`✓ 37 modules transformed`)**:
  1. `out/renderer/index.html` (~0.62 kB): The production HTML document. `p2pCsp(false)` injects the strict CSP `connect-src 'none'`. Vite replaces the dev `<script type="module" src="./src/main.tsx">` tag with production asset links:
     `<script type="module" crossorigin src="./assets/index-DaQqRAeS.js"></script>` and `<link rel="stylesheet" crossorigin href="./assets/index-B2QFJOqy.css">`.
  2. `out/renderer/assets/index-B2QFJOqy.css` (~15.37 kB): Extracted, minified stylesheet compiled from `src/renderer/src/assets/main.css`.
  3. `out/renderer/assets/index-DaQqRAeS.js` (~739.87 kB): The compiled, tree-shaken, and minified client bundle containing React 19, React DOM, `App.tsx`, all feature views (`Network`, `Library`, `Search`, `Transfers`, `Appearance`), and `usePeerState.ts`. The 8-character suffix (`DaQqRAeS`) is a cryptographic content hash for immutable caching.

---

## <a id="bang-tra-cuu-nhanh-cac-lenh"></a>4. Complete Quick-Reference Table of All 19 CLI Commands

| # | CLI Command | Under-the-Hood Execution Script | Target Process / Layer | Primary Purpose |
|---|---|---|---|---|
| 1 | `npm install` | `npm install` | Local Workspace (`node_modules`) | Resolves, verifies SHA-512 hashes, and extracts dependencies. |
| 2 | `npm run dev` | `electron-vite dev --watch` | Main + Preload + Renderer | Starts Electron in development mode with React Fast Refresh and Vite HMR. |
| 3 | `npm run build` | `npm run typecheck && electron-vite build` | All 3 Electron Processes | Validates types and compiles production bundles into `./out/`. |
| 4 | `npm run start` | `electron-vite preview` | Packaged Production App | Launches the production desktop app from compiled `./out/` artifacts. |
| 5 | `npm run typecheck:node` | `tsc --noEmit -p tsconfig.node.json --composite false` | Main, Preload, Services, Tests | Validates static types across all Node.js targets without emitting files. |
| 6 | `npm run typecheck:web` | `tsc --noEmit -p tsconfig.web.json --composite false` | Renderer (React 19 UI) | Validates static types across all web and React UI components. |
| 7 | `npm run typecheck` | `npm run typecheck:node && npm run typecheck:web` | Full Repository | Sequentially runs both Node and Web static typechecks. |
| 8 | `npm run test:unit` | `node --test tests/theme-store.test.ts ...` | Core Stores & Wire Codecs | Runs the 6 isolated unit test suites using the Node test runner. |
| 9 | `npm run test:p2p` | `node --test tests/signaling-server.test.ts ...` | Multi-Peer P2P Swarms | Runs the 9 integration test suites (Werift WebRTC, HRW, flow control). |
| 10 | `npm run test:e2e` | `node --test tests/electron-e2e.test.ts` | Headless Electron via CDP | Spawns Electron with Chrome DevTools Protocol and exercises the UI. |
| 11 | `npm test` | `npm run test:unit && npm run test:p2p && npm run test:e2e` | Entire Test Suite | Runs all unit, P2P integration, and E2E suites consecutively. |
| 12 | `npm run signal:start` | `node --env-file-if-exists=.env services/signaling/index.ts` | Standalone Signaling Server | Starts the standalone WebSocket signaling service on port 8787. |
| 13 | `npm run signal:invite` | `node --env-file-if-exists=.env scripts/create-invite.ts` | Signaling Utility Script | Generates V2 invitation JSON or short invite codes for a virtual group. |
| 14 | `npm run docker:build` | `docker build -t p2p-multiple-groups-signaling .` | Docker Container Image | Builds the standalone signaling container image from `Dockerfile`. |
| 15 | `npm run docker:up` | `docker compose --env-file .env up -d --build` | Docker Compose Stack | Launches signaling and Coturn services in background containers. |
| 16 | `npm run docker:down` | `docker compose down` | Docker Compose Stack | Stops and removes active signaling containers and associated networks. |
| 17 | `npm run docs:open` | `node scripts/open-docs.js` | Interactive Documentation | Opens `docs/index.html` in the user's default OS web browser. |
| 18 | `npm run docs:screenshots` | `node scripts/capture-docs-screenshots.ts` | CDP Screenshot Automation | Launches headless Electron to capture production UI screenshots. |
| 19 | `node scripts/verify-html-docs.js` | `node scripts/verify-html-docs.js` | Documentation Integrity | Verifies all 25 HTML files, anchor targets, links, images, and scripts. |

---

## <a id="giai-thich-chi-tiet-tung-lenh"></a>5. In-Depth Breakdown of All 19 Commands

### 5.1. Dependency & Lifecycle Management

#### Command 1: `npm install`
- **What it does**: Reads `package.json` and `package-lock.json`, downloads all missing packages into `./node_modules/`, and verifies their SHA-512 cryptographic checksums.
- **Java Analogy**: Equivalent to `mvn dependency:resolve` or Gradle downloading dependencies into the local cache.
- **Tip**: In CI/CD pipelines, use `npm ci` (Clean Install) to strictly enforce that `package-lock.json` matches `package.json` without modifying the lockfile.

#### Command 2: `npm run dev`
- **Script**: `electron-vite dev --watch`
- **Flags**:
  - `--watch`: Watches filesystem changes in `src/main`, `src/preload`, and `src/renderer`. Changes to React components trigger instantaneous Hot Module Replacement (HMR) without restarting the Electron app.
- **Under the hood**: Spawns Vite dev server on `127.0.0.1:5173` for the renderer, compiles main and preload scripts into memory/temp buffers, and launches Electron.

#### Command 3: `npm run build`
- **Script**: `npm run typecheck && electron-vite build`
- **Flags**: Chained execution (`&&`). If typechecking fails, the build terminates immediately with exit code `1`.
- **Under the hood**: Validates types across all Node and Web targets, then invokes Rollup and esbuild to output production bundles to `./out/main/index.js`, `./out/preload/index.cjs`, and `./out/renderer/`.

#### Command 4: `npm run start`
- **Script**: `electron-vite preview`
- **Under the hood**: Launches Electron directly against the compiled artifacts in `./out/`, verifying that the production bundle behaves identically to the development version without running any development servers.

---

### 5.2. Typechecking Suite

#### Command 5: `npm run typecheck:node`
- **Script**: `tsc --noEmit -p tsconfig.node.json --composite false`
- **Flags**:
  - `--noEmit`: Suppresses file emission to disk.
  - `-p tsconfig.node.json`: Targets the Node.js TypeScript configuration.
  - `--composite false`: Overrides `"composite": true` during standalone CLI typecheck to prevent generating `.tsbuildinfo` files on disk.

#### Command 6: `npm run typecheck:web`
- **Script**: `tsc --noEmit -p tsconfig.web.json --composite false`
- **Flags**: Targets `tsconfig.web.json` to validate React 19 JSX components and browser APIs (`window.p2p`, DOM events).

#### Command 7: `npm run typecheck`
- **Script**: `npm run typecheck:node && npm run typecheck:web`
- **Under the hood**: Performs a complete repository-wide static type check covering all 3 Electron processes, test files, scripts, and signaling services.

---

### 5.3. Automated Testing Suite

#### Command 8: `npm run test:unit`
- **Script**: Executes 6 unit test files sequentially via Node's native test runner:
  - `tests/theme-store.test.ts` (Theme persistence)
  - `tests/credential-store.test.ts` (SafeCredentialStore DPAPI/Keychain encryption and memory fallback)
  - `tests/peer-store-v2.test.ts` (MultiGroupPeerStore atomic `.tmp` commit persistence)
  - `tests/profile-migration.test.ts` (Legacy profile directory migration)
  - `tests/signaling-config.test.ts` (Signaling environment variable parsing and validation)
  - `tests/p2p-protocol.test.ts` (Binary wire codec serialization and message validation)

#### Command 9: `npm run test:p2p`
- **Script**: Executes 9 comprehensive multi-peer P2P integration test suites:
  - `tests/signaling-server.test.ts` (Signaling WebSocket state machines and rate limiting)
  - `tests/signaling-client.test.ts` (Client reconnection, leases, and heartbeat management)
  - `tests/p2p-integration.test.ts` (End-to-end Werift WebRTC data channel establishment)
  - `tests/p2p-library-search.test.ts` (Distributed inverted search index and query routing)
  - `tests/p2p-transfers.test.ts` (Chunked 16 KiB file transfers and sliding-window ACKs)
  - `tests/p2p-transfers-survival.test.ts` (Transfer survival during simulated network stalls)
  - `tests/p2p-multi-group.test.ts` (Concurrent multi-group multiplexing over pooled connections)
  - `tests/p2p-group-security.test.ts` (Owner authorization, invite rotation, and member removal)
  - `tests/p2p-engine-lifecycle.test.ts` (PeerEngine serialized policy queues and clean shutdown)

#### Command 10: `npm run test:e2e`
- **Script**: `node --test tests/electron-e2e.test.ts`
- **Under the hood**: Spawns the packaged Electron executable with `--remote-debugging-port=0`, connects via Chrome DevTools Protocol (CDP), navigates between views, and verifies the `window.p2p` sandbox bridge.

#### Command 11: `npm test`
- **Script**: `npm run test:unit && npm run test:p2p && npm run test:e2e`
- **Under the hood**: Executes all 16 test suites across all 3 testing tiers consecutively.

---

### 5.4. Signaling & Container Operations

#### Command 12: `npm run signal:start`
- **Script**: `node --env-file-if-exists=.env services/signaling/index.ts`
- **Flags**:
  - `--env-file-if-exists=.env`: Automatically loads configuration from `.env` if present, without throwing an error if absent.
- **Under the hood**: Starts the Node.js 24 standalone WebSocket signaling server on `0.0.0.0:8787`. Features dynamic group creation, invite rotation, token bucket rate limiting, and HTTP `/` health checks.

#### Command 13: `npm run signal:invite`
- **Script**: `node --env-file-if-exists=.env scripts/create-invite.ts`
- **Flags & Options**:
  - `--group-id=<id>`: Specifies the target virtual group identifier (defaults to first configured group).
  - `--code-only`: Prints only the compact base64url short invite code instead of full JSON.
  - `--`: The standard npm argument separator, required when passing custom flags to npm scripts:
    ```bash
    npm run signal:invite -- --group-id=engineering-team --code-only
    ```
- **Under the hood**: Reads `P2P_MULTIPLE_GROUPS_GROUPS_JSON` and `P2P_MULTIPLE_GROUPS_PUBLIC_SIGNAL_URL` from `.env`, extracts the group token, and formats the invitation.

#### Command 14: `npm run docker:build`
- **Script**: `docker build -t p2p-multiple-groups-signaling .`
- **Under the hood**: Builds a lightweight production Docker image containing the Node.js 24 signaling service.

#### Command 15: `npm run docker:up`
- **Script**: `docker compose --env-file .env up -d --build`
- **Flags**:
  - `--env-file .env`: Injects environment variables from `.env`.
  - `-d`: Detached mode (runs containers in the background).
  - `--build`: Rebuilds images before starting containers.
- **Under the hood**: Spawns the signaling container and optional Coturn TURN relay container defined in `docker-compose.yml`.

#### Command 16: `npm run docker:down`
- **Script**: `docker compose down`
- **Under the hood**: Stops and removes all background containers, networks, and ephemeral volumes created by `docker:up`.

---

### 5.5. Documentation & Verification Tooling

#### Command 17: `npm run docs:open`
- **Script**: `node scripts/open-docs.js`
- **Under the hood**: Resolves the absolute path to `docs/index.html` and launches it in the host operating system's default browser.

#### Command 18: `npm run docs:screenshots`
- **Script**: `node scripts/capture-docs-screenshots.ts`
- **Under the hood**: Runs headless Electron via CDP to capture high-resolution screenshots of all 6 application views (`Home`, `Network`, `Library`, `Search`, `Transfers`, `Appearance`) and saves them into `docs/assets/`.

#### Command 19: `node scripts/verify-html-docs.js`
- **Script**: `node scripts/verify-html-docs.js`
- **Under the hood**: Scans all 25 HTML files in `docs/`, parsing and verifying 900+ internal `<a href>` hyperlinks, `<section id="...">` anchors, images, stylesheets, and scripts, failing with exit code `1` if any link is broken.

---

## <a id="quy-trinh-thuc-te"></a>6. Practical Step-by-Step Workflows

### Workflow 1: First-Time Setup & Development Launch

```bash
# 1. Clone the repository and enter directory
git clone https://github.com/your-org/p2p-multiple-groups.git
cd p2p-multiple-groups

# 2. Install all dependencies and verify lockfile checksums
npm install

# 3. Verify static types across the codebase
npm run typecheck

# 4. Launch the application in development mode with Hot Module Replacement
npm run dev
```

### Workflow 2: Running a Local 2-Peer Swarm on One Machine

To test real P2P WebRTC data channels and file transfers locally, you need a signaling server and two peer instances:

```bash
# TERMINAL 1: Launch Signaling Server (using Docker or Node directly)
cp .env.example .env
npm run docker:up
# Or run directly: npm run signal:start

# TERMINAL 2: Launch Peer A (Development Mode)
npm run dev
# In Peer A UI:
# 1. Open "Network & Groups" -> Select "Create Group" -> Enter group name (e.g. "alpha-swarm")
# 2. Click "Create & Join" -> Peer A is elected Owner and Supernode
# 3. Click "Copy Invite Code" (or copy V2 JSON invitation)
# 4. Open "Library" -> Click "Add File" -> Select a file and check "alpha-swarm" to share it

# TERMINAL 3: Launch Peer B (Production Preview Mode)
npm run build
npm run start
# In Peer B UI:
# 1. Open "Network & Groups" -> Select "Join Group"
# 2. Paste the Invite Code copied from Peer A -> Click "Join Group"
# 3. Open "Search & Discovery" -> Search for the file shared by Peer A
# 4. Click "Download" -> Open "Transfers" to observe 16 KiB chunk flow over pure WebRTC!
```

### Workflow 3: Pre-Flight Quality Verification Before Committing

Always execute this 3-step verification checklist before submitting changes:

```bash
# Step 1: Ensure zero TypeScript type errors
npm run typecheck

# Step 2: Execute all 16 unit, P2P integration, and E2E test suites
npm test

# Step 3: Verify HTML documentation links, anchors, and assets
node scripts/verify-html-docs.js
```
