# Phần 1: Nền Tảng Cú Pháp JS, TS, Node.js & React 19 Trong Mã Nguồn

> **Chuyên mục**: Code Guide & Syntax Deep-Dive  
> **Ngôn ngữ**: Tiếng Việt (Giữ nguyên định danh kỹ thuật, cú pháp và tên file mã nguồn tiếng Anh)  
> **Phiên bản kiến trúc**: v2 (Multi-Group Overlay Network)  
> **Tương thích**: Node.js >=24.12.0, Electron 44.4, React 19.3, TypeScript 5.9  

---

## Mục lục nội dung

1. [Cú pháp JavaScript cốt lõi](#cu-phap-js-cot-loi)
   - 1.1. Khai báo biến (`const` vs `let`) và phạm vi khối (Block Scope)
   - 1.2. So sánh nghiêm ngặt (`===`, `!==`) và chân trị (Truthiness/Falsiness)
   - 1.3. Đoản mạch logic (`&&`, `||`), Nullish Coalescing (`??`) và Optional Chaining (`?.`)
   - 1.4. Template Literals, Object Shorthand và Destructuring Assignment
   - 1.5. Arrow Functions và các phương thức mảng bậc cao (`.filter()`, `.map()`, `.some()`, `.every()`, `.find()`, `.sort()`)
2. [ES Modules và Dynamic Imports](#es-modules-va-import)
   - 2.1. Named Exports, Default Exports và Type-Only Imports (`import type`)
   - 2.2. Dynamic Import với Top-Level Await trong môi trường lai
3. [Hệ thống kiểu dữ liệu TypeScript trong Project](#he-thong-kieu-typescript)
   - 3.1. `interface` vs `type` aliases
   - 3.2. Literal Types và Tagged / Discriminated Unions
   - 3.3. Intersection Types và `readonly` Modifiers
   - 3.4. Const Assertions (`as const`) và Indexed Access Types
   - 3.5. Utility Types (`Partial`, `Record`, `Extract`, `Parameters`, `ConstructorParameters`)
   - 3.6. Generics (`<T>`) trong hàng đợi bất đồng bộ
   - 3.7. `unknown` vs `any` và Type Guards định nghĩa bởi người dùng
   - 3.8. Function Overloads trong TypeScript Interfaces
4. [Bất đồng bộ, Promise và Concurrency Queues](#bat-dong-bo-promise-async-await)
   - 4.1. Event Loop, Microtask Queue và Promise
   - 4.2. Mẫu tuần tự hóa hàng đợi Promise (Promise Chain Serialization Pattern)
   - 4.3. Quản lý bộ đếm thời gian (Timers) và Trailing Throttle 200ms
5. [Cấu trúc dữ liệu và Node.js Built-in APIs](#cau-truc-du-lieu-va-node-api)
   - 5.1. `Map`, `Set` và dọn rác tự động với `WeakMap`
   - 5.2. Nhị phân, Băm SHA-256, HMAC-SHA1 và So sánh hằng thời gian (`timingSafeEqual`)
6. [React 19 & JSX Mechanics](#react-19-jsx-va-hooks)
   - 6.1. Cú pháp JSX và quy tắc render
   - 6.2. Bộ tứ React Hooks: `useState`, `useEffect`, `useCallback`, `useRef`

---

<section id="cu-phap-js-cot-loi">

## 1. Cú pháp JavaScript cốt lõi

Toàn bộ logic của `p2p-multiple-groups` được vận hành trên nền tảng JavaScript hiện đại (ECMAScript 2022+). Dưới đây là những cơ chế cú pháp nền tảng xuất hiện xuyên suốt mọi file trong dự án.

### 1.1. Khai báo biến (`const` vs `let`) và phạm vi khối (Block Scope)

Trong codebase, `var` bị cấm hoàn toàn. Chỉ có hai từ khóa khai báo biến được chấp nhận:

- **`const`**: Tạo một liên kết bất biến (immutable binding). Biến khai báo bằng `const` không thể gán lại bằng dấu `=`, nhưng các thuộc tính bên trong một đối tượng hoặc các phần tử trong `Map`/`Set` vẫn có thể thay đổi được (mutable content).
- **`let`**: Dùng khi giá trị của biến cần được gán lại trong tương lai (ví dụ: các biến đếm, cờ trạng thái, hoặc con trỏ hàng đợi).

```typescript
// src/main/p2p/credential-store.ts
export class SafeCredentialStore implements CredentialStore {
  private readonly filePath: string                          // const field ở cấp class
  private readonly memoryCache = new Map<string, string>()  // Map không thể bị gán đè, nhưng có thể gọi .set()
  private isLoaded = false                                   // Cờ trạng thái cần gán lại
  private queue: Promise<void> = Promise.resolve()           // Hàng đợi Promise được gán nối đuôi
```

**Phạm vi khối (Block Scope):**  
Cả `const` và `let` đều tuân theo block scope (giới hạn bởi cặp ngoặc nhọn `{}`). Khi ra khỏi khối lệnh của `if`, `for`, hay `try/catch`, biến sẽ bị hủy khỏi tầm vực:

```typescript
// src/main/p2p/search-index.ts
if (tokens.length === 0) return false
{
  const normalizedName = fileName.normalize('NFKC').toLowerCase()
  // normalizedName chỉ tồn tại trong khối này
}
```

### 1.2. So sánh nghiêm ngặt (`===`, `!==`) và chân trị (Truthiness/Falsiness)

Dự án tuyệt đối không dùng toán tử so sánh lỏng lẻo `==` và `!=` nhằm loại trừ hiện tượng ép kiểu ngầm định (Type Coercion Hazards) của JavaScript (chẳng hạn `0 == ''` là `true` nhưng `0 === ''` là `false`).

- **Falsy values** trong JavaScript bao gồm chính xác 6 giá trị: `false`, `0`, `-0`, `""` (chuỗi rỗng), `null`, `undefined`, và `NaN`.
- Mọi giá trị khác, bao gồm mảng rỗng `[]` và đối tượng rỗng `{}`, đều là **Truthy**!

```typescript
// src/shared/p2p.ts
export function validateDisplayName(name: string): ActionResult {
  const trimmed = name.trim()
  // Kiểm tra truthiness: trimmed rỗng ("") là falsy!
  if (!trimmed) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'Display name cannot be empty' }
  }
  // So sánh nghiêm ngặt độ dài
  if (trimmed.length > 32) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'Display name exceeds 32 characters' }
  }
  return { ok: true }
}
```

### 1.3. Đoản mạch logic (`&&`, `||`), Nullish Coalescing (`??`) và Optional Chaining (`?.`)

Codebase tận dụng triệt để cơ chế đánh giá ngắn mạch (short-circuit evaluation) để viết mã nguồn súc tích nhưng an toàn:

#### Toán tử logic `&&` và `||`
- `a && b`: Trả về `a` nếu `a` là falsy; ngược lại trả về `b`. Thường dùng trong React JSX để render có điều kiện: `{error && <div className="error-banner">{error}</div>}`.
- `a || b`: Trả về `a` nếu `a` là truthy; ngược lại trả về `b`. Cần cẩn trọng: nếu `a = 0` hoặc `a = ""`, `||` sẽ coi đó là falsy và lấy `b`.

#### Nullish Coalescing (`??`)
Chỉ thay thế giá trị dự phòng nếu toán tử bên trái là `null` hoặc `undefined`. Nếu toán tử bên trái là `0` hoặc `""`, `??` vẫn giữ nguyên giá trị bên trái!

```typescript
// src/main/p2p/credential-store.ts:176
async getCredential(groupKey: string): Promise<string | null> {
  return this.queueOperation(async () => {
    // Nếu memoryCache không có key, .get() trả về undefined. ?? null chuyển thành null.
    return this.memoryCache.get(groupKey) ?? null
  })
}
```

#### Optional Chaining (`?.`) và Optional Call (`?.()`)
Cho phép truy cập thuộc tính sâu mà không làm crash chương trình khi gặp `null` hoặc `undefined`.

```typescript
// 1. Gọi hàm tùy chọn (Optional function call) trong src/main/menu.ts:13
// Nếu commandHandler là null, không làm gì cả, không báo lỗi "is not a function"
commandHandler?.(command)

// 2. Gọi callback từ React component props trong src/renderer/src/features/search/Search.tsx:60
const handleGroupChange = (newGroupKey: string) => {
  onSelectGroup?.(newGroupKey)
}

// 3. Đọc thuộc tính lồng nhau: grp.search có thể là undefined
const defaultQuery = grp.search?.query ?? ''
```

### 1.4. Template Literals, Object Shorthand và Destructuring Assignment

#### Template Literals (Chuỗi nội suy với dấu backtick `` ` ``)
Cho phép chèn biểu thức `${...}` trực tiếp vào chuỗi mà không cần cộng chuỗi phức tạp:

```typescript
// src/main/theme-store.ts:41
const tempPath = `${filePath}.${randomUUID()}.tmp`
// Tạo đường dẫn file tạm thời duy nhất, ví dụ: "theme-setting.json.4a3f-8c...tmp"
```

#### Object Property Value Shorthand
Khi tên biến trùng với tên thuộc tính của đối tượng, ta có thể viết tắt `{ theme }` thay vì `{ theme: theme }`:

```typescript
// src/main/theme-store.ts:44
const payload = JSON.stringify({ theme }, null, 2) + '\n'
```

#### Destructuring Assignment (Phân rã cấu trúc)
Trích xuất nhanh các giá trị từ Object hoặc Array:

```typescript
// Destructuring mảng: tách URL và Anchor từ chuỗi href
const [pathPart, anchorPart] = href.split('#')

// Destructuring mảng: lấy state và dispatch function trong React Hook
const [queryInput, setQueryInput] = useState('')

// Destructuring đối tượng: bóc tách các trường từ một gói tin
const { groupId, peerId, payload } = message
```

### 1.5. Arrow Functions và các phương thức mảng bậc cao

Arrow Functions `(params) => expression` cung cấp cú pháp hàm ẩn danh ngắn gọn và kế thừa từ khóa `this` theo tầm vực bao quanh (lexical `this`).

- **Concise body**: `(p) => p.supernodeEligible` (tự động return kết quả biểu thức).
- **Block body**: `(a, b) => { return a - b }` (phải có từ khóa `return` rõ ràng nếu muốn trả về giá trị).

Codebase sử dụng 6 hàm mảng bất biến (không làm biến đổi mảng gốc trừ `.sort()`):

#### 1. `.filter()`: Lọc các phần tử thỏa mãn điều kiện
```typescript
// src/main/p2p/election.ts:11
// Chỉ giữ lại những peer có bật cờ supernodeEligible = true
const eligible = peers.filter((p) => p.supernodeEligible)
```

#### 2. `.sort()`: Sắp xếp mảng tại chỗ kèm điều kiện hòa điểm (Tie-breaker)
```typescript
// src/main/p2p/election.ts:13-20
eligible.sort((a, b) => {
  // Ưu tiên 1: peer nào vào mạng trước (joinOrder nhỏ hơn) thì ưu tiên làm Supernode
  if (a.joinOrder !== b.joinOrder) {
    return a.joinOrder - b.joinOrder
  }
  // Ưu tiên 2 (Tie-breaker): nếu joinOrder bằng nhau, so sánh thứ tự từ điển của peerId
  return a.peerId.localeCompare(b.peerId)
})
```

#### 3. `.every()`: Kiểm tra toàn bộ phần tử thỏa mãn (Phép VÀ logic - Boolean AND)
```typescript
// src/main/p2p/search-index.ts:45
export function matchesQuery(fileName: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false
  const normalizedName = fileName.normalize('NFKC').toLowerCase()
  // Trả về true NẾU VÀ CHỈ NẾU tên file chứa TẤT CẢ các từ khóa tìm kiếm
  return tokens.every((token) => normalizedName.includes(token))
}
```

#### 4. `.some()`: Kiểm tra có ít nhất một phần tử thỏa mãn (Phép HOẶC logic - Boolean OR)
```typescript
const hasActiveUploads = transfers.some((t) => t.state === 'transferring' && t.direction === 'upload')
```

#### 5. `.find()`: Tìm phần tử đầu tiên thỏa mãn điều kiện
```typescript
const targetPeer = roster.find((p) => p.peerId === remotePeerId)
```

#### 6. `.map()`: Chuyển đổi từng phần tử thành một giá trị mới
```typescript
const peerIds = eligible.map((p) => p.peerId)
```

</section>

---

<section id="es-modules-va-import">

## 2. ES Modules và Dynamic Imports

### 2.1. Named Exports, Default Exports và Type-Only Imports (`import type`)

Dự án cấu hình `"type": "module"` trong `package.json`. Mọi file nguồn đều là ECMAScript Modules (ESM).

- **Named Exports**: `export function electSupernodes(...)` — Cho phép import chính xác tên hàm cần dùng: `import { electSupernodes } from './election.js'`. Giúp bundler thực hiện **Tree-shaking** loại bỏ mã thừa.
- **Default Exports**: `export default function App()` — Thường chỉ dùng cho component gốc của React hoặc file config.
- **Type-Only Imports**: `import type { SafeStorage } from 'electron'` hoặc `import { type ActionResult, makeGroupKey } from '../../shared/p2p.js'`.

```typescript
// tsconfig.node.json
{
  "compilerOptions": {
    "erasableSyntaxOnly": true
  }
}
```

<div class="callout callout-note">
  <div class="callout-icon">💡</div>
  <div class="callout-content">
    <div class="callout-title">Tại sao bắt buộc dùng `import type`?</div>
    <p>
      Node.js >=24 hỗ trợ tính năng <strong>Native Type Stripping</strong> (chạy trực tiếp file <code>.ts</code> không cần biên dịch). Cơ chế này chỉ hoạt động khi trình thông dịch có thể xóa bỏ hoàn toàn cú pháp kiểu trong RAM mà không làm thay đổi ngữ nghĩa của mã JS. Bật cờ <code>erasableSyntaxOnly: true</code> bắt buộc mọi kiểu dữ liệu thuần túy phải được import bằng cú pháp <code>import type</code>. Nếu bạn import một kiểu dữ liệu như một giá trị thông thường, Node.js runtime sẽ quẳng lỗi vì không tìm thấy biến đó khi chạy!
    </p>
  </div>
</div>

### 2.2. Dynamic Import với Top-Level Await trong môi trường lai

Một thách thức lớn trong kiến trúc này là: Mã nguồn `src/main/p2p/credential-store.ts` được dùng chung giữa:
1. **Môi trường Electron thật**: Có sẵn module native `electron.safeStorage` để gọi Windows DPAPI / macOS Keychain.
2. **Môi trường kiểm thử tự động (Unit Tests)**: Chạy bằng Node.js thuần (`node:test`), hoàn toàn không có binary Electron!

Nếu viết `import { safeStorage } from 'electron'`, khi chạy `npm test`, Node.js sẽ lập tức quẳng lỗi `ERR_MODULE_NOT_FOUND`. Để giải quyết, tác giả sử dụng **Top-Level Await Dynamic Import**:

```typescript
// src/main/p2p/credential-store.ts:33-42
let electronSafeStorage: SafeStorage | null = null

try {
  // Nạp động thư viện 'electron' khi module được nạp vào bộ nhớ
  const electron = await import('electron')
  if (electron && typeof electron === 'object' && 'safeStorage' in electron && electron.safeStorage) {
    electronSafeStorage = electron.safeStorage as SafeStorage
  }
} catch {
  // Khi chạy trong Node.js test runner thuần, khối catch sẽ bắt lỗi im lặng
  // electronSafeStorage vẫn là null, hệ thống tự động chuyển sang chế độ memoryCache!
}
```

</section>

---

<section id="he-thong-kieu-typescript">

## 3. Hệ thống kiểu dữ liệu TypeScript trong Project

### 3.1. `interface` vs `type` aliases

Trong codebase:
- `interface` được dùng để định nghĩa **hình dạng dữ liệu của các đối tượng (Object Shapes)**, hỗ trợ mở rộng thông qua kế thừa (`extends`):
  ```typescript
  // src/shared/p2p.ts
  export interface GroupInvitation {
    version: 2
    groupId: string
    groupName: string
    signalingUrl: string
    token: string
    createdAt: number
    expiresAt?: number
  }
  ```
- `type` được dùng cho **Union Types**, **Primitive Aliases**, **Intersections**, hoặc trích xuất kiểu phức tạp:
  ```typescript
  export type P2pErrorCode =
    | 'INVALID_INVITATION'
    | 'AUTHENTICATION_FAILED'
    | 'RATE_LIMITED'
    | 'DESTINATION_EXISTS'
  ```

### 3.2. Literal Types và Tagged / Discriminated Unions

**Literal Types** khóa một biến vào một giá trị chính xác tuyệt đối, thay vì kiểu rộng như `string` hay `number`: `version: 2`, `role: 'supernode' | 'ordinary'`.

**Discriminated Unions (Tagged Unions)** là mô hình thiết kế quan trọng nhất trong toàn bộ hệ thống giao tiếp mạng và IPC của project. Một tagged union bao gồm nhiều interface khác nhau, nhưng tất cả đều chia sẻ một trường chung gọi là "nhãn phân biệt" (Discriminant Tag).

#### Ví dụ 1: Kiểu trả về `ActionResult`
```typescript
// src/shared/p2p.ts
export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: P2pErrorCode; message: string }
```
Khi người lập trình kiểm tra nhãn `ok`:
```typescript
const result = await window.p2p.joinGroup(options)
if (!result.ok) {
  // TypeScript tự động thu hẹp kiểu: tại đây result CHẮC CHẮN có .code và .message!
  console.error(`Lỗi [${result.code}]: ${result.message}`)
  return
}
// Tại đây TypeScript biết result.ok là true!
```

#### Ví dụ 2: Thông điệp Signaling Server Wire Protocol
```typescript
// src/shared/p2p-wire.ts
export type ServerSignalingMessageV2 =
  | { type: 'registered'; peerId: string; sessionId: string; leaseMs: number }
  | { type: 'roster'; groupId: string; epoch: number; revision: number; peers: SignalingRosterPeer[] }
  | { type: 'signal'; groupId: string; fromPeerId: string; toPeerId: string; data: WebRtcSignalData }
  | { type: 'error'; code: string; message: string; groupId?: string }
```
Trong hàm xử lý sự kiện:
```typescript
switch (msg.type) {
  case 'roster':
    // TypeScript biết msg có các trường .groupId, .epoch, .revision, .peers
    updateRoster(msg.groupId, msg.peers)
    break
  case 'signal':
    // TypeScript biết msg có .fromPeerId và .data
    relaySignal(msg.fromPeerId, msg.data)
    break
}
```

### 3.3. Intersection Types và `readonly` Modifiers

- **Intersection Types (`&`)**: Gộp nhiều cấu trúc kiểu lại thành một kiểu thống nhất.
  ```typescript
  // src/main/index.ts:35
  // Ghép state đa nhóm V2 với state đơn nhóm V1 để đảm bảo tương thích ngược giao diện
  function dispatchStateToWindow(state: MultiGroupP2pState & P2pState): void { ... }
  ```
- **`readonly` Modifier**: Ngăn chặn hành vi đột biến dữ liệu.
  ```typescript
  // src/main/p2p/election.ts:10
  export function electSupernodes(peers: readonly SignalingRosterPeer[]): ElectionResult {
    // peers.push(...) -> BÁO LỖI BIÊN DỊCH NGAY LẬP TỨC!
    // Bảo vệ mảng danh sách peer không bị sửa đổi vô ý trong quá trình tính toán bầu chọn.
  }
  ```

### 3.4. Const Assertions (`as const`) và Indexed Access Types

Khi định nghĩa một hằng số đối tượng trong JS, TypeScript thường suy diễn kiểu thuộc tính là kiểu rộng (`string`, `number`). Bằng cách thêm `as const` vào cuối định nghĩa:
1. Mọi thuộc tính trở thành `readonly`.
2. Mọi giá trị chuỗi trở thành **Literal Types**.

```typescript
// src/shared/contracts.ts
export const IPC_CHANNELS = {
  P2P_V2_JOIN_GROUP: 'p2p:v2:join-group',
  P2P_V2_LEAVE_GROUP: 'p2p:v2:leave-group',
  P2P_V2_START_DOWNLOAD: 'p2p:v2:start-download',
} as const
```

Kết hợp với **Indexed Access Types (`[key]`)** và toán tử `typeof`, ta có thể tự động sinh kiểu dữ liệu từ chính giá trị runtime mà không cần gõ lại hai lần:

```typescript
// src/renderer/src/features/commands/commands.ts
export const COMMAND_DESCRIPTORS = [
  { id: 'view:home', label: 'Go to Overview' },
  { id: 'view:network', label: 'Go to Network' },
  { id: 'view:library', label: 'Go to Library' },
] as const

// Trích xuất kiểu union: 'view:home' | 'view:network' | 'view:library'
export type CommandDescriptor = (typeof COMMAND_DESCRIPTORS)[number]
export type CommandId = CommandDescriptor['id']
```

### 3.5. Utility Types trong Codebase

TypeScript cung cấp các tiện ích biến đổi kiểu mạnh mẽ được sử dụng tại các vị trí then chốt:

| Utility Type | Cú pháp trong Codebase | Ý nghĩa thực tế |
|---|---|---|
| `Partial<T>` | `Partial<ConnectOptions>` | Biến toàn bộ thuộc tính của `ConnectOptions` thành tùy chọn (`?`). |
| `Record<K, V>` | `Record<string, GroupRuntime>` | Định nghĩa một Object đóng vai trò là một từ điển (Dictionary) với khóa kiểu `string` và giá trị là `GroupRuntime`. |
| `Extract<T, U>` | `Extract<ServerSignalingMessageV2, { type: 'signal' }>` | Trích xuất riêng nhánh thông điệp có `type === 'signal'` từ một Union lớn. |
| `Parameters<T>` | `Parameters<typeof readFile>[0]` (`src/main/p2p/credential-store.ts:8`) | Trích xuất kiểu của tham số thứ nhất trong hàm đọc file của Node.js (đảm bảo đúng chuẩn `PathLike`). |
| `ConstructorParameters<T>` | `ConstructorParameters<typeof RTCPeerConnection>[0]` | Trích xuất cấu hình cấu tử RTCConfiguration của WebRTC. |

### 3.6. Generics (`<T>`) trong Hàng đợi Bất đồng bộ

Generics cho phép viết các hàm và lớp có thể hoạt động trên nhiều kiểu dữ liệu khác nhau nhưng vẫn giữ được tính an toàn kiểu tuyệt đối (Type Safety).

Hãy xem hàm `queueAction<T>` trong `src/main/p2p/engine.ts:1242`:

```typescript
function queueAction<T>(action: () => Promise<T>): Promise<T> {
  const enqueued = policyQueue.then(() => {
    if (isDisposed) {
      return Promise.reject(new Error('Engine disposed'))
    }
    return action()
  })
  policyQueue = enqueued.then(
    () => {},
    () => {}
  )
  return enqueued
}
```

- Khi bạn truyền vào một action trả về `Promise<ActionResult>`: `T` tự động được suy diễn là `ActionResult`.
- Khi bạn truyền vào một action trả về `Promise<string>`: `T` tự động là `string`.
- Lập trình viên gọi `await queueAction(...)` sẽ nhận đúng kiểu dữ liệu của hàm con mà không cần ép kiểu thủ công (`as any`)!

### 3.7. `unknown` vs `any` và User-Defined Type Guards

Trong TypeScript:
- **`any`**: Tắt hoàn toàn bộ kiểm tra kiểu. Bất kỳ phép gọi phương thức nào trên biến `any` đều được chấp nhận, dễ gây sập chương trình khi chạy (Runtime Crash).
- **`unknown`**: Đại diện cho dữ liệu chưa xác định danh tính (ví dụ dữ liệu nhận từ mạng WebSocket, file đĩa JSON, hoặc IPC). TypeScript **bắt buộc** bạn phải kiểm tra kiểu trước khi sử dụng.

Để biến một biến `unknown` thành một kiểu dữ liệu cụ thể an toàn, dự án sử dụng **User-Defined Type Guards** với vị từ kiểu (`variable is Type`):

```typescript
// src/shared/contracts.ts
export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}
```

Nếu hàm trên trả về `true`, trình biên dịch TypeScript sẽ bảo đảm `value` chính xác là một trong 3 chuỗi `'system' | 'light' | 'dark'`.

Trong `src/shared/p2p-wire.ts`, các hàm như `isServerSignalingMessageV2(val: unknown): val is ServerSignalingMessageV2` kiểm tra từng trường của object JSON nhận được từ máy chủ Signaling trước khi cho phép mã nguồn truy cập.

### 3.8. Function Overloads trong TypeScript Interfaces

Hệ thống P2P được nâng cấp từ phiên bản v1 (đơn nhóm) lên v2 (đa nhóm). Nhằm duy trì tính tương thích ngược hoàn hảo, interface `PeerEngine` định nghĩa nạp chồng hàm (Function Overloading):

```typescript
// src/main/p2p/engine.ts
export interface PeerEngine {
  // Chữ ký V2: Hỗ trợ chỉ định rõ groupKey
  setSupernodeEligible(groupKey: string, eligible: boolean): Promise<ActionResult>
  // Chữ ký V1 (Legacy): Tự động áp dụng cho nhóm mặc định đầu tiên
  setSupernodeEligible(eligible: boolean): Promise<ActionResult>

  // Dual-signature cho tìm kiếm
  search(groupKey: string, query: string): Promise<ActionResult>
  search(query: string): Promise<ActionResult>
}
```

TypeScript cho phép gọi một trong hai dạng tham số, và trình biên dịch sẽ kiểm tra tính hợp lệ của từng trường hợp.

</section>

---

<section id="bat-dong-bo-promise-async-await">

## 4. Bất đồng bộ, Promise và Concurrency Queues

### 4.1. Event Loop, Microtask Queue và Promise

JavaScript trong Node.js và Chromium vận hành theo mô hình **Đơn luồng non-blocking (Single-threaded Event Loop)**:
1. **Call Stack**: Thực thi các đoạn mã đồng bộ tuần tự.
2. **Microtask Queue**: Chứa các callback của `Promise.then()`, `await`, và `queueMicrotask`. Hàng đợi này có độ ưu tiên cao nhất — nó được giải phóng sạch sẽ ngay khi Call Stack trống trước khi Event Loop chuyển sang việc khác!
3. **Macrotask Queue**: Chứa các sự kiện I/O, `setTimeout`, `setInterval`, và các gói tin mạng đến.

Khi khai báo một hàm `async`:
- Hàm đó luôn luôn trả về một `Promise<T>`.
- Từ khóa `await` tạm dừng thực thi hàm đó tại điểm gọi, nhường quyền điều khiển cho Event Loop, và tiếp tục chạy phần còn lại như một Microtask ngay khi Promise được giải quyết (resolved).

### 4.2. Mẫu tuần tự hóa hàng đợi Promise (Promise Chain Serialization Pattern)

Trong một hệ thống P2P, nhiều sự kiện có thể xảy ra đồng thời: người dùng nhấn rời nhóm trong lúc máy chủ vừa gửi thông báo bầu chọn Supernode mới, đồng thời file đĩa đang được ghi. Nếu hai luồng xử lý cùng can thiệp vào bộ nhớ hoặc file đĩa cùng lúc, dữ liệu sẽ bị hỏng (Race Condition).

Codebase áp dụng mẫu thiết kế **Promise Chain Serialization** cực kỳ tinh tế trong `src/main/p2p/engine.ts`, `src/main/theme-store.ts`, `src/main/p2p/peer-store.ts`, và `src/main/p2p/credential-store.ts`:

```typescript
// src/main/p2p/engine.ts:1241-1254
let policyQueue: Promise<void> = Promise.resolve()

function queueAction<T>(action: () => Promise<T>): Promise<T> {
  // 1. Mắc nối tiếp action mới vào đuôi của policyQueue hiện tại
  const enqueued = policyQueue.then(() => {
    if (isDisposed) {
      return Promise.reject(new Error('Engine disposed'))
    }
    return action()
  })

  // 2. CẬP NHẬT policyQueue: Mấu chốt kỹ thuật nằm ở đây!
  policyQueue = enqueued.then(
    () => {}, // Fulfillment handler rỗng
    () => {}  // Rejection handler rỗng - NUỐT LỖI CHO ĐUÔI HÀNG ĐỢI!
  )

  // 3. Trả về chính Promise của action để người gọi hàm vẫn nhận đủ kết quả hoặc bắt lỗi
  return enqueued
}
```

<div class="callout callout-warning">
  <div class="callout-icon">⚡</div>
  <div class="callout-content">
    <div class="callout-title">Tại sao phải gắn 2 hàm rỗng `enqueued.then(() => {}, () => {})`?</div>
    <p>
      Nếu bạn chỉ viết <code>policyQueue = enqueued</code>: Giả sử tác vụ A thất bại và Promise của nó bị <code>rejected</code>. Lúc này, chuỗi <code>policyQueue</code> sẽ rơi vào trạng thái <em>Rejected</em>. Khi tác vụ B được xếp hàng nối tiếp vào <code>policyQueue.then(...)</code>, tác vụ B sẽ <strong>bị bỏ qua hoàn toàn</strong> vì Promise trước nó đã lỗi!
    </p>
    <p>
      Bằng cách gắn <code>.then(() => {}, () => {})</code>, chúng ta bảo đảm chuỗi hàng đợi tổng thể luôn luôn kết thúc ở trạng thái <strong>Fulfilled</strong> thành công. Lỗi của tác vụ A chỉ trả về cho chính người gọi tác vụ A thông qua biến <code>enqueued</code>, hoàn toàn không làm đứt mạch thực thi của tác vụ B xếp sau!
    </p>
  </div>
</div>

### 4.3. Quản lý bộ đếm thời gian (Timers) và Trailing Throttle 200ms

#### Trailing Throttle trong `src/main/index.ts:34-51`
Khi mạng P2P hoạt động mạnh (ví dụ chuyển hàng chục chunk file trong 1 giây), trạng thái `peerEngine` thay đổi liên tục. Nếu mỗi lần thay đổi đều gửi thông điệp IPC sang Renderer Process, kênh IPC sẽ bị nghẽn (starvation) và giao diện React sẽ bị đơ do re-render quá tải.

Giải pháp là bộ đệm trễ **Trailing Throttle (200ms)**:

```typescript
let stateThrottleTimer: NodeJS.Timeout | null = null
let pendingStateSnapshot: (MultiGroupP2pState & P2pState) | null = null

function dispatchStateToWindow(state: MultiGroupP2pState & P2pState): void {
  // Luôn luôn ghi nhớ ảnh chụp mới nhất trong RAM
  pendingStateSnapshot = state

  // Nếu timer 200ms đang đếm, không tạo thêm timer mới
  if (!stateThrottleTimer) {
    stateThrottleTimer = setTimeout(() => {
      stateThrottleTimer = null
      if (pendingStateSnapshot && mainWindow && !mainWindow.isDestroyed()) {
        // Chỉ gửi ảnh chụp mới nhất một lần duy nhất qua IPC
        mainWindow.webContents.send(IPC_CHANNELS.P2P_STATE_CHANGED, pendingStateSnapshot)
        pendingStateSnapshot = null
      }
    }, 200) // Khóa nhịp 200ms
  }
}
```

#### Watchdog Monitor Timer trong `src/main/p2p/engine.ts:1840`
Sử dụng `setInterval` định kỳ mỗi 2000ms để kiểm tra thời hạn thuê (lease) của quyền quản trị nhóm. Nếu máy chủ Signaling không phản hồi trong quá 6000ms (`ROSTER_FRESHNESS_LEASE_MS`), quyền Supernode sẽ bị thu hồi an toàn. Khi đóng Engine (`dispose`), hàm `clearInterval(monitorTimer)` được gọi để giải phóng tài nguyên.

</section>

---

<section id="cau-truc-du-lieu-va-node-api">

## 5. Cấu trúc dữ liệu và Node.js Built-in APIs

### 5.1. `Map`, `Set` và dọn rác tự động với `WeakMap`

- **`Map<K, V>`**: Sử dụng làm cấu trúc lưu trữ chính trong RAM vì tra cứu theo key đạt độ phức tạp $O(1)$. Khác với Plain Object, key của `Map` có thể là bất kỳ kiểu dữ liệu nào và có phương thức `.size` tiện lợi:
  ```typescript
  const groups = new Map<GroupKey, GroupRuntime>()
  ```
- **`Set<T>`**: Lưu danh sách các phần tử duy nhất không trùng lặp, dùng để theo dõi các peer đã biết (`seenPeerIds = new Set<string>()`).
- **`WeakMap<K, V>`**: Một cấu trúc đặc biệt mà trong đó **Key bắt buộc phải là Object** và chỉ được giữ dưới dạng tham chiếu yếu (Weak Reference).

```typescript
// services/signaling/server.ts:50
const upgradeGroupIdMap = new WeakMap<WebSocket, string>()
```

<div class="callout callout-note">
  <div class="callout-icon">💡</div>
  <div class="callout-content">
    <div class="callout-title">Ý nghĩa sống còn của `WeakMap` chống rò rỉ bộ nhớ (Memory Leak)</div>
    <p>
      Khi một client kết nối tới cổng WebSocket của máy chủ Signaling, đối tượng <code>WebSocket</code> được tạo ra. Chúng ta cần lưu tạm <code>groupId</code> mà socket này muốn tham gia trước khi hoàn tất bắt tay HTTP upgrade.
    </p>
    <p>
      Nếu dùng <code>Map&lt;WebSocket, string&gt;</code> thông thường, <code>Map</code> sẽ giữ một tham chiếu cứng tới socket. Khi client ngắt kết nối đột ngột hoặc sập mạng, bộ gom rác Garbage Collector (GC) của Node.js <strong>không thể thu hồi vùng nhớ của socket đó</strong> vì nó vẫn bị giữ bởi <code>Map</code>! Lâu ngày máy chủ sẽ cạn kiệt RAM.
    </p>
    <p>
      Với <code>WeakMap</code>, ngay khi socket đóng và không còn biến nào khác trỏ tới nó, GC sẽ tự động xóa socket và cặp key-value tương ứng khỏi bộ nhớ hoàn toàn tự động!
    </p>
  </div>
</div>

### 5.2. Nhị phân, Băm SHA-256, HMAC-SHA1 và So sánh hằng thời gian (`timingSafeEqual`)

#### 1. Xử lý Buffer nhị phân
Trong Node.js, dữ liệu truyền qua mạng hoặc đọc từ file được biểu diễn bằng lớp `Buffer` (kế thừa từ `Uint8Array`):
```typescript
// Chuyển chuỗi base64url 43 ký tự thành mảng 32 bytes (256 bits)
const tokenBuf = Buffer.from(token.trim(), 'base64url')
```

#### 2. Băm toàn vẹn SHA-256 theo luồng (Streaming Hash)
Khi chia sẻ file dung lượng lớn (tối đa 1 GiB), ứng dụng không đọc toàn bộ file vào RAM mà dùng `fs.createReadStream` kết hợp hàm băm luồng:
```typescript
import { createHash } from 'node:crypto'
const hasher = createHash('sha256')
for await (const chunk of stream) {
  hasher.update(chunk)
}
const finalSha256 = hasher.digest('hex')
```

#### 3. Tạo chữ ký xác thực tạm thời TURN bằng HMAC-SHA1
Tuân thủ tiêu chuẩn WebRTC RFC 5766, máy chủ Signaling cấp chứng thực TURN tạm thời bằng thuật toán HMAC-SHA1:
```typescript
import { createHmac } from 'node:crypto'
const turnPassword = createHmac('sha1', turnSecret).update(username).digest('base64')
```

#### 4. Chống tấn công thời gian bằng `timingSafeEqual`
Khi kiểm tra token gia nhập nhóm do client gửi lên máy chủ Signaling, tuyệt đối không dùng toán tử `providedToken === group.token`. Toán tử `===` so sánh chuỗi từ trái qua phải và ngắt ngay ở ký tự sai đầu tiên. Kẻ tấn công có thể đo thời gian phản hồi ở mức nano-giây (Timing Attack) để dò từng ký tự của khóa bí mật.

Hệ thống bảo vệ bằng hàm so sánh hằng thời gian của Node.js:
```typescript
import { timingSafeEqual } from 'node:crypto'

// services/signaling/server.ts:316
const providedBuf = Buffer.from(token, 'utf-8')
if (providedBuf.length !== group.tokenBuffer.length || !timingSafeEqual(providedBuf, group.tokenBuffer)) {
  // Thời gian xử lý luôn bằng nhau dù đúng hay sai ký tự nào!
  return sendError(ws, 'INVALID_TOKEN', 'Group token rejected')
}
```

</section>

---

<section id="react-19-jsx-va-hooks">

## 6. React 19 & JSX Mechanics

Tiến trình Renderer chạy React 19.3 trong môi trường trình duyệt Chromium biệt lập.

### 6.1. Cú pháp JSX và quy tắc render

JSX là cú pháp mở rộng cho phép viết cấu trúc HTML lồng trong mã JavaScript. Khi build, trình biên dịch Vite/Babel dịch JSX thành các lời gọi hàm `jsx()` của React 19.

- **Thuộc tính `className`**: Do `class` là từ khóa của JavaScript, JSX quy định dùng `className` để gán CSS class: `<div className="card">`.
- **Biểu thức lồng `{...}`**: Mọi biểu thức JavaScript hợp lệ đều có thể đặt trong cặp dấu ngoặc nhọn: `<span>{peer.displayName || peer.peerId.slice(0, 8)}</span>`.
- **Render danh sách và thuộc tính `key`**: Khi dùng `.map()` để sinh danh sách phần tử, bắt buộc phải cung cấp thuộc tính `key` duy nhất và ổn định để thuật toán Reconciliation của React nhận diện phần tử nào đã thay đổi, thêm mới hoặc bị xóa:
  ```tsx
  {peers.map((peer) => (
    <tr key={peer.peerId}>
      <td>{peer.displayName}</td>
      <td>{peer.role}</td>
    </tr>
  ))}
  ```
- **Xử lý sự kiện (Event Handlers)**: Truyền trực tiếp hàm callback vào thuộc tính `onClick`, `onChange`, `onSubmit`. Dùng `e.preventDefault()` để ngăn trình duyệt reload lại trang khi submit form:
  ```tsx
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    handleJoin()
  }
  ```

### 6.2. Bộ tứ React Hooks trong Codebase

Toàn bộ logic giao diện của ứng dụng được xây dựng hoàn toàn từ 4 Hook chuẩn của React:

#### 1. `useState` — Quản lý trạng thái cục bộ
Tạo một biến trạng thái phản ứng (reactive state) và một hàm cập nhật tương ứng:
```tsx
const [query, setQuery] = useState('')
const [isBusy, setIsBusy] = useState(false)
```
Mỗi khi hàm `setQuery('new text')` được gọi, React xếp lịch render lại component đó với giá trị mới.

#### 2. `useEffect` — Đồng bộ với hệ thống bên ngoài và dọn dẹp (Cleanup)
Dùng để đăng ký các bộ lắng nghe sự kiện IPC, bàn phím, hoặc timer:

```tsx
// src/renderer/src/features/network/usePeerState.ts:68-80
useEffect(() => {
  const bridge = getBridge()
  if (!bridge) return

  // 1. Đăng ký lắng nghe cập nhật trạng thái từ Electron Main Process
  const unsubscribe = bridge.onState((incomingState) => {
    // Chỉ cập nhật nếu số revision của state mới lớn hơn hoặc bằng revision cũ
    if (incomingState.revision >= lastRevisionRef.current) {
      lastRevisionRef.current = incomingState.revision
      setState(incomingState)
    }
  })

  // 2. CLEANUP FUNCTION: Bắt buộc trả về hàm dọn dẹp!
  // Khi component bị gỡ bỏ (unmount), hàm này tự động hủy đăng ký listener để tránh rò rỉ bộ nhớ
  return () => {
    unsubscribe()
  }
}, []) // Mảng rỗng [] nghĩa là hook này chỉ chạy một lần khi component mount
```

#### 3. `useCallback` — Ghi nhớ tham chiếu hàm (Memoization)
Trong JavaScript, mỗi lần component render lại, một hàm mới sẽ được tạo ra trong RAM. Nếu hàm đó được truyền làm dependency cho một `useEffect` khác, nó sẽ gây ra vòng lặp render vô tận. `useCallback` giúp giữ nguyên tham chiếu của hàm trừ khi các dependency của nó thay đổi:

```tsx
// src/renderer/src/features/network/usePeerState.ts:135
const joinGroup = useCallback(async (options: JoinGroupOptions): Promise<ActionResult> => {
  const bridge = getBridge()
  if (!bridge) return { ok: false, code: 'SERVICE_UNAVAILABLE', message: 'Bridge unavailable' }
  setError(null)
  const res = await bridge.joinGroup(options)
  if (!res.ok) setError(res.message)
  return res
}, []) // Tham chiếu của hàm joinGroup không bao giờ bị đổi giữa các lần render
```

#### 4. `useRef` — Tham chiếu DOM và Bộ nhớ cục bộ không kích hoạt re-render
`useRef` trả về một object có thuộc tính `.current`. Khác với `useState`, **thay đổi giá trị của `.current` không làm component render lại!**

Codebase dùng `useRef` cho 2 mục đích hoàn toàn khác biệt:

- **Mục đích A: Tham chiếu trực tiếp phần tử DOM**:
  ```tsx
  // src/renderer/src/features/commands/CommandPalette.tsx:21
  const dialogRef = useRef<HTMLDialogElement>(null)

  // Mở modal native của HTML5:
  dialogRef.current?.showModal()
  ```
- **Mục đích B: Lưu trữ biến đệm nội bộ (Mutable Tracker)**:
  ```tsx
  // src/renderer/src/App.tsx:30
  const isSavingThemeRef = useRef(false)
  // Ngăn chặn việc gọi ghi theme liên tục khi sự kiện thay đổi giao diện kích hoạt dồn dập
  if (isSavingThemeRef.current) return
  isSavingThemeRef.current = true
  ```
  Tương tự, `lastRevisionRef = useRef(0)` trong `usePeerState.ts:63` lưu trữ số revision của mạng P2P mà không gây render thừa mỗi khi số này tăng lên.

---

## Tóm tắt & Bài học ghi nhớ

1. Toàn bộ mã nguồn ưu tiên tính bất biến: dùng `const`, `readonly`, và các hàm mảng thuần túy (`.filter()`, `.map()`, `.every()`).
2. Tagged / Discriminated Unions và User-Defined Type Guards là xương sống bảo vệ toàn vẹn dữ liệu từ ranh giới mạng và IPC.
3. Mẫu `policyQueue = enqueued.then(() => {}, () => {})` giải quyết triệt để vấn đề Race Condition và cô lập hoàn toàn lỗi giữa các tác vụ bất đồng bộ.
4. Quản lý bộ nhớ phải chủ động: dùng `WeakMap` cho kết nối socket và luôn trả về hàm dọn dẹp trong `useEffect`.
5. Đọc tiếp [Phần 2: Mã Nguồn Tầng Giao Tiếp Chung, Preload Bridge & Signaling Server](02-shared-preload-and-signaling-code.md) để hiểu rõ từng dòng code hiện thực hóa các nguyên lý trên.
