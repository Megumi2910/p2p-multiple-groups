# Phần 4: Giao Diện Người Dùng React Renderer, Bảng Tra Cứu & Bộ Đề Vấn Đáp (Inquiry Test)

> **Chuyên mục**: Code Guide & Syntax Deep-Dive  
> **Ngôn ngữ**: Tiếng Việt (Giữ nguyên định danh kỹ thuật, cú pháp và tên file mã nguồn tiếng Anh)  
> **Các module phân tích**: `src/renderer/src/*` (Bootstrap, Hooks, Views, Commands)  
> **Nội dung đặc biệt**: Bảng tra cứu vị trí code 25+ cơ chế & Ngân hàng 32 câu hỏi vấn đáp chuyên sâu  

---

## Mục lục nội dung

1. [Khởi động Renderer & Custom Hook Quản lý State (`#renderer-bootstrap-and-hook`)](#renderer-bootstrap-and-hook)
   - 1.1. Mở rộng giao diện toàn cục `Window` trong `env.d.ts`
   - 1.2. Điểm gắn kết React 19 trong `main.tsx`
   - 1.3. Custom Hook `usePeerState`: Đăng ký IPC, Kiểm tra đơn điệu Revision và Tự động chọn nhóm
2. [Khung Ứng dụng & Các Phân hệ Chức năng (`#renderer-views`)](#renderer-views)
   - 2.1. Vỏ bọc trung tâm `App.tsx`: Điều hướng tab, Đồng bộ giao diện Dark/Light và Phím tắt
   - 2.2. Phân hệ mạng `Network.tsx`: Xử lý mã mời JSON V1/V2 và Quản lý danh sách thành viên (Roster)
   - 2.3. Phân hệ thư viện `Library.tsx`: Định dạng dung lượng byte và Cấp quyền chia sẻ nhóm
   - 2.4. Phân hệ tìm kiếm `Search.tsx`: Gom nhóm Swarm theo `sha256:size` và Lựa chọn node tải
   - 2.5. Phân hệ truyền file `Transfers.tsx`: Phân vùng tiến trình, Nhận diện Direct/Relay và Hủy tác vụ
   - 2.6. Bảng điều khiển lệnh `CommandPalette.tsx` & `Appearance.tsx`: Hộp thoại modal native `<dialog>`
3. [Bảng tra cứu nhanh vị trí 30+ cơ chế cốt lõi trong Codebase (`#bang-tra-cuu-vi-tri-code`)](#bang-tra-cuu-vi-tri-code)
4. [Bộ đề vấn đáp chuyên sâu (Inquiry Test / Viva Defense Q&A Bank) (`#bo-cau-hoi-van-dap-inquiry-test`)](#bo-cau-hoi-van-dap-inquiry-test)
   - Nhóm A: Câu hỏi về Cú pháp JS, TypeScript & React 19 (Câu 1 – 8)
   - Nhóm B: Câu hỏi về Kiến trúc Electron 3 tiến trình & Ranh giới bảo mật (Câu 9 – 16)
   - Nhóm C: Câu hỏi về Signaling, Bầu chọn Supernode HRW & Ghép kênh (Câu 17 – 24)
   - Nhóm D: Câu hỏi về Băm file, Chỉ mục tìm kiếm đảo & Truyền file SCTP (Câu 25 – 32)

---

<section id="renderer-bootstrap-and-hook">

## 1. Khởi động Renderer & Custom Hook Quản lý State

### 1.1. Mở rộng giao diện toàn cục `Window` trong `env.d.ts`

Trong TypeScript, đối tượng `window` của trình duyệt mặc định chỉ chứa các hàm Web API tiêu chuẩn (`document`, `localStorage`, `fetch`). Để TypeScript nhận diện các phương thức do Preload Script tiêm vào qua `contextBridge`, file `src/renderer/src/env.d.ts` thực hiện kỹ thuật **Declaration Merging**:

```typescript
// src/renderer/src/env.d.ts:1-9
/// <reference types="vite/client" />
import type { KazaaApi, P2pApi } from '../../shared/contracts.ts'

declare global {
  interface Window {
    p2p: P2pApi
    kazaa: KazaaApi
  }
}
```

Nhờ khối khai báo này, mọi component trong giao diện có thể gọi `window.p2p.joinGroup(...)` hoặc `window.kazaa.getTheme()` mà không bị báo lỗi thiếu thuộc tính.

### 1.2. Điểm gắn kết React 19 trong `main.tsx`

`src/renderer/src/main.tsx` sử dụng API `ReactDOM.createRoot` chuẩn của React 19 kết hợp chế độ kiểm tra nghiêm ngặt `<React.StrictMode>`:

```typescript
// src/renderer/src/main.tsx:6-13
const rootElement = document.getElementById('root')
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}
```

### 1.3. Custom Hook `usePeerState` (`src/renderer/src/features/network/usePeerState.ts`)

Hook `usePeerState` là cầu nối dữ liệu duy nhất giữa toàn bộ giao diện React và cỗ máy P2P chạy ngầm dưới Main Process.

#### Nguyên lý vận hành:
1. **Khởi tạo State ban đầu**: Gọi `bridge.p2p.getState()` ngay khi component mount để lấy dữ liệu snapshot đầu tiên.
2. **Lắng nghe sự kiện đẩy qua IPC**: Gọi `bridge.p2p.onState(applyState)` để nhận các cập nhật trạng thái mới nhất từ Main Process.
3. **Kiểm tra tính đơn điệu Revision (Monotonic Invariant)**:
   ```typescript
   // usePeerState.ts:63 & 83-88
   const lastRevisionRef = useRef(0)

   const applyState = (incoming: CombinedPeerState) => {
     if (incoming.revision >= lastRevisionRef.current) {
       lastRevisionRef.current = incoming.revision
       setState(incoming)
     }
   }
   ```
   Dùng `useRef` lưu số revision gần nhất. Nếu một gói tin IPC bị trễ đến sau một gói tin có revision cao hơn, gói tin trễ sẽ bị bỏ qua, chống hiện tượng giật lùi giao diện.
4. **Tự động chọn nhóm mặc định (Auto Group Selection)**:
   ```typescript
   // usePeerState.ts:66-74
   useEffect(() => {
     if (state.groups.length > 0) {
       if (!selectedGroupKey || !state.groups.some((g) => g.groupKey === selectedGroupKey)) {
         setSelectedGroupKey(state.groups[0].groupKey)
       }
     } else {
       setSelectedGroupKey(null)
     }
   }, [state.groups, selectedGroupKey])
   ```
5. **Gói gọn các hàm Action trong `useCallback`**: Các hàm `joinGroup`, `leaveGroup`, `search`, `download` được bọc trong `useCallback` với dependency rỗng `[]` để giữ nguyên tham chiếu hàm, giúp các component con không bị re-render vô ích.

</section>

---

<section id="renderer-views">

## 2. Khung Ứng dụng & Các Phân hệ Chức năng

### 2.1. Vỏ bọc trung tâm `App.tsx`

`src/renderer/src/App.tsx` đóng vai trò là Application Shell:
- **Điều hướng tab view (`currentView`)**: Quản lý hiển thị giữa các phân hệ: `'network' | 'library' | 'search' | 'transfers' | 'appearance'`.
- **Đồng bộ Theme với DOM**: Lắng nghe thay đổi theme và gán trực tiếp vào thuộc tính của thẻ gốc `<html>`:
  ```typescript
  document.documentElement.setAttribute('data-theme', appliedTheme)
  ```
- **Lắng nghe phím tắt toàn cục**:
  - `Ctrl+K` (hoặc `Cmd+K` trên macOS): Mở Command Palette.
  - `Ctrl+,`: Mở mục Appearance.
- **Quản lý tiêu điểm hỗ trợ tiếp cận (Accessibility Focus Management)**:
  ```typescript
  const workspaceHeadingRef = useRef<HTMLHeadingElement>(null)
  // Khi đổi tab view, tự động focus vào thẻ h1 của view mới để hỗ trợ công nghệ đọc màn hình:
  workspaceHeadingRef.current?.focus()
  ```

### 2.2. Phân hệ mạng `Network.tsx`

Nằm tại `src/renderer/src/features/network/Network.tsx`:
- **Giải mã mã mời nhóm**: Khi người dùng dán chuỗi JSON lời mời vào textarea, hàm `parseGroupInvitation(inviteInput)` sẽ tự động phát hiện mã mời V2 hoặc V1 cũ, kiểm tra URL, GroupId, Token và hiển thị cảnh báo lỗi nếu mã mời không hợp lệ.
- **Bảng danh sách thành viên (Roster Table)**: Hiển thị danh sách các node trong nhóm, vai trò đắc cử (`supernode` với huy hiệu nổi bật hoặc `ordinary`), trạng thái kết nối WebRTC (`direct` hay `relay`), và nút gạt cho phép node tự ứng cử làm Supernode.

### 2.3. Phân hệ thư viện `Library.tsx`

Nằm tại `src/renderer/src/features/library/Library.tsx`:
- **Định dạng dung lượng chuẩn (`formatBytes`)**: Chuyển đổi số byte nhị phân thành `KiB`, `MiB`, `GiB` dễ đọc.
- **Thao tác tập tin**: Gọi `onAddFiles` (mở hộp thoại native OS), `onRescan` (quét lại thư mục) và `onRemoveFile`.
- **Cấp quyền truy cập theo nhóm (Fine-Grained Group Grants)**: Mỗi hàng file hiển thị danh sách các checkbox tương ứng với các nhóm mà node đang tham gia. Khi người dùng tick hoặc bỏ tick một nhóm, hàm `onSetFileGroups(fileId, newGroupKeys)` gửi danh sách khóa nhóm mới xuống Main Process để cập nhật quyền truy cập ngay lập tức.

### 2.4. Phân hệ tìm kiếm `Search.tsx`

Nằm tại `src/renderer/src/features/search/Search.tsx`:
- **Bộ chọn phạm vi nhóm (Group Scope Selector)**: Cho phép người dùng chọn tìm kiếm trong một nhóm cụ thể hoặc tìm kiếm trên nhóm hiện tại.
- **Gom nhóm Swarm (Swarm Aggregation)**:
  Một file có thể được chia sẻ bởi nhiều peer khác nhau trong nhóm. `Search.tsx` gom các kết quả trùng mã băm và kích thước vào một đối tượng `GroupedResult`:
  ```typescript
  // Search.tsx:102-118
  const groupedMap = new Map<string, GroupedResult>()
  for (const item of currentSearch.results) {
    const key = `${item.file.sha256}:${item.file.size}`
    let group = groupedMap.get(key)
    if (!group) {
      group = {
        groupKey: key,
        sha256: item.file.sha256,
        size: item.file.size,
        primaryName: item.file.name,
        sources: [],
        selectedSourceIndex: 0
      }
      groupedMap.set(key, group)
    }
    group.sources.push(item)
  }
  ```
- **Lựa chọn node tải (Source Selection)**: Người dùng có thể chọn tải file từ node nào trong danh sách các node cùng sở hữu file đó thông qua dropdown menu nguồn tải.

### 2.5. Phân hệ truyền file `Transfers.tsx`

Nằm tại `src/renderer/src/features/transfers/Transfers.tsx`:
- **Phân chia 2 vùng hiển thị**:
  - `activeTransfers`: Các tác vụ đang truyền (`transferring`, `connecting`, `verifying`).
  - `completedTransfers`: Các tác vụ đã kết thúc (`completed`, `failed`, `cancelled`).
- **Thanh tiến trình thực tế**: Tính phần trăm `% = (transferredBytes / totalBytes) * 100`.
- **Huy hiệu đường truyền**: Hiển thị rõ `Direct` (xuyên NAT thành công) hoặc `Relayed (TURN)` (đi qua máy chủ chuyển tiếp).
- **Thao tác điều khiển**: Hỗ trợ nút "Cancel" hủy truyền file tức thì và nút "Search Again" tìm nguồn tải mới nếu lượt tải thất bại.

### 2.6. Bảng điều khiển lệnh `CommandPalette.tsx` & `Appearance.tsx`

- **`Appearance.tsx`**: Cho phép người dùng chọn giữa 3 giao diện: `System Default`, `Dark Theme`, hoặc `Light Theme`.
- **`CommandPalette.tsx`**: Modal điều khiển nhanh sử dụng thẻ `<dialog>` native của HTML5:
  ```typescript
  // src/renderer/src/features/commands/CommandPalette.tsx:21 & 45
  const dialogRef = useRef<HTMLDialogElement>(null)
  dialogRef.current?.showModal()
  ```
  Hỗ trợ lọc lệnh thông minh bằng hàm `filterCommands(query)`, điều hướng danh sách bằng các phím mũi tên `ArrowUp` / `ArrowDown`, kích hoạt bằng phím `Enter` và đóng modal bằng phím `Escape`.

</section>

---

<section id="bang-tra-cuu-vi-tri-code">

## 3. Bảng tra cứu nhanh vị trí 30+ cơ chế cốt lõi trong Codebase

Bảng tra cứu dưới đây là "kim chỉ nam" giúp bạn định vị chính xác từng dòng code khi bảo vệ vấn đáp:

| Cơ chế kỹ thuật | File mã nguồn | Hàm / Lớp / Định danh | Dòng code then chốt |
|---|---|---|---|
| **Bầu chọn Supernode theo joinOrder** | `src/main/p2p/election.ts` | `electSupernodes` | Lọc `supernodeEligible`, sắp xếp `a.joinOrder - b.joinOrder` |
| **Băm phân tán Rendezvous (HRW)** | `src/main/p2p/election.ts` | `selectSupernodesForPeer` | `createHash('sha256').update(`${peerId}:${s.peerId}`)` |
| **Vòng đệm sự kiện phục hồi (100 item)** | `src/main/p2p/election.ts` | `RecoveryEventRingBuffer` | `this.events.unshift(event); if (len > 100) pop()` |
| **Khóa đơn phiên (Single Instance)** | `src/main/index.ts` | `app.requestSingleInstanceLock` | Thoát ứng dụng nếu có phiên bản khác đang chạy |
| **Thẩm định an ninh IPC 4 tầng** | `src/main/index.ts` | `validateSender` | Kiểm tra window, webContents, parent===null, origin match |
| **Bộ đệm trễ IPC 200ms (Throttle)** | `src/main/index.ts` | `dispatchStateToWindow` | `setTimeout(..., 200)` gom snapshot trước khi gửi IPC |
| **Đóng ứng dụng an toàn (Teardown 5s)** | `src/main/index.ts` | Sự kiện `before-quit` | `Promise.race([peerEngine.dispose(), timeout5s])` |
| **Di trú Profile Kazaa cũ** | `src/main/profile-migration.ts` | `findLegacyProfileDirectory` | Dò tìm thư mục `Kazaa/kazaa` và sao chép an toàn |
| **Két mã hóa phần cứng (DPAPI/Keychain)** | `src/main/p2p/credential-store.ts` | `SafeCredentialStore` | `safeStorage.encryptString`, phân quyền file `0o600` |
| **Fallback lưu token trong RAM** | `src/main/p2p/credential-store.ts` | `memoryCache` | Fallback khi `isEncryptionAvailable() === false` trên Linux |
| **Nâng cấp trạng thái V1 lên V2** | `src/main/p2p/peer-store.ts` | `migratePeerStateV1` | Tạo `peer-state.v1.backup.json` và nâng cấp cấu trúc |
| **Ghi đĩa nguyên tử (.tmp rename)** | `src/main/p2p/peer-store.ts` | `writeQueue` | Ghi ra `.tmp` rồi gọi `rename()` tráo đổi tức thì |
| **Vân tay file siêu tốc (Không băm lại)** | `src/main/p2p/library.ts` | `statFingerprint` | So sánh `{ size, mtimeMs, ino }` khi rescan thư viện |
| **Hàng đợi băm file 2 luồng** | `src/main/p2p/library.ts` | `MAX_CONCURRENT_HASHING` | Hạn mức 2 luồng song song tính SHA-256 dưới nền |
| **Cấp quyền chia sẻ theo nhóm** | `src/main/p2p/library.ts` | `setFileGroups` | Quản lý mảng `groupKeys: []` cho từng file |
| **Bộ đệm gom danh mục Supernode (5s)** | `src/main/p2p/search-index.ts` | `CATALOG_STAGING_TTL_MS` | Đặt timer 5,000 ms tự hủy bộ đệm nếu nhận dở dang |
| **Tìm kiếm Unicode NFKC & AND logic** | `src/main/p2p/search-index.ts` | `matchesQuery` | `fileName.normalize('NFKC')` & `tokens.every(...)` |
| **Bộ nhớ đệm tìm kiếm (Query Cache)** | `src/main/p2p/search-index.ts` | `queryCache` | Lưu 256 kết quả tìm kiếm gần nhất trong 30 giây |
| **Khử trùng kết quả tìm kiếm (200 item)** | `src/main/p2p/search-index.ts` | `SearchResultsTracker` | Khóa `${ownerPeerId}:${fileId}`, giới hạn tối đa 200 bản ghi |
| **Gom nhóm Swarm theo sha256 & size** | `src/renderer/src/features/search/Search.tsx` | `groupedMap` | Gom kết quả theo `${sha256}:${size}` để chọn node tải |
| **Kiểm tra tính đơn điệu Revision** | `src/renderer/src/features/network/usePeerState.ts` | `lastRevisionRef` | `if (incoming.revision >= lastRevisionRef.current)` |
| **Kiểm tra đơn điệu (epoch, rev) mạng** | `src/main/p2p/signaling-client.ts` | `handleMessage` | Hủy gói tin cũ có revision nhỏ hơn revision hiện tại |
| **Tái kết nối lũy thừa có nhiễu (Jitter)**| `src/main/p2p/signaling-client.ts` | `scheduleReconnect` | Tăng dần 1s, 2s, 4s, tối đa 30s kèm random Jitter |
| **Gộp 1 kết nối WebRTC cho nhiều nhóm** | `src/main/p2p/transport.ts` | `connections` Map | 1 `RTCPeerConnection` duy nhất giữa 2 peer bất kỳ |
| **Giải quyết đụng độ Glare tất định** | `src/main/p2p/transport.ts` | `initiateOrRequestConnection` | `this.localPeerId < remotePeer.peerId` chủ động tạo Offer |
| **Phát khối 16 KiB qua Data Channel** | `src/main/p2p/transfers.ts` | `CHUNK_SIZE = 16384` | Cắt nhỏ file thành từng khối 16 KiB truyền qua SCTP |
| **Thu hồi quyền tức thì giữa chừng** | `src/main/p2p/transfers.ts` | `isPeerAuthorized` | Kiểm tra quyền trước mỗi khối 16 KiB phát đi |
| **Kiểm soát dòng chảy Backpressure** | `src/main/p2p/transfers.ts` | `HIGH_WATER_BUFFER` | ACK sau 256 KiB; tạm dừng đọc đĩa nếu unacked >= 512 KiB |
| **Cam kết file nguyên tử bằng hard link**| `src/main/p2p/transfers.ts` | `link(partPath, dest)` | Dùng `link()` tạo file đích, bắt lỗi `EEXIST` nếu trùng |
| **Tuần tự hóa hàng đợi nuốt lỗi** | `src/main/p2p/engine.ts` | `queueAction` | `policyQueue = enqueued.then(() => {}, () => {})` |
| **Giám sát thời hạn hiệu lực nhóm (6s)** | `src/main/p2p/engine.ts` | `monitorTimer` | Chu kỳ 2s kiểm tra `ROSTER_FRESHNESS_LEASE_MS = 6000` |
| **Token-Bucket Rate Limiter máy chủ** | `services/signaling/server.ts`| `checkRateLimit` | Giỏ 60 token, hồi phục 30 token/giây chống DoS |
| **So sánh hằng thời gian chống Timing**| `services/signaling/server.ts`| `timingSafeEqual` | So sánh token bằng `timingSafeEqual` thay cho `===` |
| **Cấp chứng thực TURN RFC 5766** | `services/signaling/server.ts`| `createHmac('sha1')` | Cấp username và password tạm thời hiệu lực 24 giờ |
| **Dọn rác socket tự động với WeakMap** | `services/signaling/server.ts`| `upgradeGroupIdMap` | `new WeakMap<WebSocket, string>()` chống rò rỉ RAM |
| **Tiêm CSP Dev vs Prod** | `electron.vite.config.ts` | `kazaaCsp` plugin | Dev cho phép `ws:`, Prod khóa cứng `connect-src 'none'` |

</section>

---

<section id="bo-cau-hoi-van-dap-inquiry-test">

## 4. Bộ đề vấn đáp chuyên sâu (Inquiry Test / Viva Defense Q&A Bank)

Dưới đây là bộ 32 câu hỏi và câu trả lời hoàn chỉnh được thiết kế đặc thù cho các buổi vấn đáp đồ án tốt nghiệp, phản biện kỹ thuật hoặc phỏng vấn Senior System Engineer.

---

### Nhóm A: Cú pháp JS, TypeScript & React 19 (8 câu)

#### Câu 1: Sự khác biệt cơ bản giữa `interface` và `type` trong TypeScript là gì? Tại sao trong project này `ActionResult` dùng `type` còn `GroupInvitation` dùng `interface`?
**Trả lời:**  
`interface` dùng để định nghĩa hình dạng đối tượng (Object Shapes), hỗ trợ cơ chế hợp nhất khai báo (Declaration Merging) và kế thừa mở rộng (`extends`). Do đó, `GroupInvitation` hay `GroupRuntime` dùng `interface` vì chúng đại diện cho các cấu trúc thực thể có thể mở rộng thêm trường trong tương lai.  
Ngược lại, `type` có khả năng biểu diễn các kiểu phức tạp hơn mà `interface` không làm được: Union Types (`A | B`), Primitive Aliases, Tuple, và Mapped Types. `ActionResult` bắt buộc phải là `type` vì nó là một Tagged Union (`{ ok: true } | { ok: false; code: ... }`).

#### Câu 2: Tagged / Discriminated Union hoạt động như thế nào trong `ActionResult` và các gói tin `ServerSignalingMessageV2`?
**Trả lời:**  
Tagged Union là một tập hợp các interface đối tượng khác nhau nhưng cùng sở hữu một trường nhãn định danh chung (Discriminant Tag như `ok` hoặc `type`) với kiểu chuỗi hoặc boolean cố định (Literal Type).  
Khi lập trình viên kiểm tra nhãn này (ví dụ `if (!res.ok)` hoặc `switch (msg.type)`), trình biên dịch TypeScript sẽ thực hiện cơ chế **Thu hẹp kiểu dữ liệu (Type Narrowing)**: bên trong khối `if (!res.ok)`, TypeScript biết chắc chắn đối tượng có hai trường `code` và `message` mà không cần ép kiểu thủ công.

#### Câu 3: Toán tử `as const` mang lại lợi ích gì trong định nghĩa `IPC_CHANNELS` và `COMMAND_DESCRIPTORS`?
**Trả lời:**  
Khi không có `as const`, TypeScript suy diễn kiểu của thuộc tính đối tượng là các kiểu rộng (ví dụ chuỗi `'p2p:joinGroup'` bị suy thành `string`). Khi thêm `as const`:
1. Mọi thuộc tính trở thành `readonly`.
2. Mọi giá trị chuỗi trở thành các kiểu giá trị chính xác (String Literal Types).  
Nhờ đó, khi kết hợp với toán tử `typeof`, ta có thể tự động trích xuất kiểu dữ liệu chuẩn (`CommandId = (typeof COMMAND_DESCRIPTORS)[number]['id']`), loại bỏ hoàn toàn lỗi gõ sai chính tả kênh IPC khi biên dịch.

#### Câu 4: Phân tích cơ chế hoạt động của hàm `queueAction<T>` trong `src/main/p2p/engine.ts`. Tại sao phải gắn hai hàm rỗng `enqueued.then(() => {}, () => {})`?
**Trả lời:**  
`queueAction` hiện thực hóa mẫu tuần tự hóa Promise (Promise Chain Serialization Pattern) để thực hiện các tác vụ bất đồng bộ theo thứ tự và chống Race Condition.  
Hai hàm rỗng `enqueued.then(() => {}, () => {})` là mấu chốt để **cô lập lỗi**. Nếu tác vụ A bị thất bại (rejected), hàm bắt lỗi rỗng ở đuôi sẽ nuốt lỗi này cho chuỗi hàng đợi tổng `policyQueue`, giúp hàng đợi luôn trở về trạng thái Fulfilled thành công. Nhờ vậy, tác vụ B xếp sau không bị hủy liên đới, trong khi người gọi tác vụ A vẫn nhận đủ kết quả lỗi thông qua Promise `enqueued` trả về.

#### Câu 5: Tại sao trong `usePeerState.ts` và `App.tsx` lại sử dụng `useRef` cho `lastRevisionRef` và `isSavingThemeRef` thay vì dùng `useState`?
**Trả lời:**  
Thay đổi giá trị của `useState` sẽ kích hoạt React re-render lại component trên màn hình. Trong khi đó, `lastRevisionRef` và `isSavingThemeRef` chỉ đóng vai trò là các biến ghi nhớ kỹ thuật nội bộ (Internal State Trackers).  
Nếu dùng `useState` cho `lastRevisionRef`, mỗi lần mạng P2P cập nhật số thứ tự revision, component sẽ bị ép re-render thừa dù dữ liệu hiển thị không đổi. Thuộc tính `ref.current` cho phép đọc/ghi giá trị mới ngay lập tức trong luồng đồng bộ mà hoàn toàn không gây tốn tài nguyên render của React.

#### Câu 6: Trong hook `useEffect` của `usePeerState.ts`, tại sao bắt buộc phải trả về một hàm Cleanup (`return () => unsubscribe()`)? Hậu quả nếu quên là gì?
**Trả lời:**  
Hàm Cleanup được React tự động kích hoạt khi component bị gỡ bỏ khỏi màn hình (unmount) hoặc trước khi chạy lại effect mới.  
Trong `usePeerState.ts`, hàm Cleanup này gọi `ipcRenderer.removeListener(...)` để hủy đăng ký nhận tin từ Main Process. Nếu quên trả về hàm này, mỗi lần component mount lại, một listener mới sẽ được tạo thêm nhưng listener cũ vẫn tồn tại trong RAM. Kết quả là ứng dụng bị **rò rỉ bộ nhớ (Memory Leak)** nghiêm trọng và các hàm callback bị gọi lặp lại nhiều lần gây sai lệch dữ liệu.

#### Câu 7: Node.js 24 hỗ trợ tính năng Native Type Stripping. Điều này đòi hỏi quy tắc cú pháp gì trong mã nguồn TypeScript?
**Trả lời:**  
Native Type Stripping cho phép Node.js chạy trực tiếp file `.ts` bằng cách dùng khoảng trắng thay thế các khai báo kiểu trong bộ nhớ RAM mà không cần biên dịch sang file `.js`.  
Cơ chế này đòi hỏi mã nguồn **chỉ được chứa cú pháp có thể xóa bỏ hoàn toàn (Erasable Syntax)**, được kiểm soát bởi cờ `"erasableSyntaxOnly": true` trong `tsconfig.node.json`. Điều này bắt buộc:
1. Mọi import chỉ dùng cho kiểu dữ liệu phải viết rõ `import type`.
2. Tuyệt đối không dùng TypeScript Enums cổ điển hay Parameter Properties trong constructor, vì chúng sinh ra mã JavaScript thực tế lúc chạy.

#### Câu 8: Điểm khác nhau giữa kiểu `any` và `unknown` trong TypeScript là gì? Dự án áp dụng `unknown` kết hợp User-Defined Type Guard như thế nào?
**Trả lời:**  
`any` tắt hoàn toàn hệ thống kiểm tra kiểu của TypeScript, cho phép gọi bất kỳ phương thức nào, dẫn tới nguy cơ sập chương trình khi chạy. `unknown` là kiểu dữ liệu an toàn: TypeScript cấm thực hiện bất kỳ thao tác nào trên biến `unknown` cho tới khi kiểu của nó được thẩm định.  
Dự án gán kiểu `unknown` cho toàn bộ dữ liệu nhận từ mạng WebSocket, file đĩa JSON và tham số IPC. Sau đó, các hàm Type Guard như `isThemePreference(val): val is ThemePreference` sẽ kiểm tra tính hợp lệ bằng các toán tử JS thuần túy. Khi Type Guard trả về `true`, TypeScript sẽ tự động ép kiểu biến đó về kiểu dữ liệu an toàn.

---

### Nhóm B: Kiến trúc Electron 3 tiến trình & Ranh giới bảo mật (8 câu)

#### Câu 9: Trình bày kiến trúc 3 tiến trình của Electron trong dự án. Tại sao không để giao diện React kết nối mạng WebRTC trực tiếp?
**Trả lời:**  
Ứng dụng gồm 3 tiến trình:
1. **Main Process**: Chạy Node.js toàn quyền, quản lý WebRTC (Werift), ghi đĩa và gọi OS Keyring.
2. **Preload Script**: Cửa khẩu an ninh biên giới, tiêm API an toàn vào giao diện qua `contextBridge`.
3. **Renderer Process**: Giao diện React chạy trong sandbox của trình duyệt Chromium.  
Không cho giao diện kết nối WebRTC trực tiếp vì Renderer là vùng không tin cậy (Untrusted Sandbox). Nếu mở mạng cho Renderer, bất kỳ lỗ hổng XSS nào từ tên file độc hại cũng có thể bị lợi dụng để tấn công máy tính hoặc bí mật gửi dữ liệu ra ngoài Internet. Bằng cách khóa mạng ở giao diện, toàn bộ kết nối đều được quản lý tập trung và kiểm soát chặt chẽ ở Main Process.

#### Câu 10: Phân tích 4 lớp kiểm tra an ninh trong hàm `validateSender(event)` tại `src/main/index.ts`.
**Trả lời:**  
1. **Window Liveness**: Kiểm tra `mainWindow` đang tồn tại và chưa bị hủy (`!isDestroyed()`).
2. **Sender Identity**: So sánh con trỏ `event.sender === mainWindow.webContents` để bảo đảm thông điệp xuất phát từ đúng cửa sổ chính.
3. **Top-Level Frame**: Kiểm tra `event.senderFrame.parent === null` để chặn đứng các yêu cầu IPC xuất phát từ các thẻ `<iframe>` lồng bên trong giao diện.
4. **Origin Match**: Ở môi trường dev, URL bắt buộc phải có origin là `http://127.0.0.1:5173` và path là `/`. Ở môi trường production, URL bắt buộc phải khớp chính xác đường dẫn file HTML tĩnh nội bộ.

#### Câu 11: Chính sách CSP của dự án được cấu hình như thế nào giữa môi trường Development và Production?
**Trả lời:**  
Plugin `kazaaCsp` trong `electron.vite.config.ts` tiêm CSP động vào thẻ `<meta>` của `index.html`:
- **Development**: Cho phép `connect-src 'self' ws://127.0.0.1:5173` để hỗ trợ cơ chế Hot Module Replacement (HMR) của Vite Dev Server qua WebSocket nội bộ.
- **Production**: Khóa cứng `connect-src 'none'`. Trình duyệt chặn đứng hoàn toàn mọi nỗ lực gọi `fetch`, `XMLHttpRequest`, hoặc mở WebSocket trực tiếp từ mã nguồn giao diện.

#### Câu 12: Cơ chế `contextBridge.exposeInMainWorld` hoạt động ra sao và tại sao nó an toàn hơn việc gán trực tiếp vào `window`?
**Trả lời:**  
Nếu gán trực tiếp đối tượng API vào `window` trong môi trường tắt Context Isolation, mã nguồn trên trang web có thể truy cập vào prototype của Node.js, từ đó leo thang đặc quyền để chiếm quyền điều khiển hệ thống.  
`contextBridge.exposeInMainWorld` sử dụng cơ chế Context Isolation của Chromium để tạo một bản sao thu nhỏ (Proxy Membrane) bất biến trên `window.p2p`. Hai thế giới (Preload và Renderer) chạy trên hai bối cảnh bộ nhớ hoàn toàn tách biệt. Mã giao diện không thể can thiệp vào các biến nội bộ của Preload hay sửa đổi hành vi của các hàm IPC.

#### Câu 13: `SafeCredentialStore` bảo vệ token bí mật của nhóm như thế nào trên các hệ điều hành khác nhau?
**Trả lời:**  
- **Windows / macOS**: Sử dụng module native `electron.safeStorage` để mã hóa chuỗi token bằng Windows Data Protection API (DPAPI) hoặc macOS Keychain Services trước khi ghi xuống đĩa. File mã hóa được ghi với quyền phân quyền POSIX `0o600` (chỉ cho phép user hiện tại của hệ điều hành đọc/ghi).
- **Linux Headless**: Nếu không có Desktop Keyring (`isEncryptionAvailable() === false`), hệ thống tự động kích hoạt cơ chế fallback lưu tạm trong RAM (`memoryCache`) để phục vụ các môi trường kiểm thử hoặc máy chủ tự động mà không làm crash ứng dụng.

#### Câu 14: Kỹ thuật ghi đĩa nguyên tử (Atomic File Write) qua file `.tmp` giải quyết rủi ro gì trong `peer-store.ts` và `theme-store.ts`?
**Trả lời:**  
Nếu ghi dữ liệu trực tiếp vào file `peer-state.json`, trong trường hợp máy tính bị mất điện đột ngột hoặc ứng dụng bị tắt ngang đúng lúc hàm ghi đĩa đang chạy dở, nội dung file sẽ bị cụt hoặc rỗng (0 byte), khiến ứng dụng không thể khởi động lại vào lần sau.  
Kỹ thuật ghi đĩa nguyên tử giải quyết triệt để rủi ro này: Dữ liệu mới được ghi hoàn chỉnh vào file tạm `peer-state.json.<uuid>.tmp`. Sau khi dữ liệu đã xả hoàn tất xuống đĩa, hệ thống gọi lệnh `rename()` của hệ điều hành để tráo đổi tên file tạm thành file chính. Lệnh `rename()` ở cấp filesystem là một thao tác nguyên tử (Atomic Operation) — file hoặc giữ nguyên nội dung cũ, hoặc chuyển hoàn toàn sang nội dung mới, tuyệt đối không có trạng thái hỏng dở dang.

#### Câu 15: Tại sao cần hàm `sanitizeDestinationFileName` khi người dùng tải file về máy?
**Trả lời:**  
Tên file do các peer từ xa trên mạng P2P gửi tới là dữ liệu không đáng tin cậy. Kẻ tấn công có thể cố tình đặt tên file chứa các ký tự chuyển hướng thư mục như `../../../../Windows/System32/malicious.dll` (tấn công Path Traversal).  
Hàm `sanitizeDestinationFileName` loại bỏ toàn bộ các ký tự phân cách thư mục (`/` và `\`), cắt bỏ các chuỗi `..`, và chỉ giữ lại phần tên cơ sở an toàn (Basename) trước khi ghép vào thư mục lưu trữ mà người dùng đã chọn.

#### Câu 16: Cơ chế `app.requestSingleInstanceLock` hoạt động như thế nào và tại sao nó lại bắt buộc đối với ứng dụng này?
**Trả lời:**  
Khi ứng dụng khởi động, nó yêu cầu hệ điều hành cấp một khóa duy nhất thông qua hàm `app.requestSingleInstanceLock()`. Nếu người dùng cố tình mở thêm một cửa sổ ứng dụng thứ hai, hàm này trả về `false`, và tiến trình thứ hai sẽ tự động thoát ngay lập tức sau khi gửi tín hiệu chuyển quyền kích hoạt cửa sổ cho tiến trình đầu tiên.  
Cơ chế này bắt buộc vì ứng dụng sở hữu các tệp dữ liệu trạng thái trên đĩa (`peer-state.json`, `credentials.enc`). Nếu hai tiến trình chạy song song cùng truy cập và ghi đè lên các file này, dữ liệu trạng thái mạng P2P sẽ bị xung đột và hỏng cấu trúc.

---

### Nhóm C: Signaling, Bầu chọn Supernode HRW & Ghép kênh (8 câu)

#### Câu 17: Cấu trúc của một `GroupKey` là gì? Tại sao không dùng mỗi `groupId` để định danh nhóm?
**Trả lời:**  
`GroupKey` là một chuỗi JSON tuần tự hóa chứa cặp giá trị: `JSON.stringify([signalingUrl, groupId])`.  
Không thể chỉ dùng mỗi `groupId` vì hệ thống hỗ trợ tham gia nhiều nhóm trên các máy chủ Signaling khác nhau. Hai cộng đồng độc lập có thể vô tình đặt trùng tên nhóm (ví dụ cả hai máy chủ đều có nhóm tên `general`). Bằng cách kết hợp `signalingUrl` và `groupId`, nhóm được định danh duy nhất trên phạm vi toàn cầu, tránh việc gộp nhầm danh sách thành viên giữa hai máy chủ khác nhau.

#### Câu 18: Trình bày thuật toán bầu chọn `electSupernodes` trong `src/main/p2p/election.ts`. Tiêu chí nào được ưu tiên hàng đầu?
**Trả lời:**  
Mỗi nhóm chọn tối đa 2 Supernode theo quy trình:
1. Lọc danh sách các node có cờ `supernodeEligible === true`.
2. Sắp xếp danh sách ứng viên theo hai tiêu chí:
   - **Ưu tiên 1 (Hàng đầu)**: Thứ tự tham gia nhóm (`joinOrder` nhỏ hơn đứng trước). Tiêu chí này ưu tiên các node đã vào mạng sớm và hoạt động lâu năm, tối đa hóa tính ổn định của nhóm.
   - **Ưu tiên 2 (Giải hòa điểm - Tie-breaker)**: Nếu hai node có cùng `joinOrder`, so sánh thứ tự từ điển của `peerId` (`a.peerId.localeCompare(b.peerId)`).  
Hai ứng viên đứng đầu mảng sau khi sắp xếp sẽ đắc cử Supernode, các ứng viên còn lại nằm trong danh sách dự bị.

#### Câu 19: Highest Random Weight (HRW) / Rendezvous Hashing giải quyết bài toán gì và hoạt động như thế nào trong `selectSupernodesForPeer`?
**Trả lời:**  
Sau khi đã bầu ra các Supernode, các node bình thường cần biết phải kết nối và đẩy danh mục chia sẻ về Supernode nào để cân bằng tải và tối thiểu hóa sự xáo trộn (Minimal Churn) khi mạng có biến động.  
HRW giải quyết bài toán này mà không cần duy trì bảng điều phối tập trung:
Node tính điểm băm SHA-256 cho từng cặp kết hợp: `hash = SHA256(peerId + ":" + supernodeId)`. Sau đó sắp xếp giảm dần theo giá trị băm. Supernode có điểm băm cao nhất trở thành **Primary Supernode**, và Supernode có điểm băm cao thứ hai trở thành **Standby Supernode**. Thuật toán này bảo đảm mọi node đều tính toán ra kết quả nhất quán mà không cần trao đổi thêm thông điệp mạng.

#### Câu 20: Nguyên lý "Transport Pooling" trong `TransportManager` là gì? Lợi ích của nó đối với tài nguyên máy tính?
**Trả lời:**  
Nguyên lý: **Giữa hai máy tính vật lý bất kỳ, chỉ duy trì duy nhất MỘT đối tượng `RTCPeerConnection` WebRTC**, bất kể hai người dùng đó đang cùng sinh hoạt chung trong 1 nhóm hay 10 nhóm ảo khác nhau.  
Tất cả các thông điệp điều khiển của mọi nhóm đều được dồn kênh (Multiplex) qua Data Channel chung `p2p-multiple-groups-control-v2`.  
Lợi ích: Giảm thiểu tối đa việc bắt tay DTLS/ICE lặp lại, tiết kiệm cổng mạng, giảm thiểu tải tiêu thụ CPU/RAM và tăng tốc độ phản hồi tức thì khi người dùng tham gia thêm nhóm mới đã có sẵn bạn bè cùng nhóm cũ.

#### Câu 21: Hiện tượng xung đột Glare trong WebRTC xảy ra khi nào và codebase giải quyết nó như thế nào?
**Trả lời:**  
Hiện tượng Glare xảy ra khi cả Node A và Node B phát hiện ra nhau gần như đồng thời qua máy chủ Signaling, và cả hai cùng chủ động tạo SDP Offer và gửi cho nhau. Cả hai đều ở trạng thái chờ Answer của chính mình, dẫn đến việc xung đột trạng thái WebRTC và không thể kết nối.  
Codebase giải quyết bằng quy tắc phân xử tất định (Deterministic Tie-Breaker):
Trước khi tạo kết nối, hệ thống so sánh chuỗi định danh:
`if (this.localPeerId < remotePeer.peerId)`.  
Node nào có giá trị từ điển `peerId` nhỏ hơn sẽ nắm quyền chủ động tạo SDP Offer. Node có `peerId` lớn hơn sẽ ở vị thế thụ động gửi thông điệp yêu cầu hoặc chờ nhận Offer từ đối phương. Nhờ vậy, hiện tượng hai node cùng phát Offer bị triệt tiêu 100%.

#### Câu 22: Máy chủ Signaling bảo vệ token gia nhập nhóm chống tấn công đo thời gian (Timing Attack) như thế nào?
**Trả lời:**  
Nếu dùng toán tử so sánh thông thường `providedToken === group.token`, JavaScript sẽ so sánh từng ký tự từ trái qua phải và ngắt ngay ở ký tự sai đầu tiên. Kẻ tấn công có thể đo thời gian phản hồi ở mức nano-giây để lần lượt dò ra từng ký tự của chuỗi token bí mật.  
Máy chủ Signaling bảo vệ bằng hàm `timingSafeEqual(providedBuf, group.tokenBuffer)` từ thư viện `node:crypto`. Hàm này duyệt qua toàn bộ các byte trong mảng với thời gian chạy không đổi (hằng số thời gian), bất kể dữ liệu đúng hay sai ở vị trí nào, loại bỏ hoàn toàn khả năng bị rò rỉ khóa qua phân tích thời gian.

#### Câu 23: Cơ chế Token-Bucket Rate Limiter trên máy chủ Signaling được cấu hình ra sao?
**Trả lời:**  
Mỗi kết nối WebSocket trên máy chủ Signaling được gắn một giỏ token độc lập:
- Sức chứa tối đa của giỏ (Burst Capacity): 60 token.
- Tốc độ hồi phục: 30 token mỗi giây.  
Mỗi thông điệp gửi lên tiêu tốn 1 token. Khi giỏ cạn token, máy chủ lập tức từ chối yêu cầu với mã lỗi `RATE_LIMITED`. Cơ chế này cho phép client gửi các đợt tin ngắn dồn dập (Burst) khi vừa gia nhập mạng nhưng chặn đứng các hành vi spam tin nhắn hoặc tấn công từ chối dịch vụ (DoS) làm nghẽn máy chủ.

#### Câu 24: Thời hạn thuê `ROSTER_FRESHNESS_LEASE_MS = 6000` đóng vai trò gì trong tính nhất quán của mạng P2P?
**Trả lời:**  
Trong một hệ thống phân tán không có cơ sở dữ liệu chung, quyền lực của Supernode không phải là vĩnh cửu. Quyền lực này chỉ có giá trị dựa trên bản xác nhận định kỳ từ máy chủ Signaling.  
`ROSTER_FRESHNESS_LEASE_MS = 6000` (6 giây) là thời hạn hiệu lực tối đa của một bản snapshot thành viên. Bộ đếm thời gian `monitorTimer` chạy định kỳ mỗi 2 giây: Nếu node không nhận được tín hiệu làm mới từ Signaling Server trong quá 6 giây (ví dụ máy chủ sập hoặc đứt cáp), quyền Supernode sẽ tự động hết hạn (`expireGroupAuthority`), buộc node phải hạ cấp vai trò về chế độ phục hồi an toàn, ngăn ngừa hiện tượng phân mảnh mạng (Split-Brain).

---

### Nhóm D: Băm file, Chỉ mục tìm kiếm đảo & Truyền file SCTP (8 câu)

#### Câu 25: Kỹ thuật `statFingerprint` trong `LibraryManager` hoạt động như thế nào để tối ưu hóa hiệu năng khi khởi động hoặc quét lại thư viện?
**Trả lời:**  
Việc đọc và băm SHA-256 các file dung lượng lớn (hàng trăm MB hoặc 1 GiB) tốn rất nhiều thời gian và nghẽn CPU.  
`LibraryManager` lưu trữ một dấu vân tay hệ thống tập tin gồm bộ ba: `statFingerprint: { size, mtimeMs, ino }`.  
Khi người dùng bấm "Rescan Library", hàm kiểm tra chỉ cần gọi lệnh `stat` nhanh của hệ điều hành để so sánh kích thước file (`size`) và thời điểm sửa đổi gần nhất (`mtimeMs`). Nếu các chỉ số này không đổi, hệ thống tái sử dụng ngay mã băm SHA-256 đã lưu trước đó trong `peer-state.json`, giúp quá trình quét lại hàng nghìn file hoàn thành chỉ trong vài mili-giây.

#### Câu 26: Tại sao dự án đặt hằng số `MAX_CONCURRENT_HASHING = 2` trong `src/main/p2p/library.ts`?
**Trả lời:**  
Thuật toán băm SHA-256 tiêu tốn tài nguyên xử lý của CPU rất lớn. Nếu người dùng chọn chia sẻ cùng lúc 50 file video và hệ thống đồng thời băm cả 50 file, CPU máy tính sẽ bị quá tải 100%, làm giao diện Electron bị đơ và gián đoạn các luồng truyền dữ liệu WebRTC đang chạy.  
Bằng cách giới hạn tối đa 2 tác vụ băm song song (`MAX_CONCURRENT_HASHING = 2`) và đưa các file còn lại vào hàng đợi `hashQueue`, ứng dụng luôn duy trì được hiệu năng ổn định và trải nghiệm mượt mà cho người dùng.

#### Câu 27: Khi node hoạt động với vai trò Supernode, tại sao cần cơ chế Staging Buffer kèm bộ hẹn giờ 5 giây (`CATALOG_STAGING_TTL_MS = 5000`) khi nhận danh mục chia sẻ?
**Trả lời:**  
Danh mục file của một thành viên được chia nhỏ thành nhiều gói tin (`catalog-begin`, các gói `catalog-batch`, và `catalog-end`).  
Supernode không cập nhật trực tiếp từng gói vào chỉ mục tìm kiếm chính để tránh trạng thái dữ liệu dở dang. Thay vào đó, nó đưa vào một vùng nhớ tạm (Staging Buffer) và đặt bộ hẹn giờ 5 giây. Nếu node gửi bị sập mạng giữa chừng và không gửi gói `catalog-end`, bộ hẹn giờ 5 giây sẽ kích hoạt và tự động xóa sạch vùng nhớ tạm này, ngăn chặn nguy cơ kẻ xấu cố tình gửi dở dang hàng loạt gói tin để làm cạn kiệt bộ nhớ RAM của Supernode.

#### Câu 28: Kỹ thuật tìm kiếm trong `matchesQuery` sử dụng chuẩn hóa Unicode NFKC và logic Boolean AND như thế nào?
**Trả lời:**  
1. **Chuẩn hóa Unicode NFKC**: Trong tiếng Việt, cùng một chữ có dấu (như "ế") có thể được lưu dưới dạng ký tự dựng sẵn (Precomposed) hoặc ký tự tổ hợp (Decomposed). Hàm gọi `fileName.normalize('NFKC').toLowerCase()` để đưa toàn bộ tên file và từ khóa tìm kiếm về cùng một dạng biểu diễn nhị phân chuẩn tắc, loại bỏ lỗi tìm không thấy file do khác biệt bộ gõ Unikey.
2. **Boolean AND**: Chuỗi tìm kiếm được tách thành mảng các token. Hàm sử dụng phương thức `tokens.every((token) => normalizedName.includes(token))` — file chỉ được xem là kết quả trùng khớp nếu tên của nó chứa **đầy đủ tất cả các từ khóa** mà người dùng đã gõ.

#### Câu 29: Cơ chế kiểm soát dòng chảy (Flow Control & Backpressure) trong quá trình truyền file qua WebRTC Data Channel được thiết kế như thế nào?
**Trả lời:**  
Để bảo vệ bộ đệm socket mạng không bị tràn RAM khi đọc file từ ổ cứng SSD siêu tốc:
1. File được cắt thành các khối nhỏ 16 KiB (`CHUNK_SIZE = 16384`).
2. Bên nhận gửi thông điệp xác nhận tích lũy `ack` sau mỗi **256 KiB** dữ liệu nhận được.
3. Bên gửi giám sát số byte chưa được xác nhận `unacked = offset - lastAckedBytes`.
4. Nếu `unacked >= 512 KiB` (`MAX_UNACK_BYTES`) hoặc bộ đệm của Data Channel vượt ngưỡng `256 KiB` (`HIGH_WATER_BUFFER`), luồng đọc đĩa lập tức tạm dừng (`stream.pause()`).
5. Chỉ khi nhận được gói `ack` từ bên nhận hoặc bộ đệm socket xả xuống dưới `128 KiB` (`LOW_WATER_BUFFER`), luồng đọc đĩa mới được tiếp tục (`stream.resume()`).

#### Câu 30: Cơ chế "Thu hồi quyền chia sẻ tức thì giữa chừng" (Mid-Transfer Revocation) hoạt động ở tầng code nào?
**Trả lời:**  
Cơ chế này được cài đặt trực tiếp trong vòng lặp đọc file của máy gửi tại file `src/main/p2p/transfers.ts`.  
Trước khi đọc và phát đi từng khối nhị phân 16 KiB, máy gửi luôn gọi hàm kiểm tra quyền truy cập:
`isPeerAuthorized(groupId, remotePeerId, remoteSessionId, fileId)`.  
Nếu người dùng gỡ bỏ quyền của nhóm trong giao diện Library khi file mới tải được 50%, hàm kiểm tra sẽ trả về `false` ngay ở khối tiếp theo. Luồng phát dữ liệu lập tức bị hủy bỏ và gửi thông báo lỗi `FORBIDDEN` sang cho bên nhận, ngăn chặn việc tải nốt phần còn lại của tập tin.

#### Câu 31: Quá trình cam kết file tải về (Atomic Commit) sử dụng lệnh `link()` và `unlink()` diễn ra như thế nào? Tại sao bắt buộc phải bắt lỗi `EEXIST`?
**Trả lời:**  
Khi tải file:
1. Dữ liệu được ghi vào file tạm ẩn có tên dạng `.<filename>.tmp.<transferId>`.
2. Trong quá trình ghi, mã băm SHA-256 được tính toán song song theo luồng dữ liệu đến. Khi hoàn tất, hệ thống so sánh mã băm tính được với mã băm dự kiến ban đầu để bảo đảm tính toàn vẹn 100%.
3. Để đưa file tạm vào vị trí lưu chính thức, hệ thống gọi lệnh `link(partPath, destinationPath)` để tạo hard link nguyên tử.
4. **Bắt buộc bắt lỗi `EEXIST`**: Nếu trên máy người dùng đã có sẵn một file trùng tên, lệnh `link()` của hệ điều hành sẽ quẳng lỗi mã `EEXIST`. Hệ thống bắt mã lỗi này và hủy thao tác với mã `DESTINATION_EXISTS`, bảo đảm không bao giờ ghi đè làm mất dữ liệu quan trọng có sẵn của người dùng.
5. Sau khi tạo link thành công, lệnh `unlink(partPath)` được gọi để dọn dẹp file tạm.

#### Câu 32: Phân hệ tìm kiếm `Search.tsx` thực hiện gom nhóm Swarm (Swarm Aggregation) như thế nào và người dùng được hưởng lợi gì từ cơ chế này?
**Trả lời:**  
Khi nhiều peer trong nhóm cùng chia sẻ một bộ phim hoặc một tài liệu, kết quả tìm kiếm thô sẽ trả về nhiều bản ghi riêng rẽ gây rối màn hình.  
`Search.tsx` sử dụng `Map` để gom các kết quả trùng mã băm SHA-256 và kích thước file theo khóa `${item.file.sha256}:${item.file.size}` thành một đối tượng `GroupedResult`.  
Lợi ích cho người dùng:
1. Giao diện hiển thị gọn gàng: Mỗi file duy nhất chỉ chiếm đúng một hàng trong bảng kết quả.
2. Hiển thị danh sách các nguồn sở hữu (Sources): Người dùng có thể xem có bao nhiêu người đang giữ file này, và có quyền chọn tải từ peer có kết nối `Direct` trực tiếp tốc độ cao thay vì node phải đi vòng qua relay `TURN`.

---

## Tóm tắt & Lời khuyên trước khi bảo vệ vấn đáp

1. **Nắm chắc ranh giới bảo mật**: Luôn nhấn mạnh sự tách biệt giữa 3 tiến trình, vai trò của `contextBridge` và bộ lọc 4 tầng của `validateSender`.
2. **Hiểu rõ bản chất toán học**: Nắm vững công thức băm SHA-256 kết hợp giữa `peerId` và `supernodeId` trong thuật toán HRW và lý do tại sao nó vượt trội hơn Consistent Hash Ring về tính tối thiểu xáo trộn.
3. **Giải thích được cơ chế chống tràn bộ nhớ**: Nhớ các con số quan trọng: chunk 16 KiB, ACK 256 KiB, trần đệm 512 KiB, thời hạn thuê 6000ms và bộ giới hạn 60 token của máy chủ Signaling.
4. Tự tin mở bảng tra cứu mã nguồn ở Mục 3 để dẫn chứng trực tiếp file và hàm khi ban giám khảo yêu cầu kiểm tra code thực tế!
