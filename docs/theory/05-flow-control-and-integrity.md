# Theory: Flow Control & Cryptographic Integrity

This document details the sliding-window flow control algorithms, buffer backpressure management, and content-addressable SHA-256 verification pipeline implemented in `src/main/p2p/transfers.ts`.

---

## 1. Flow Control & Congestion Management

WebRTC SCTP data channels provide reliable ordered transmission, but without application-level flow control, fast senders can overwhelm slow receivers, exhaust process heap memory, or trigger socket buffer overflows.

`p2p-multiple-groups` implements a **multi-tiered sliding-window flow control architecture**:

```mermaid
flowchart TD
    subgraph Uploader["Uploader Node"]
        FS["Filesystem ReadStream\n(highWaterMark: 16 KiB)"]
        HWM{"bufferedAmount > 256 KiB?"}
        UNACK{"unackBytes > 512 KiB?"}
        SCTP["SCTP Data Channel Send Buffer"]

        FS --> HWM
        HWM -->|Yes: stream.pause()| PAUSE["Pause Disk Read"]
        HWM -->|No| UNACK
        UNACK -->|Yes: await AckGate| WAIT["Wait for Window ACK"]
        UNACK -->|No| SCTP
    end

    subgraph Receiver["Receiver Node"]
        RECV["SCTP OnMessage Chunk"]
        ACC["Accumulated Bytes Counter"]
        ACK_CHK{"accumulated >= 256 KiB?"}
        SEND_ACK["Send TransferControlMessageV2::ack"]
        DISK["WriteStream to .tmp.<transferId>"]
        HASH["Streaming SHA-256 Digest"]

        RECV --> DISK
        RECV --> HASH
        RECV --> ACC
        ACC --> ACK_CHK
        ACK_CHK -->|Yes| SEND_ACK
        ACK_CHK -->|No| RECV
    end

    SCTP -->|"16 KiB Chunks"| RECV
    SEND_ACK -->|"Ack(acknowledgedBytes)"| UNACK
```

### Protocol Constants

| Parameter | Value | Architectural Purpose |
|---|---|---|
| `CHUNK_SIZE` | $16\text{ KiB}$ ($16,384\text{ B}$) | Aligned with SCTP Maximum Transmission Unit (MTU) to prevent IP fragmentation. |
| `ACK_INTERVAL_BYTES` | $256\text{ KiB}$ ($262,144\text{ B}$) | Cumulative sliding-window acknowledgment frequency; minimizes control channel overhead. |
| `MAX_UNACK_BYTES` | $512\text{ KiB}$ ($524,288\text{ B}$) | Maximum allowed inflight unacknowledged bytes. |
| `HIGH_WATER_BUFFER` | $256\text{ KiB}$ ($262,144\text{ B}$) | SCTP buffer ceiling triggering `stream.pause()`. |
| `LOW_WATER_BUFFER` | $128\text{ KiB}$ ($131,072\text{ B}$) | SCTP buffer floor triggering `stream.resume()` via `onbufferedamountlow`. |
| `STALL_TIMEOUT_MS` | $30,000\text{ ms}$ ($30\text{ s}$) | Watchdog timer detecting stalled or unacknowledged socket streams. |

### The Cumulative Sliding-Window ACK Invariant
Instead of acknowledging every $16\text{ KiB}$ chunk individually (which would cause a $1:1$ message amplification), the receiver accumulates inbound bytes:

$$\text{Emit ACK} \iff \Delta \text{Bytes}_{\text{recv}} \ge 256\text{ KiB}$$

The uploader tracks unacknowledged bytes:
$$\text{UnackBytes} = \text{Bytes}_{\text{sent}} - \text{Bytes}_{\text{acked}}$$
If $\text{UnackBytes} \ge 512\text{ KiB}$, the uploader halts reading from disk until an ACK message arrives from the receiver, strictly bounding maximum inflight memory footprint.

### Double-Tier Buffer Backpressure
To prevent socket buffer bloat:
1. When `channel.bufferedAmount > HIGH_WATER_BUFFER` ($256\text{ KiB}$), the sender pauses the local filesystem stream (`stream.pause()`).
2. When the kernel flushes the SCTP socket buffer down to `LOW_WATER_BUFFER` ($128\text{ KiB}$), Werift fires the `bufferedamountlow` event, resuming filesystem reads (`stream.resume()`).

---

## 2. Cryptographic Integrity & Content Addressability

In untrusted P2P overlays, files must never be identified solely by mutable filenames. `p2p-multiple-groups` establishes content addressability via cryptographic digests:

$$\text{FileID} \implies \text{SHA-256}(\text{FileContents})$$

### On-The-Fly Streaming Verification
During download:
1. Incoming $16\text{ KiB}$ binary chunks are piped simultaneously into the disk staging stream and a Node.js cryptographic hashing stream:
   ```typescript
   hash.update(chunk)
   ```
2. When the uploader dispatches `TransferControlMessageV2::end`, the receiver closes the file and completes the digest:
   $$\text{ComputedDigest} = \text{hash.digest('hex')}$$
3. The receiver compares $\text{ComputedDigest}$ against the catalog advertisement $\text{ExpectedDigest}$ in constant time:
   $$\text{crypto.timingSafeEqual}(\text{ComputedDigest}, \text{ExpectedDigest})$$

### Atomic Publication & Staging Invariants
To prevent partial, truncated, or malicious files from being exposed to the host operating system:
1. **Staging File**: Downloads are written strictly to a hidden temporary file:
   $$\text{Path}_{\text{staging}} = \text{join}(\text{targetDir}, \text{".tmp."} \parallel \text{transferId})$$
2. **Failure Cleanliness**: If the connection breaks, the stall timer fires, or the SHA-256 digest fails verification, the staging file is unlinked immediately via `fs.rm()`.
3. **Atomic Commit**: Only after verification succeeds does the engine atomically rename the staging file to the destination path using `fs.rename()`.
   $$\text{rename}(\text{Path}_{\text{staging}}, \text{Path}_{\text{final}})$$
   In POSIX and Windows filesystems, `rename()` within the same volume is an atomic directory entry swap. External applications never observe a half-written file.
