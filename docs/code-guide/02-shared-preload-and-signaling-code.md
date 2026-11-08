# Phần 2: Mã Nguồn Tầng Giao Tiếp Chung, Preload Bridge & Signaling Server

> **Chuyên mục**: Code Guide & Syntax Deep-Dive  
> **Ngôn ngữ**: Tiếng Việt (Giữ nguyên định danh kỹ thuật, cú pháp và tên file mã nguồn tiếng Anh)  
> **Các module phân tích**: `electron.vite.config.ts`, `src/shared/*`, `src/preload/index.ts`, `services/signaling/*`, `scripts/create-invite.ts`  

---

## Mục lục nội dung

1. [Cấu hình Build & Bundler (`electron.vite.config.ts`)](#electron-vite-config)
   - 1.1. Plugin `kazaaCsp(isDev)` và cơ chế tiêm biến bảo mật `%KAZAA_CSP%`
   - 1.2. Phân chia định dạng đầu ra: ES Module (`main`), CommonJS (`preload`), SPA Bundle (`renderer`)
2. [Sổ đăng ký Hợp đồng IPC (`src/shared/contracts.ts`)](#shared-contracts)
   - 2.1. Hằng số kênh IPC với `as const`: `IPC_CHANNELS` (V2 Scoped vs V1 Legacy)
   - 2.2. Interface `P2pApi`, `KazaaApi` và Type Guard `isThemePreference`
3. [Kiểu miền dữ liệu & Bộ tiền kiểm định đầu vào (`src/shared/p2p.ts`)](#shared-p2p)
   - 3.1. Mã lỗi chuẩn `P2pErrorCode` (14 mã lỗi) và kiểu phân biệt `ActionResult`
   - 3.2. Cấu trúc và kỹ thuật tuần tự hóa khóa định danh nhóm: `GroupKey`
   - 3.3. Các hàm tiền kiểm định nghiêm ngặt: URL, GroupId, Token (Entropy 256-bit), DisplayName, và Lời mời nhóm
4. [Giao thức tầng dây & Runtime Type Guards (`src/shared/p2p-wire.ts`)](#shared-p2p-wire)
   - 4.1. Hằng số giới hạn kích thước gói tin và thời hạn thuê (Lease Duration)
   - 4.2. Helper nhãn kênh dữ liệu WebRTC: `makeFileChannelLabelV2` / `parseFileChannelLabelV2`
   - 4.3. Type Guards phòng vệ tầng dây: `isClientSignalingMessageV2`, `isServerSignalingMessageV2`, `isOverlayControlMessageV2`, `isTransferControlMessageV2`
5. [Cửa khẩu An ninh Preload Script (`src/preload/index.ts`)](#preload-bridge)
   - 5.1. Cơ chế đóng gói hàm `ipcRenderer.invoke` và bộ lắng nghe sự kiện có hàm dọn dẹp (Cleanup Closure)
   - 5.2. Kỹ thuật định tuyến chữ ký kép (Dual-Signature Routing) cho tính tương thích ngược
   - 5.3. Cô lập hoàn toàn môi trường với `contextBridge.exposeInMainWorld`
6. [Dịch vụ Máy chủ Signaling & Công cụ CLI (`services/signaling/*`, `scripts/create-invite.ts`)](#signaling-service)
   - 6.1. Phân giải cấu hình đa nguồn `loadSignalingOptions` trong `config.ts`
   - 6.2. Bộ điều phối `createSignalingServer` trong `server.ts`: HTTP `/healthz`, WebSocket `/signal`, Token-Bucket Rate Limiter, So sánh hằng thời gian `timingSafeEqual`, Chứng thực TURN RFC 5766 HMAC-SHA1, và Quét nhịp tim (Heartbeat Sweep)
   - 6.3. Điểm khởi động dịch vụ `index.ts` và Trình tạo mã mời `scripts/create-invite.ts`

---

<section id="electron-vite-config">

## 1. Cấu hình Build & Bundler (`electron.vite.config.ts`)

File `electron.vite.config.ts` là trái tim điều phối toàn bộ quá trình đóng gói và biên dịch ứng dụng. Nhờ sử dụng công cụ `electron-vite`, dự án có thể cấu hình độc lập 3 mục tiêu biên dịch tương ứng với 3 tiến trình trong một file duy nhất:

```typescript
// electron.vite.config.ts:19-51
export default defineConfig(({ command }) => {
  const isDev = command === 'serve'

  return {
    main: {
      build: {
        rollupOptions: {
          output: {
            format: 'es',              // Tiến trình chính xuất ra chuẩn ES Module
            entryFileNames: 'index.js'
          }
        }
      }
    },
    preload: {
      build: {
        rollupOptions: {
          output: {
            format: 'cjs',             // Preload script xuất ra chuẩn CommonJS
            entryFileNames: 'index.cjs'
          }
        }
      }
    },
    renderer: {
      plugins: [react(), kazaaCsp(isDev)],
      server: {
        host: '127.0.0.1',             // Khóa chặt loopback cục bộ
        port: 5173,
        strictPort: true               // Không tự ý nhảy sang port khác nếu 5173 bận
      }
    }
  }
})
```

### 1.1. Plugin `kazaaCsp(isDev)` và cơ chế tiêm biến bảo mật `%KAZAA_CSP%`

Chính sách bảo mật nội dung (Content Security Policy - CSP) là lớp phòng thủ tối hậu ngăn chặn tấn công XSS (Cross-Site Scripting) và Data Exfiltration.

Trong file `src/renderer/index.html`, thẻ `<meta>` được viết sẵn một chuỗi giữ chỗ (placeholder):
```html
<meta http-equiv="Content-Security-Policy" content="%KAZAA_CSP%">
```

Plugin tùy biến `kazaaCsp` sử dụng hook `transformIndexHtml` của Vite để thay thế placeholder này tùy theo chế độ chạy:

```typescript
// electron.vite.config.ts:5-17
function kazaaCsp(isDev: boolean): Plugin {
  // 1. Môi trường phát triển (Development): Cần kết nối tới Vite Dev Server để Hot Module Replacement (HMR)
  const devCsp =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:5173; object-src 'none'; base-uri 'none'; form-action 'none'"

  // 2. Môi trường phân phối (Production): CẤM HOÀN TOÀN MỌI KẾT NỐI MẠNG TRỰC TIẾP TỪ GIAO DIỆN
  const prodCsp =
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

  return {
    name: 'kazaa-csp',
    transformIndexHtml(html: string): string {
      return html.replace('%KAZAA_CSP%', isDev ? devCsp : prodCsp)
    }
  }
}
```

<div class="callout callout-warning">
  <div class="callout-icon">🛡️</div>
  <div class="callout-content">
    <div class="callout-title">Tại sao Production lại đặt `connect-src 'none'`?</div>
    <p>
      Tiến trình Renderer hiển thị giao diện React được xem là vùng không tin cậy hoàn toàn (Untrusted Sandbox). Bằng cách cấm hoàn toàn <code>connect-src 'none'</code>, trình duyệt Chromium sẽ chặn đứng mọi lời gọi hàm <code>fetch()</code>, <code>XMLHttpRequest</code>, hay <code>new WebSocket()</code> từ giao diện. Dù một gói tin chứa mã độc XSS có lọt vào giao diện, mã độc cũng không thể bí mật gửi dữ liệu người dùng ra bất kỳ máy chủ bên ngoài nào trên Internet. Mọi giao tiếp mạng đều bắt buộc phải đi qua kênh IPC có kiểm duyệt nghiêm ngặt để tới Main Process!
    </p>
  </div>
</div>

### 1.2. Phân chia định dạng đầu ra: ES Module vs CommonJS

- **Main Process (`out/main/index.js`) — `format: 'es'`**: Vì dự án sử dụng Node.js >=24 hiện đại và `package.json` có `"type": "module"`, Main Process được đóng gói dưới dạng ES Module đầy đủ, cho phép sử dụng Top-Level Await và import chuẩn ESM.
- **Preload Script (`out/preload/index.cjs`) — `format: 'cjs'`**: Electron khuyến nghị Preload Script nên được build dạng CommonJS (`.cjs`) để tương thích tối đa với cơ chế tiêm mã an toàn của Chromium trước khi bất kỳ script nào của trang web bắt đầu thực thi.

</section>

---

<section id="shared-contracts">

## 2. Sổ đăng ký Hợp đồng IPC (`src/shared/contracts.ts`)

File `src/shared/contracts.ts` đóng vai trò là "hiến pháp giao tiếp" giữa 3 tiến trình. Nó quy định danh sách toàn bộ các kênh IPC được phép hoạt động trong hệ thống.

### 2.1. Hằng số kênh IPC với `as const`: `IPC_CHANNELS`

```typescript
// src/shared/contracts.ts:22-57
export const IPC_CHANNELS = {
  THEME_GET: 'kazaa:theme:get',
  THEME_SET: 'kazaa:theme:set',
  COMMAND: 'kazaa:command',

  // Kênh cũ V1 (Legacy) để duy trì khả năng tương thích ngược
  P2P_GET_STATE: 'kazaa:p2p:get-state',
  P2P_STATE: 'kazaa:p2p:state',
  P2P_CONNECT: 'kazaa:p2p:connect',
  P2P_DISCONNECT: 'kazaa:p2p:disconnect',
  P2P_ELIGIBILITY: 'kazaa:p2p:eligibility',
  P2P_ADD_FILES: 'kazaa:p2p:add-files',
  P2P_RESCAN_LIBRARY: 'kazaa:p2p:rescan-library',
  P2P_REMOVE_FILE: 'kazaa:p2p:remove-file',
  P2P_SEARCH: 'kazaa:p2p:search',
  P2P_DOWNLOAD: 'kazaa:p2p:download',
  P2P_CANCEL_TRANSFER: 'kazaa:p2p:cancel-transfer',

  // Kênh mới V2: Đa nhóm độc lập (Multi-Group Scoped Channels)
  P2P_V2_GET_STATE: 'p2p:getState',
  P2P_V2_STATE: 'p2p:state',
  P2P_V2_JOIN_GROUP: 'p2p:joinGroup',
  P2P_V2_RESUME_GROUP: 'p2p:resumeGroup',
  P2P_V2_LEAVE_GROUP: 'p2p:leaveGroup',
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

Nhờ có `as const`:
1. Các tên kênh IPC không bị suy diễn thành kiểu `string` chung chung mà trở thành các hằng chuỗi cố định tuyệt đối (ví dụ `'p2p:joinGroup'`).
2. Trình biên dịch TypeScript sẽ báo lỗi ngay lập tức nếu bất kỳ file nào gõ sai chính tả tên kênh.

### 2.2. Interface API và Type Guard `isThemePreference`

```typescript
// src/shared/contracts.ts:3-20
export type ThemePreference = 'system' | 'light' | 'dark'
export type ShellCommand = 'open-command-palette' | 'open-appearance'

export interface P2pApi {
  readonly isMac: boolean
  getTheme(): Promise<ThemePreference>
  setTheme(theme: ThemePreference): Promise<ThemePreference>
  onCommand(listener: (command: ShellCommand) => void): () => void
  readonly p2p: P2pMultipleGroupsP2pApi & KazaaP2pApi
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}
```

Hàm `isThemePreference` bảo đảm khi người dùng đổi theme hoặc file cấu hình đĩa nạp lên, giá trị nhận được từ môi trường ngoài phải được thẩm định nghiêm ngặt trước khi được áp dụng vào DOM hoặc ghi xuống đĩa.

</section>

---

<section id="shared-p2p">

## 3. Kiểu miền dữ liệu & Bộ tiền kiểm định đầu vào (`src/shared/p2p.ts`)

File `src/shared/p2p.ts` định nghĩa toàn bộ mô hình dữ liệu lõi của mạng P2P và các hàm tiền kiểm tra (Validation Functions) dùng chung ở cả 3 tầng: Signaling Server, Main Process và Preload/Renderer.

### 3.1. Mã lỗi chuẩn `P2pErrorCode` và `ActionResult`

Hệ thống quy chuẩn 14 mã lỗi định danh thống nhất:

```typescript
// src/shared/p2p.ts:1-18
export type P2pErrorCode =
  | 'INVALID_INPUT'        // Tham số truyền vào sai cú pháp hoặc vượt giới hạn
  | 'AUTH_FAILED'          // Sai token mật mã nhóm
  | 'DISCONNECTED'         // Mất kết nối tới Signaling Server hoặc peer
  | 'NO_SUPERNODE'         // Nhóm chưa bầu chọn được Supernode đại diện
  | 'UNREACHABLE'          // Không thể xuyên thủng NAT để tạo kênh WebRTC
  | 'NOT_FOUND'            // Không tìm thấy file hoặc nhóm yêu cầu
  | 'FILE_CHANGED'         // File chia sẻ bị thay đổi kích thước/mã băm trong lúc đang truyền
  | 'DESTINATION_EXISTS'   // Tên file tải về đã tồn tại trên thư mục đích của máy nhận
  | 'IO_ERROR'             // Lỗi đọc/ghi ổ cứng cục bộ
  | 'BUSY'                 // Hệ thống đang bận thực thi tác vụ khác
  | 'PROTOCOL_ERROR'       // Gói tin sai cấu trúc giao thức
  | 'FORBIDDEN'            // Quyền truy cập bị từ chối
  | 'INVITATION_REQUIRED'  // Chưa nạp mã mời của nhóm

export type ActionResult<T = void> =
  | { ok: true }
  | { ok: false; code: P2pErrorCode; message: string }
```

### 3.2. Cấu trúc và kỹ thuật tuần tự hóa `GroupKey`

Trong mô hình đa nhóm, một người dùng có thể tham gia nhiều nhóm khác nhau trên cùng một máy chủ hoặc trên nhiều máy chủ Signaling khác nhau. Để tránh xung đột (Collision), một nhóm được định danh duy nhất bởi cặp giá trị: `[signalingUrl, groupId]`.

```typescript
// src/shared/p2p.ts:34-56
export type GroupKey = string

export function makeGroupKey(signalingUrl: string, groupId: string): GroupKey {
  return JSON.stringify([signalingUrl, groupId])
}

export function parseGroupKey(key: string): { signalingUrl: string; groupId: string } | null {
  if (typeof key !== 'string') return null
  try {
    const parsed = JSON.parse(key) as unknown
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return { signalingUrl: parsed[0], groupId: parsed[1] }
    }
  } catch {
    // Không quăng lỗi, trả về null nếu format sai
  }
  return null
}
```

Ví dụ một `GroupKey` thực tế lưu trong `Map` hoặc gửi qua IPC:
`"[\"ws://127.0.0.1:8787/signal\",\"cyber-security-lab\"]"`

### 3.3. Các hàm tiền kiểm định nghiêm ngặt (Zero-Trust Input Validators)

Tất cả dữ liệu từ người dùng hoặc từ mạng đều được coi là không an toàn. Các hàm sau đây chặn đứng dữ liệu sai lệch ngay tại cửa khẩu:

#### 1. Thẩm định URL Signaling (`validateSignalingUrl`)
- Chỉ chấp nhận giao thức `wss:` (WebSocket Secure qua TLS) trên Internet công cộng.
- Chỉ cho phép giao thức không mã hóa `ws:` đối với các địa chỉ loopback cục bộ (`127.0.0.1`, `[::1]`, `localhost`) để phục vụ phát triển.
- Bắt buộc `pathname` phải là `/signal`.
- Cấm hoàn toàn việc nhúng thông tin đăng nhập (`username`, `password`) hoặc query parameters / URL hash.

#### 2. Thẩm định Group ID (`validateGroupId` / `validateRoomId`)
- Sử dụng biểu thức chính quy `/^[A-Za-z0-9_-]{1,32}$/`.
- Giới hạn từ 1 đến 32 ký tự, chỉ gồm chữ cái, chữ số, dấu gạch dưới và dấu gạch ngang.

#### 3. Thẩm định Token Mật mã (`validateToken`)
- Kiểm tra khớp Regex `/^[A-Za-z0-9_-]{43}$/`.
- Giải mã base64url để bảo đảm token giải mã ra chính xác **32 bytes dữ liệu nhị phân (256 bits entropy)**:
  ```typescript
  // src/shared/p2p.ts:405-418
  const base64 = token.replace(/-/g, '+').replace(/_/g, '/') + '='
  const binary = atob(base64)
  if (binary.length !== 32) {
    return { valid: false, error: 'Token must decode to exactly 32 bytes' }
  }
  // Kiểm tra biểu diễn chuẩn tắc (Canonical representation): không chứa bit thừa
  const reencoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  if (reencoded !== token) {
    return { valid: false, error: 'Token must be canonical base64url' }
  }
  ```

#### 4. Thẩm định Tên hiển thị (`validateDisplayName`)
- Độ dài từ 1 đến 40 ký tự sau khi đã cắt khoảng trắng thừa (`trim`).
- Cấm chứa ký tự điều khiển ẩn (Control Characters): `/[\u0000-\u001F\u007F]/`.

#### 5. Thẩm định Mã mời nhóm (`validateGroupInvitation`)
Hỗ trợ chuyển đổi mượt mà mã mời phiên bản cũ V1 (`{ version: 1, roomId, ... }`) sang cấu trúc V2 (`{ version: 2, groupId, ... }`), giúp người dùng cũ dán mã mời mà không bị lỗi.

</section>

---

<section id="shared-p2p-wire">

## 4. Giao thức tầng dây & Runtime Type Guards (`src/shared/p2p-wire.ts`)

File `src/shared/p2p-wire.ts` định nghĩa khuôn mẫu chính xác của từng byte dữ liệu bay qua kết nối mạng WebSocket (Signaling) và WebRTC Data Channel (P2P Mesh).

### 4.1. Hằng số kích thước và thời hạn thuê (Lease Invariants)

```typescript
// src/shared/p2p-wire.ts:3-10
export const MAX_SIGNALING_MESSAGE_SIZE = 131072  // 128 KiB: Giới hạn 1 gói tin Signaling
export const MAX_CONTROL_MESSAGE_SIZE = 16384     // 16 KiB: Giới hạn 1 gói tin Overlay Control
export const MAX_TRANSFER_CONTROL_SIZE = 1024     // 1 KiB: Giới hạn gói tin bắt tay truyền file
export const MAX_TRANSFER_CHUNK_SIZE = 16384      // 16 KiB: Kích thước chuẩn của 1 khối nhị phân file
export const MAX_CATALOG_BATCH_ENTRIES = 32       // Tối đa 32 file trong 1 đợt đồng bộ danh mục
export const MAX_SEARCH_RESULTS_ENTRIES = 16      // Tối đa 16 kết quả trả về trong 1 đợt tìm kiếm
export const MAX_SEARCH_QUERY_LENGTH = 120        // Độ dài tối đa của từ khóa tìm kiếm
export const ROSTER_FRESHNESS_LEASE_MS = 6000     // 6 giây: Thời hạn hiệu lực của quyền Supernode
```

### 4.2. Helper nhãn kênh dữ liệu WebRTC

Hệ thống phân chia 2 loại WebRTC Data Channel:
1. **Control Channel**: Nhãn cố định `p2p-multiple-groups-control-v2` dùng để trao đổi danh mục file, lệnh tìm kiếm, ping/pong đa nhóm.
2. **File Transfer Channel**: Kênh riêng biệt cho từng lượt truyền file, nhãn có tiền tố kèm mã nhóm và mã chuyển giao (UUID):
   ```typescript
   // src/shared/p2p-wire.ts:15-31
   export function makeFileChannelLabelV2(groupId: string, transferId: string): string {
     return `p2p-multiple-groups-file-v2:${groupId}:${transferId}`
   }
   ```
   Hàm `parseFileChannelLabelV2(label)` kiểm tra tính hợp lệ của UUID bằng hàm `isUuid` trước khi cho phép mở luồng dữ liệu.

### 4.3. Runtime Type Guards phòng vệ tầng dây

Để đối phó với nguy cơ các bên thứ ba gửi gói tin JSON bị biến chế (Malicious JSON injection), codebase xây dựng các hàm Type Guard thẩm định từng trường:

```typescript
// src/shared/p2p-wire.ts
export function isServerSignalingMessageV2(val: unknown): val is ServerSignalingMessageV2 {
  if (!val || typeof val !== 'object') return false
  const msg = val as Record<string, unknown>
  if (msg.v !== 2 || typeof msg.type !== 'string') return false

  switch (msg.type) {
    case 'welcome':
      return typeof msg.sessionId === 'string' && isSignalingIceConfig(msg.iceConfig)
    case 'group-joined':
      return (
        typeof msg.groupId === 'string' &&
        typeof msg.membershipId === 'string' &&
        typeof msg.epoch === 'string' &&
        typeof msg.revision === 'number' &&
        Array.isArray(msg.peers)
      )
    case 'roster':
      return (
        typeof msg.groupId === 'string' &&
        typeof msg.epoch === 'string' &&
        typeof msg.revision === 'number' &&
        Array.isArray(msg.peers)
      )
    case 'signal':
      return (
        typeof msg.groupId === 'string' &&
        typeof msg.fromPeerId === 'string' &&
        typeof msg.toPeerId === 'string' &&
        isWebRtcSignalData(msg.data)
      )
    case 'error':
      return typeof msg.code === 'string' && typeof msg.message === 'string'
    default:
      return false
  }
}
```

Bất kỳ gói tin nào không thỏa mãn các điều kiện trên sẽ bị loại bỏ ngay lập tức tại tầng Socket.

</section>

---

<section id="preload-bridge">

## 5. Cửa khẩu An ninh Preload Script (`src/preload/index.ts`)

Tiến trình Preload chạy với đặc quyền đặc biệt: nó có thể truy cập các API của Node.js/Electron (`ipcRenderer`), nhưng đồng thời chia sẻ môi trường với cửa sổ trình duyệt của Renderer. Đây chính là "cửa ngõ biên giới" kiểm soát an ninh.

### 5.1. Cơ chế đóng gói hàm IPC và Cleanup Closures

Thay vì phơi bày trực tiếp đối tượng `ipcRenderer` cho giao diện (một lỗ hổng bảo mật chết người), file `src/preload/index.ts` đóng gói từng thao tác thành các hàm phương thức rõ ràng:

```typescript
// src/preload/index.ts:37-47
joinGroup(options: JoinGroupOptions): Promise<ActionResult> {
  // Chỉ gửi dữ liệu đi qua kênh hợp đồng chuẩn hóa
  return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_JOIN_GROUP, options)
},

leaveGroup(groupKey: GroupKey): Promise<ActionResult> {
  return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_LEAVE_GROUP, groupKey)
}
```

Đối với các sự kiện lắng nghe liên tục từ Main Process gửi sang giao diện (như cập nhật trạng thái mạng `onState`), Preload Script tạo một hàm bọc và **trả về một hàm dọn dẹp (Cleanup Closure)**:

```typescript
// src/preload/index.ts:25-35
onState(listener: (state: any) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, state: any): void => {
    listener(state)
  }
  // Đăng ký cả 2 kênh V2 và V1
  ipcRenderer.on(IPC_CHANNELS.P2P_V2_STATE, wrapped)
  ipcRenderer.on(IPC_CHANNELS.P2P_STATE, wrapped)

  // Trả về hàm hủy đăng ký: Người gọi chỉ cần thực thi hàm này khi unmount!
  return () => {
    ipcRenderer.removeListener(IPC_CHANNELS.P2P_V2_STATE, wrapped)
    ipcRenderer.removeListener(IPC_CHANNELS.P2P_STATE, wrapped)
  }
}
```

### 5.2. Kỹ thuật định tuyến chữ ký kép (Dual-Signature Routing)

Để hỗ trợ cả giao diện V2 mới (chỉ định rõ `groupKey`) và các component V1 cũ (chỉ truyền `query`), các phương thức trong Preload Script tự động kiểm tra số lượng và kiểu của đối số:

```typescript
// src/preload/index.ts:84-96
search(arg1: string, arg2?: string): Promise<ActionResult> {
  if (arg2 !== undefined) {
    // Chữ ký V2: search(groupKey, query) -> Gửi tới kênh V2
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_SEARCH, arg1, arg2)
  }
  // Chữ ký V1: search(query) -> Gửi tới kênh V1
  return ipcRenderer.invoke(IPC_CHANNELS.P2P_SEARCH, arg1)
},

download(arg1: string, arg2?: string): Promise<ActionResult> {
  if (arg2 !== undefined) {
    // Chữ ký V2: download(groupKey, resultId)
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_DOWNLOAD, arg1, arg2)
  }
  // Chữ ký V1: download(resultId)
  return ipcRenderer.invoke(IPC_CHANNELS.P2P_DOWNLOAD, arg1)
}
```

### 5.3. Cô lập hoàn toàn môi trường với `contextBridge.exposeInMainWorld`

Ở cuối file `src/preload/index.ts:132-133`:
```typescript
contextBridge.exposeInMainWorld('p2p', api)
contextBridge.exposeInMainWorld('kazaa', api)
```

`contextBridge.exposeInMainWorld` thực hiện cơ chế **Đóng băng ngữ cảnh (Context Isolation)**:
1. Tạo một bản sao bất biến của đối tượng `api` trên đối tượng toàn cục `window.p2p` và `window.kazaa` của trình duyệt.
2. Mã JavaScript chạy trên giao diện React **tuyệt đối không thể truy cập** vào các prototype ngầm của Node.js, không thể đọc `process.env`, và không thể ghi đè phương thức IPC.

</section>

---

<section id="signaling-service">

## 6. Dịch vụ Máy chủ Signaling & Công cụ CLI (`services/signaling/*`, `scripts/create-invite.ts`)

Máy chủ Signaling là thành phần máy chủ duy nhất trong toàn hệ thống, chịu trách nhiệm kết nối các peer ban đầu trước khi WebRTC Data Channel trực tiếp được thiết lập.

### 6.1. Phân giải cấu hình đa nguồn `loadSignalingOptions` trong `config.ts`

Hàm `loadSignalingOptions(env)` hỗ trợ nạp cấu hình linh hoạt từ biến môi trường với thứ tự ưu tiên chặt chẽ:
1. Đọc Port và Host: Đọc `P2P_MULTIPLE_GROUPS_SIGNAL_HOST` và `P2P_MULTIPLE_GROUPS_SIGNAL_PORT` (tự động nhận diện môi trường Cloud qua biến `PORT` / `RENDER`).
2. Danh sách Nhóm: Nạp chuỗi JSON đa nhóm từ biến `P2P_MULTIPLE_GROUPS_GROUPS_JSON` (tùy chọn; nếu rỗng, máy chủ khởi động ở chế độ tạo nhóm động). Hàm kiểm tra tính duy nhất của từng `groupId` và `token` thông qua hai tập hợp `seenGroupIds = new Set()` và `seenTokens = new Set()`.
3. Cấu hình NAT Traversal (STUN / TURN): Thẩm định URL máy chủ STUN (`stun:`) và TURN (`turn:`, `turns:`). Nếu cấu hình TURN có `turnSecret`, hệ thống bật chế độ cấp chứng thực động qua HMAC-SHA1.
### 6.2. Bộ điều phối `createSignalingServer` trong `server.ts`

File `services/signaling/server.ts` quản lý toàn bộ vòng đời socket:

#### 1. Khởi tạo nhóm và bộ đệm so sánh nhanh
```typescript
// services/signaling/server.ts:130-141
for (const g of groupDefinitions) {
  // Cấp phát trước tokenBuffer nhị phân để so sánh hằng thời gian cực nhanh
  const tokenBuffer = Buffer.from(g.token, 'utf-8')
  groupMap.set(g.groupId, {
    groupId: g.groupId,
    token: g.token,
    tokenBuffer,
    epoch: randomUUID(),
    revision: 1,
    nextJoinOrder: 1,
    members: new Map()
  })
}
```

#### 2. Điểm cuối HTTP `/healthz` và WebSocket Upgrade `/signal`
Server lắng nghe cổng HTTP:
- Yêu cầu `GET /healthz`: Trả về ngay mã `200 OK` với body `{"status":"ok"}` để các bộ cân bằng tải (Azure Load Balancer, Render Health Check) kiểm tra sức khỏe máy chủ.
- Yêu cầu HTTP Upgrade tại đường dẫn `/signal`: Kiểm tra kích thước gói tin tối đa `maxPayload: MAX_SIGNALING_MESSAGE_SIZE` (128 KiB) trước khi chấp thuận nâng cấp lên WebSocket.

#### 3. Bộ giới hạn tần suất Token-Bucket (Rate Limiter) chống DoS
Mỗi kết nối socket được gán một giỏ token riêng:
- Kích thước giỏ tối đa (Burst capacity): 60 token.
- Tốc độ hồi phục: 30 token/giây.
- Mỗi khi socket gửi lên một gói tin, nó tiêu tốn 1 token. Nếu giỏ hết token, gói tin bị từ chối với mã lỗi `RATE_LIMITED`.

#### 4. So sánh hằng thời gian `timingSafeEqual`
Khi client gửi yêu cầu tham gia nhóm kèm `token`:
```typescript
// services/signaling/server.ts:316-320
const providedBuf = Buffer.from(token, 'utf-8')
if (providedBuf.length !== group.tokenBuffer.length || !timingSafeEqual(providedBuf, group.tokenBuffer)) {
  return sendError(ws, 'INVALID_TOKEN', 'Group token rejected')
}
```
Ngăn chặn 100% nguy cơ rò rỉ khóa bí mật qua kỹ thuật tấn công đo thời gian nano-giây.

#### 5. Cấp chứng thực TURN động (RFC 5766 HMAC-SHA1)
Nếu máy chủ cấu hình `turnSecret`, mỗi khi client yêu cầu `ice-config`, máy chủ tính toán mật khẩu tạm thời có thời hạn 24 giờ:
```typescript
const timestamp = Math.floor(Date.now() / 1000) + 86400
const username = `${timestamp}:${peerId}`
const hmac = createHmac('sha1', turnSecret)
hmac.update(username)
const turnPassword = hmac.digest('base64')
```

#### 6. Xử lý thông điệp V2
- `register`: Đăng ký danh tính vật lý `peerId` và tên hiển thị `displayName` cho socket.
- `join-group`: Thẩm định token, cấp mã `membershipId = randomUUID()`, tăng `nextJoinOrder` và `revision`, sau đó gửi thông điệp `group-joined` cho người mới và phát thanh (broadcast) thông điệp `roster` cập nhật cho toàn bộ thành viên trong nhóm.
- `signal`: Kiểm tra nghiêm ngặt bảo đảm **cả người gửi và người nhận đều đang là thành viên hợp lệ của cùng một `groupId`** trước khi chuyển tiếp dữ liệu SDP Offer/Answer hoặc ICE Candidates.

#### 7. Quét nhịp tim định kỳ (Heartbeat Sweep)
Định kỳ mỗi 15 giây, máy chủ gửi gói tin `ping` tới tất cả các socket đang mở. Nếu một socket không gửi lại `pong` trong quá 35 giây (`now - session.lastPong > 35000`), máy chủ sẽ chủ động ngắt kết nối (`ws.terminate()`), tự động xóa peer đó khỏi toàn bộ các nhóm đã tham gia và phát thông báo cập nhật `roster` mới cho các peer còn lại.

### 6.3. Điểm khởi động dịch vụ và Trình tạo mã mời `scripts/create-invite.ts`

- **`services/signaling/index.ts`**: Đọc cấu hình từ file `.env`, khởi động `createSignalingServer`, và đăng ký lắng nghe tín hiệu `SIGINT` / `SIGTERM` từ hệ điều hành để đóng server an toàn (Graceful Shutdown).
- **`scripts/create-invite.ts`**: Công cụ CLI tiện ích. Khi người vận hành chạy lệnh `npm run signal:invite -- --group-id=nhom-a`, script sẽ nạp cấu hình, tìm nhóm tương ứng, và xuất ra chuỗi JSON tiêu chuẩn:

```json
{
  "version": 2,
  "signalingUrl": "ws://127.0.0.1:8787/signal",
  "groupId": "nhom-a",
  "token": "43-character-base64url-token..."
}
```

Người dùng chỉ cần copy chuỗi JSON này và dán vào ô "Join Group" trên giao diện desktop là có thể gia nhập mạng tức thì.

---

## Tóm tắt & Bài học ghi nhớ

1. **CSP Phân tầng**: `electron.vite.config.ts` cô lập giao diện production bằng `connect-src 'none'`, chặn đứng nguy cơ rò rỉ dữ liệu qua XSS.
2. **Hợp đồng cứng**: `IPC_CHANNELS` với `as const` loại bỏ hoàn toàn lỗi gõ sai kênh IPC tại thời điểm biên dịch.
3. **Zero-Trust Validation**: Mọi đầu vào từ mạng và người dùng (URL, GroupId, Token, DisplayName) đều phải đi qua các hàm kiểm định trước khi chạm vào lõi hệ thống.
4. **An ninh Preload**: `contextBridge.exposeInMainWorld` chỉ xuất bản các hàm bọc an toàn và cơ chế Cleanup Closures chống rò rỉ bộ nhớ.
5. **Signaling Server An toàn**: Tích hợp Token-Bucket Rate Limiter, so sánh hằng thời gian `timingSafeEqual`, cấp chứng thực TURN RFC 5766 và quét nhịp tim tự động giải phóng tài nguyên.
6. Đọc tiếp [Phần 3: Mã Nguồn Tiến Trình Main & Bộ Điều Phối P2P Engine](03-main-process-and-p2p-engine-code.md) để khám phá bộ máy chuyển giao file WebRTC và thuật toán bầu chọn Supernode HRW.
