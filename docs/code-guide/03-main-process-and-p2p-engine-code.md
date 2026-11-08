# Phần 3: Mã Nguồn Tiến Trình Main & Bộ Điều Phối P2P Engine

> **Chuyên mục**: Code Guide & Syntax Deep-Dive  
> **Ngôn ngữ**: Tiếng Việt (Giữ nguyên định danh kỹ thuật, cú pháp và tên file mã nguồn tiếng Anh)  
> **Các module phân tích**: `src/main/index.ts`, `menu.ts`, `theme-store.ts`, `profile-migration.ts`, và toàn bộ `src/main/p2p/*`  

---

## Mục lục nội dung

1. [Tiến trình chính Main Process & An ninh IPC (`#main-entry`)](#main-entry)
   - 1.1. Khởi động, Khóa đơn phiên (Single-Instance Lock) và Di trú profile Kazaa
   - 1.2. Hàm thẩm định nguồn gửi `validateSender`: 4 tầng bảo vệ an ninh
   - 1.3. Điều phối luồng và Trailing Throttle 200ms
   - 1.4. Đăng ký IPC Handlers và Quản lý vòng đời `before-quit`
2. [Bầu chọn Supernode & Băm nhất quán HRW (`#election-module`)](#election-module)
   - 2.1. Thuật toán `electSupernodes`: Thứ tự gia nhập và giải hòa điểm từ điển
   - 2.2. Băm phân tán Rendezvous Hashing (`selectSupernodesForPeer`) với SHA-256
   - 2.3. Vòng đệm lưu trữ sự kiện phục hồi: `RecoveryEventRingBuffer` (100 phần tử)
3. [Lưu trữ đĩa & Mã hóa phần cứng (`#storage-modules`)](#storage-modules)
   - 3.1. Két an toàn `SafeCredentialStore`: Windows DPAPI, macOS Keychain và Chế độ bộ nhớ RAM
   - 3.2. Sổ cái peer `createMultiGroupPeerStore`: Tự động nâng cấp V1 lên V2 và Ghi đĩa nguyên tử (.tmp rename)
4. [Thư viện chia sẻ & Chỉ mục tìm kiếm đảo ngược (`#library-and-search-index`)](#library-and-search-index)
   - 4.1. Bộ quản lý file `LibraryManager`: `statFingerprint` (size, mtimeMs, ino) và Hàng đợi băm song song 2 luồng
   - 4.2. Quản lý chỉ mục Supernode `SupernodeIndexManager`: Hàng đợi ghép danh mục 5 giây và Chuẩn hóa Unicode NFKC
   - 4.3. Theo dõi kết quả tìm kiếm `SearchResultsTracker`: Khử trùng lặp và Hạn mức 200 bản ghi
5. [Client Signaling & Tầng WebRTC gộp kết nối (`#signaling-and-transport`)](#signaling-and-transport)
   - 5.1. Máy khách báo hiệu `SignalingClient`: Quản lý mong muốn (Desired Groups) và Khôi phục kết nối lũy thừa
   - 5.2. Quản lý truyền dẫn `TransportManager`: Gộp 1 kết nối `RTCPeerConnection` cho nhiều nhóm và Giải quyết đụng độ Glare
6. [Chuyển giao file & Điều khiển luồng cửa sổ trượt SCTP (`#transfers-module`)](#transfers-module)
   - 6.1. Máy trạng thái truyền file `TransferManager`: Hạn mức 2 Upload / 2 Download và Watchdog 30 giây
   - 6.2. Vòng lặp phát khối 16 KiB và Thu hồi quyền tức thì giữa chừng (Mid-Transfer Revocation)
   - 6.3. Kiểm soát dòng chảy Backpressure (ACK 256 KiB, Cap 512 KiB) và Cam kết file nguyên tử bằng `link()`
7. [Nhạc trưởng PeerEngine (`#peer-engine`)](#peer-engine)
   - 7.1. Cấu trúc dữ liệu `GroupRuntime` và Hàng đợi chính sách `policyQueue`
   - 7.2. Cân bằng topo nhóm và Bộ giám sát thời hạn hiệu lực 6000ms (`monitorTimer`)

---

<section id="main-entry">

## 1. Tiến trình chính Main Process & An ninh IPC (`src/main/index.ts`)

Tiến trình Main Process sở hữu toàn bộ đặc quyền truy cập hệ điều hành Node.js. Đây là nơi khởi tạo cửa sổ ứng dụng, bảo vệ ranh giới IPC và duy trì hoạt động của mạng P2P.

### 1.1. Khởi động, Khóa đơn phiên và Di trú Profile Kazaa

Khi khởi động, `src/main/index.ts` xử lý việc xác định thư mục dữ liệu qua tham số dòng lệnh `--profile-dir` hoặc biến môi trường `P2P_MULTIPLE_GROUPS_DATA_DIR`.

```typescript
// src/main/index.ts & profile-migration.ts
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
  return
}
```

- **Khóa đơn phiên (`app.requestSingleInstanceLock`)**: Ngăn chặn người dùng mở nhiều cửa sổ ứng dụng cùng trỏ vào một thư mục dữ liệu, tránh hiện tượng đè hỏng file `peer-state.json`.
- **Tự động di trú Profile (`profile-migration.ts`)**: Hàm `findLegacyProfileDirectory` dò tìm thư mục cấu hình của phiên bản cũ (thư mục `Kazaa` hoặc `kazaa`). Nếu phát hiện dữ liệu cũ và thư mục mới chưa tồn tại, hệ thống thực hiện sao chép nguyên tử và đổi tên file trạng thái an toàn.

### 1.2. Hàm thẩm định nguồn gửi `validateSender`: 4 tầng bảo vệ an ninh

Mọi yêu cầu gửi từ giao diện React qua `ipcMain.handle` **bắt buộc** phải đi qua hàm kiểm định `validateSender(event)`:

```typescript
// src/main/index.ts:79-105
function validateSender(event: IpcMainInvokeEvent): void {
  // Tầng 1: Cửa sổ chính phải đang tồn tại và chưa bị hủy
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('Untrusted sender')
  }

  // Tầng 2: WebContents người gửi phải trùng khớp chính xác với mainWindow
  if (event.sender !== mainWindow.webContents) {
    throw new Error('Untrusted sender')
  }

  // Tầng 3: Khung gửi tin phải là Top-Level Frame (parent === null), cấm iframe lồng
  const frame = event.senderFrame
  if (!frame || frame.parent !== null) {
    throw new Error('Untrusted sender')
  }

  // Tầng 4: Kiểm tra nguồn gốc Origin chính xác theo chế độ chạy
  if (isDev) {
    try {
      const parsed = new URL(frame.url)
      // Trong dev: bắt buộc phải là http://127.0.0.1:5173/
      if (parsed.origin !== expectedDevOrigin || parsed.pathname !== '/') {
        throw new Error('Untrusted sender')
      }
    } catch {
      throw new Error('Untrusted sender')
    }
  } else {
    // Trong prod: bắt buộc phải là đường dẫn file HTML tĩnh cục bộ
    if (frame.url !== productionHtmlUrl) {
      throw new Error('Untrusted sender')
    }
  }
}
```

Bốn tầng phòng thủ này loại bỏ 100% nguy cơ tấn công chiếm quyền điều khiển IPC từ các cửa sổ phụ, các thẻ iframe quảng cáo, hoặc các script giả mạo từ bên ngoài.

### 1.3. Điều phối luồng và Trailing Throttle 200ms

Để tránh hiện tượng "bão IPC" (IPC Flooding) khi mạng P2P trao đổi hàng trăm gói tin mỗi giây, hàm `dispatchStateToWindow` gom các cập nhật trạng thái trong khoảng trễ 200ms:

```typescript
// src/main/index.ts:35-51
let stateThrottleTimer: NodeJS.Timeout | null = null
let pendingStateSnapshot: (MultiGroupP2pState & P2pState) | null = null

function dispatchStateToWindow(state: MultiGroupP2pState & P2pState): void {
  pendingStateSnapshot = state
  if (!stateThrottleTimer) {
    stateThrottleTimer = setTimeout(() => {
      stateThrottleTimer = null
      if (pendingStateSnapshot && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.P2P_STATE_CHANGED, pendingStateSnapshot)
        pendingStateSnapshot = null
      }
    }, 200)
  }
}
```

### 1.4. Đăng ký IPC Handlers và Quản lý vòng đời `before-quit`

Trong `registerIpcHandlers()`, các kênh IPC mở hộp thoại native của hệ điều hành:
- `dialog.showOpenDialog`: Cho phép người dùng duyệt và chọn file từ ổ đĩa để chia sẻ vào thư viện.
- `dialog.showSaveDialog`: Chọn vị trí lưu file tải về, kèm hàm lọc tên file an toàn `sanitizeDestinationFileName` để ngăn chặn tấn công Path Traversal.

Khi ứng dụng chuẩn bị thoát (`before-quit`), sự kiện thoát bị chặn lại tạm thời để Engine giải phóng tài nguyên mạng và đóng các kết nối WebRTC:

```typescript
// src/main/index.ts:601-625
app.on('before-quit', (event) => {
  if (isShutdownComplete) return
  event.preventDefault() // Ngăn thoát ngay lập tức
  if (isShuttingDown) return
  isShuttingDown = true

  const performTeardown = async () => {
    try {
      if (peerEngine) {
        // Đặt đồng hồ bảo vệ tối đa 5 giây
        const { promise, resolve } = Promise.withResolvers<void>()
        const timer = setTimeout(resolve, 5000)
        await Promise.race([peerEngine.dispose(), promise])
        clearTimeout(timer)
      }
    } finally {
      isShutdownComplete = true
      app.quit() // Thoát sạch sẽ
    }
  }
  void performTeardown()
})
```

</section>

---

<section id="election-module">

## 2. Bầu chọn Supernode & Băm nhất quán HRW (`src/main/p2p/election.ts`)

Module `election.ts` đảm nhiệm vai trò kiến trúc then chốt nhất của mô hình P2P lai (Hybrid P2P): Bầu chọn các Supernode và phân bổ các Ordinary Peer về các Supernode tương ứng.

### 2.1. Thuật toán `electSupernodes`

Mỗi nhóm bầu chọn tối đa **2 Supernode** làm máy chủ chỉ mục (Index Servers) cho nhóm đó:

```typescript
// src/main/p2p/election.ts:10-24
export function electSupernodes(peers: readonly SignalingRosterPeer[]): ElectionResult {
  // Bước 1: Lọc những peer có khả năng và nguyện vọng làm Supernode (bật cờ supernodeEligible)
  const eligible = peers.filter((p) => p.supernodeEligible)

  // Bước 2: Sắp xếp ưu tiên
  eligible.sort((a, b) => {
    // Tiêu chí 1: Thứ tự gia nhập (joinOrder nhỏ hơn là vào sớm hơn) -> Tối ưu tính ổn định
    if (a.joinOrder !== b.joinOrder) {
      return a.joinOrder - b.joinOrder
    }
    // Tiêu chí 2 (Giải hòa điểm): So sánh thứ tự chuỗi ký tự của peerId
    return a.peerId.localeCompare(b.peerId)
  })

  return {
    electedSupernodes: eligible.slice(0, 2),  // 2 ứng viên đứng đầu trở thành Supernode
    eligibleCandidates: eligible.slice(2)     // Các ứng viên còn lại nằm trong danh sách dự bị
  }
}
```

### 2.2. Băm phân tán Rendezvous Hashing (`selectSupernodesForPeer`) với SHA-256

Sau khi đã có danh sách các Supernode đắc cử, các node bình thường (`ordinary`) cần chọn ra:
- **Primary Supernode**: Nơi node gửi toàn bộ danh mục file chia sẻ và gửi truy vấn tìm kiếm.
- **Standby Supernode**: Nơi dự phòng sẵn sàng thay thế ngay lập tức nếu Primary sập mạng.

Để việc phân bổ đồng đều và tối thiểu hóa hiện tượng xáo trộn mạng khi có biến động (Minimal Churn), hệ thống sử dụng thuật toán **Highest Random Weight (HRW) / Rendezvous Hashing**:

```typescript
// src/main/p2p/election.ts:33-62
export function selectSupernodesForPeer(
  peerId: string,
  electedSupernodes: readonly SignalingRosterPeer[]
): { primary: SignalingRosterPeer | null; standby: SignalingRosterPeer | null } {
  if (electedSupernodes.length === 0) return { primary: null, standby: null }
  if (electedSupernodes.length === 1) return { primary: electedSupernodes[0], standby: null }

  // Tính điểm trọng số băm SHA-256 cho từng cặp (peerId, supernodeId)
  const scored = electedSupernodes.map((s) => {
    const hash = createHash('sha256').update(`${peerId}:${s.peerId}`).digest('hex')
    return { supernode: s, hash }
  })

  // Sắp xếp giảm dần theo giá trị băm hex
  scored.sort((a, b) => {
    if (a.hash !== b.hash) {
      return b.hash.localeCompare(a.hash)
    }
    return b.supernode.peerId.localeCompare(a.supernode.peerId)
  })

  return {
    primary: scored[0].supernode,  // Điểm băm cao nhất làm Primary
    standby: scored[1].supernode   // Điểm băm nhì làm Standby
  }
}
```

**Tại sao HRW lại tối ưu hơn Consistent Hash Ring truyền thống?**  
Khi một Supernode mới tham gia hoặc rời nhóm, chỉ có $O(K/N)$ số lượng peer phải chuyển nhà kết nối, hoàn toàn không xảy ra hiện tượng di dời toàn bộ danh bạ tìm kiếm.

### 2.3. Vòng đệm lưu trữ sự kiện phục hồi: `RecoveryEventRingBuffer`

Class `RecoveryEventRingBuffer` lưu trữ tối đa 100 sự kiện biến động mạng (như thăng cấp Supernode, mất tín hiệu, phân tách nhóm) theo cơ chế hàng đợi tròn (FIFO Ring Buffer) để hiển thị trên bảng chẩn đoán của giao diện:

```typescript
// src/main/p2p/election.ts:91-94
this.events.unshift(event) // Chèn sự kiện mới vào đầu mảng
if (this.events.length > this.capacity) {
  this.events.pop()        // Vứt bỏ sự kiện cũ nhất ở cuối mảng khi vượt quá 100
}
```

</section>

---

<section id="storage-modules">

## 3. Lưu trữ đĩa & Mã hóa phần cứng (`src/main/p2p/credential-store.ts`, `peer-store.ts`)

### 3.1. Két an toàn `SafeCredentialStore`

Token bí mật của các nhóm là dữ liệu nhạy cảm nhất. File `src/main/p2p/credential-store.ts` hiện thực hóa két bảo mật cấp phần cứng:

```typescript
// src/main/p2p/credential-store.ts
export class SafeCredentialStore implements CredentialStore {
  // Ghi file với phân quyền bảo mật 0o600 (chỉ chủ sở hữu hệ điều hành mới có quyền đọc/ghi)
  // Sử dụng electronSafeStorage mã hóa chuỗi token bằng DPAPI trên Windows hoặc Keychain trên macOS
  const encrypted = electronSafeStorage.encryptString(jsonPayload)
  await writeFile(tempPath, encrypted, { mode: 0o600 })
  await rename(tempPath, this.filePath)
```

- **Mã hóa phần cứng**: Sử dụng `safeStorage.encryptString` của Electron. Khóa giải mã được gắn chặt vào tài khoản người dùng đăng nhập Windows/macOS. Kẻ trộm dù có sao chép file `credentials.enc` sang máy khác cũng không thể giải mã.
- **Dự phòng bộ nhớ (Memory Fallback)**: Nếu ứng dụng chạy trên máy chủ Linux headless không có X11 Secret Service, `isEncryptionAvailable()` trả về `false`, hệ thống tự động lưu token tạm thời trong `memoryCache` (RAM) và cảnh báo người dùng.
- **Tuần tự hóa bằng `queueOperation`**: Mọi thao tác đọc/ghi/xóa đều được xếp hàng qua `this.queue` để chống xung đột ghi đĩa.

### 3.2. Sổ cái peer `createMultiGroupPeerStore`

File `src/main/p2p/peer-store.ts` quản lý file cấu hình `peer-state.json`.
- **Tự động sao lưu và nâng cấp V1 lên V2**: Khi phát hiện file trạng thái là định dạng V1 cũ, hàm `migratePeerStateV1` tạo ngay file dự phòng `peer-state.v1.backup.json`, sau đó chuyển đổi dữ liệu thành cấu trúc V2 với mảng `groups: []` độc lập.
- **Ghi đĩa nguyên tử (Atomic Write via .tmp rename)**: Không bao giờ ghi trực tiếp vào `peer-state.json`. Dữ liệu mới được ghi vào `peer-state.json.<uuid>.tmp`, sau đó dùng lệnh `rename()` của hệ điều hành để tráo đổi file tức thì, loại trừ 100% rủi ro mất điện làm hỏng file trắng dung lượng.

</section>

---

<section id="library-and-search-index">

## 4. Thư viện chia sẻ & Chỉ mục tìm kiếm đảo ngược (`src/main/p2p/library.ts`, `search-index.ts`)

### 4.1. Bộ quản lý file `LibraryManager`

`src/main/p2p/library.ts` quản lý toàn bộ các tập tin cục bộ được người dùng chia sẻ:
- **Giới hạn an toàn**: Dung lượng file tối đa 1 GiB (`MAX_FILE_SIZE`), số lượng file chia sẻ tối đa 1,000 file (`MAX_LIBRARY_FILES`).
- **Dấu vân tay siêu tốc (`statFingerprint`)**:
  ```typescript
  // src/main/p2p/library.ts:30-34 & 479-481
  statFingerprint: {
    size: statAfter.size,
    mtimeMs: statAfter.mtimeMs,
    ino: statAfter.ino
  }
  ```
  Khi người dùng bấm "Rescan Library", thay vì đọc và băm lại toàn bộ dữ liệu tốn hàng chục phút, hệ thống chỉ kiểm tra `size` và `mtimeMs`. Nếu các chỉ số này không đổi, mã băm SHA-256 cũ được tái sử dụng ngay lập tức!
- **Hàng đợi băm song song 2 luồng (`MAX_CONCURRENT_HASHING = 2`)**: Chạy tối đa 2 tác vụ băm SHA-256 dưới nền để không làm nghẽn CPU máy tính.
- **Phân quyền nhóm linh hoạt (`groupKeys`)**: Mỗi file có một mảng `groupKeys: []`. Chỉ những nhóm được cấp quyền mới nhìn thấy và tải được file này.
- **Đóng gói danh mục (`getCatalogBatchesForGroup`)**: Chia danh sách file thành từng gói nhỏ tối đa 32 file (`MAX_CATALOG_BATCH_ENTRIES`) và không quá 16 KiB để gửi cho Supernode.

### 4.2. Quản lý chỉ mục Supernode `SupernodeIndexManager`

Khi node được bầu làm Supernode, nó kích hoạt `SupernodeIndexManager` trong `src/main/p2p/search-index.ts`:
- **Ghép luồng danh mục với bộ đệm tạm (Staging Buffer)**: Khi nhận gói `catalog-begin`, Supernode tạo một vùng nhớ đệm với bộ hẹn giờ 5 giây (`CATALOG_STAGING_TTL_MS = 5000`). Nếu node gửi không hoàn tất các gói `catalog-batch` và `catalog-end` trong 5 giây, vùng đệm tự hủy để chống tấn công cạn kiệt RAM.
- **Chuẩn hóa Unicode NFKC & Tìm kiếm AND**:
  ```typescript
  // src/main/p2p/search-index.ts:41-46
  export function matchesQuery(fileName: string, tokens: readonly string[]): boolean {
    if (tokens.length === 0) return false
    const normalizedName = fileName.normalize('NFKC').toLowerCase()
    return tokens.every((token) => normalizedName.includes(token))
  }
  ```
  Chuẩn hóa Unicode NFKC giúp tìm kiếm chính xác các ký tự tiếng Việt có dấu bất kể người dùng gõ theo kiểu dựng sẵn hay tổ hợp.
- **Bộ nhớ đệm câu truy vấn (`MAX_CACHED_QUERIES = 256`)**: Lưu kết quả các câu tìm kiếm phổ biến trong 30 giây để phản hồi tức thì.

### 4.3. Theo dõi kết quả tìm kiếm `SearchResultsTracker`

Node gửi câu hỏi tìm kiếm sẽ nhận các gói tin kết quả `search-results` từ nhiều nguồn gửi về. Class `SearchResultsTracker` khử trùng lặp bản ghi theo khóa `${ownerPeerId}:${fileId}` và giới hạn tối đa 200 kết quả tốt nhất.

</section>

---

<section id="signaling-and-transport">

## 5. Client Signaling & Tầng WebRTC gộp kết nối (`src/main/p2p/signaling-client.ts`, `transport.ts`)

### 5.1. Máy khách báo hiệu `SignalingClient`

`src/main/p2p/signaling-client.ts` duy trì kết nối WebSocket tới máy chủ Signaling:
- **Quản lý trạng thái mong muốn (`desiredGroups`)**: Theo dõi danh sách các nhóm mà Engine muốn gia nhập.
- **Kiểm tra tính đơn điệu (Monotonicity Invariant)**: Khi nhận gói tin `roster`, hàm `handleMessage` so sánh cặp `(epoch, revision)`. Nếu revision mới nhỏ hơn revision hiện tại, gói tin bị hủy bỏ vì xem như dữ liệu đến muộn từ mạng Internet.
- **Tái kết nối lũy thừa (Exponential Backoff)**: Khi rớt mạng, client tự động kết nối lại sau 1s, 2s, 4s, tối đa 30s kèm một lượng nhiễu ngẫu nhiên (Jitter) để tránh gây nghẽn máy chủ.

### 5.2. Quản lý truyền dẫn `TransportManager`

File `src/main/p2p/transport.ts` chịu trách nhiệm thiết lập các kết nối WebRTC ngang hàng thực sự bằng thư viện **Werift** (Node.js pure TypeScript WebRTC):

#### 1. Gộp kết nối (Connection Pooling)
Một nguyên lý thiết kế then chốt: **Giữa hai máy tính bất kỳ chỉ duy trì đúng MỘT đối tượng `RTCPeerConnection` duy nhất**, dù hai máy đó có cùng tham gia 1 nhóm hay 10 nhóm khác nhau!
```typescript
private readonly connections = new Map<string, PeerConnectionRecord>() // remotePeerId -> RTCPeerConnection
```
Tất cả các lệnh điều khiển của mọi nhóm đều được dồn kênh (multiplex) qua một Data Channel duy nhất có tên `p2p-multiple-groups-control-v2`.

#### 2. Thuật toán giải quyết đụng độ lời mời (Glare Resolution)
Khi cả Node A và Node B đồng thời phát hiện ra nhau trên máy chủ Signaling và cùng lúc gửi SDP Offer cho nhau, hiện tượng xung đột Glare xảy ra.
Hệ thống giải quyết đụng độ mang tính tất định (Deterministic Tie-Breaker):
```typescript
// src/main/p2p/transport.ts:318
if (this.localPeerId < remotePeer.peerId) {
  // Peer nào có chuỗi peerId nhỏ hơn theo từ điển sẽ nắm quyền chủ động tạo Offer
  this.createPeerConnection(remotePeer.peerId, remotePeer.sessionId, connectionId, true, chosenGroupId)
} else {
  // Peer có peerId lớn hơn đóng vai trò thụ động chờ nhận Offer từ đối tác
}
```

#### 3. Phân biệt đường đi Direct vs Relay
Khi kênh dữ liệu mở thành công, `TransportManager` kiểm tra cặp ứng viên `selectedCandidatePair`. Nếu loại ứng viên là `relay`, trạng thái đường truyền hiển thị nhãn `Relayed (TURN)` để cảnh báo người dùng tốc độ truyền có thể chậm hơn so với kết nối trực tiếp `Direct`.

</section>

---

<section id="transfers-module">

## 6. Chuyển giao file & Điều khiển luồng cửa sổ trượt SCTP (`src/main/p2p/transfers.ts`)

Module `src/main/p2p/transfers.ts` chứa cỗ máy truyền file nhị phân tốc độ cao với khả năng kiểm soát dòng chảy cực kỳ tinh vi.

### 6.1. Hạn mức đồng thời và Watchdog chống treo

- **Hạn mức tài nguyên**: Tối đa 2 tác vụ tải lên (`MAX_CONCURRENT_UPLOADS = 2`) và 2 tác vụ tải xuống (`MAX_CONCURRENT_DOWNLOADS = 2`).
- **Stall Watchdog (30 giây)**: Nếu một kênh truyền không nhận được bất kỳ khối dữ liệu hay tín hiệu ACK nào trong 30 giây (`STALL_TIMEOUT_MS = 30000`), tác vụ tự động bị hủy để giải phóng băng thông.

### 6.2. Vòng lặp phát khối 16 KiB & Thu hồi quyền tức thì giữa chừng

Khi máy gửi truyền file cho máy nhận, nó cắt file thành các khối nhị phân 16 KiB (`CHUNK_SIZE = 16384`).

<div class="callout callout-warning">
  <div class="callout-icon">⚡</div>
  <div class="callout-content">
    <div class="callout-title">Kiểm tra quyền tức thì trước mỗi chunk 16 KiB</div>
    <p>
      Điểm đặc biệt nhất trong kiến trúc bảo mật của dự án: <strong>Trước khi đọc và bắn từng khối 16 KiB qua mạng</strong>, máy gửi luôn gọi hàm kiểm tra:
      <code>isPeerAuthorized(groupId, remotePeerId, remoteSessionId, fileId)</code>.
    </p>
    <p>
      Nếu trong lúc file 500 MB đang tải được một nửa, chủ sở hữu file vào mục "Library" và bấm bỏ chọn nhóm đó, hàm thẩm định sẽ trả về <code>false</code> ngay lập tức ở chunk tiếp theo! Quá trình truyền file lập tức bị hủy bỏ với thông báo lỗi <code>FORBIDDEN</code>, ngăn chặn đối phương tiếp tục tải phần còn lại của tập tin.
    </p>
  </div>
</div>

### 6.3. Kiểm soát dòng chảy Backpressure và Cam kết file nguyên tử

#### Kiểm soát dòng chảy cửa sổ trượt (Sliding-Window Flow Control)
Để không làm tràn bộ đệm RAM của socket mạng khi tốc độ đọc ổ cứng nhanh hơn tốc độ đường truyền:
1. Máy nhận gửi gói tin tích lũy `ack` sau mỗi **256 KiB** nhận được (`ACK_INTERVAL_BYTES = 256 * 1024`).
2. Máy gửi theo dõi số byte chưa được xác nhận `unacked = offset - lastAckedBytes`.
3. Nếu `unacked >= 512 KiB` (`MAX_UNACK_BYTES`) hoặc bộ đệm dữ liệu của kênh WebRTC vượt ngưỡng `256 KiB` (`HIGH_WATER_BUFFER`), luồng đọc đĩa lập tức tạm dừng (`stream.pause()`).
4. Khi nhận được gói `ack` từ máy nhận, luồng đọc tiếp tục chạy (`stream.resume()`).

#### Cam kết file nguyên tử (Atomic Commit bằng `link()` và `unlink()`)
Khi máy nhận tải xong toàn bộ các khối dữ liệu:
```typescript
// src/main/p2p/transfers.ts:497-511
// 1. Dữ liệu được ghi vào file tạm ẩn: .<filename>.tmp.<transferId>
// 2. Tính mã băm SHA-256 theo luồng song song với quá trình ghi
if (computedSha256 !== expectedSha256) {
  await unlink(session.partPath)
  throw new Error('Integrity check failed')
}

// 3. Cam kết file vào vị trí đích bằng lệnh Hard Link của hệ điều hành
try {
  await link(session.partPath, session.destinationPath)
} catch (linkErr) {
  if (linkErr.code === 'EEXIST') {
    // Nếu tên file đã tồn tại trên máy người dùng, hủy thao tác để bảo vệ dữ liệu cũ!
    throw new Error('DESTINATION_EXISTS')
  }
}
// 4. Xóa file tạm sau khi đã tạo hard link thành công
await unlink(session.partPath)
```

</section>

---

<section id="peer-engine">

## 7. Nhạc trưởng PeerEngine (`src/main/p2p/engine.ts`)

File `src/main/p2p/engine.ts` là module lớn nhất và phức tạp nhất (hơn 1,900 dòng lệnh), đóng vai trò nhạc trưởng kết nối mọi thành phần lại với nhau.

### 7.1. Cấu trúc dữ liệu `GroupRuntime` và `policyQueue`

Mỗi nhóm mà người dùng tham gia được quản lý bởi một đối tượng trạng thái `GroupRuntime`:
- `status`: Trạng thái mạng của nhóm (`disconnected`, `connecting`, `connected`, `recovering`).
- `role`: Vai trò hiện tại của peer trong nhóm (`supernode` hoặc `ordinary`).
- `primaryPeerId` và `standbyPeerId`: Hai Supernode do thuật toán HRW phân bổ.
- `rosterFreshnessTimestamp`: Mốc thời gian ghi nhận bản cập nhật danh sách thành viên mới nhất từ máy chủ Signaling.

Mọi hành động can thiệp vào trạng thái nhóm (tham gia, rời nhóm, chia sẻ file, đổi role) đều được dẫn qua hàm `queueAction<T>`, bảo đảm các thao tác bất đồng bộ được thực hiện tuần tự tuyệt đối mà không gây ra xung đột race condition.

### 7.2. Cân bằng Topo và Giám sát hiệu lực `monitorTimer`

Định kỳ mỗi 2 giây, bộ đếm thời gian `monitorTimer` thực hiện kiểm tra thời hạn hiệu lực của nhóm:

```typescript
// src/main/p2p/engine.ts:1094-1105
const monitorTimer = setInterval(() => {
  if (isDisposed) return
  for (const runtime of groups.values()) {
    if (runtime.isJoined) {
      // Kiểm tra xem dữ liệu từ Signaling Server có bị quá hạn 6000ms hay không
      if (!hasFreshGroupAuthority(runtime)) {
        expireGroupAuthority(runtime)
      }
    }
  }
}, 2000)
monitorTimer.unref() // unref() để timer không ngăn tiến trình Node.js thoát tự nhiên
```

Nếu máy chủ Signaling bị mất điện hoặc đứt cáp mạng, sau **6,000 ms** (`ROSTER_FRESHNESS_LEASE_MS`), quyền quản trị Supernode của node sẽ tự động hết hạn (`expireGroupAuthority`), đưa nhóm vào trạng thái tự phục hồi (Degraded / Recovering), bảo đảm tính toàn vẹn của hệ thống phân tán.

---

## Tóm tắt & Bài học ghi nhớ

1. `validateSender` bảo vệ IPC bằng 4 tầng kiểm tra nghiêm ngặt (Window, WebContents, Frame, Origin).
2. Thuật toán bầu chọn kết hợp `joinOrder` và Rendezvous (HRW) Hashing bằng SHA-256 phân bổ tải tối ưu với mức xáo trộn cực thấp.
3. Két `SafeCredentialStore` tận dụng DPAPI / Keychain phần cứng và quyền `0o600`.
4. `LibraryManager` dùng `statFingerprint` bỏ qua việc băm lại file cũ, giúp khởi động và quét lại thư viện trong tích tắc.
5. Kiểm tra quyền `isPeerAuthorized` trước mỗi khối 16 KiB cho phép thu hồi quyền chia sẻ tức thì ngay giữa chừng chuyến truyền file.
6. Cửa sổ trượt với ACK 256 KiB và bộ đệm trần 512 KiB ngăn ngừa tràn RAM.
7. Đọc tiếp [Phần 4: Giao Diện Người Dùng React Renderer & Bộ Câu Hỏi Vấn Đáp Inquiry Test](04-renderer-ui-and-inquiry-qa.md) để hoàn thiện toàn bộ kiến thức chuẩn bị cho buổi bảo vệ vấn đáp.
