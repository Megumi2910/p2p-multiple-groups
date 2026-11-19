import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createPeerEngine, type PeerEngine } from '../src/main/p2p/engine.ts'
import { sanitizeDestinationFileName } from '../src/main/p2p/transfers.ts'
import type { MultiGroupP2pState, MultiGroupSearchResult } from '../src/shared/p2p.ts'

interface VmStatusResponse {
  ready: boolean
  peerId: string
  sessionId: string | null
  groupKey: string
  groupId: string
  token: string
  signalingUrl: string
  peersConnected: number
  links?: Array<{ peerId: string; state: string; path: string }>
  files: Record<string, { name: string; path: string; size: number; sha256: string }>
  transfers?: Array<{
    id: string
    name: string
    direction: string
    state: string
    transferred: number
    total: number
  }>
}

const VM_HOST = process.env.VM_PEER_HOST || '192.168.123.128'

function waitForState(
  engine: PeerEngine,
  predicate: (state: MultiGroupP2pState) => boolean,
  timeoutMs = 30000,
  rejectPredicate?: (state: MultiGroupP2pState) => string | null,
  label?: string
): Promise<MultiGroupP2pState> {
  const { promise, resolve, reject } = Promise.withResolvers<MultiGroupP2pState>()
  let done = false
  const timer = setTimeout(() => {
    if (!done) {
      done = true
      unsub()
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for: ${label || 'peer state condition'}`))
    }
  }, timeoutMs)

  const check = (s: MultiGroupP2pState) => {
    if (done) return
    if (typeof rejectPredicate === 'function') {
      const err = rejectPredicate(s)
      if (err) {
        done = true
        clearTimeout(timer)
        unsub()
        reject(new Error(`Condition rejected (${label || 'unknown'}): ${err}`))
        return
      }
    }
    if (predicate(s)) {
      done = true
      clearTimeout(timer)
      unsub()
      resolve(s)
    }
  }

  const unsub = engine.subscribe(check)
  check(engine.getState())
  return promise
}

async function fetchVmStatus(): Promise<VmStatusResponse> {
  const res = await fetch(`http://${VM_HOST}:8766/status`)
  if (!res.ok) throw new Error(`HTTP error ${res.status}: ${res.statusText}`)
  return (await res.json()) as VmStatusResponse
}

async function postVm(path: string, body?: unknown): Promise<any> {
  const res = await fetch(`http://${VM_HOST}:8766${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : '{}'
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`VM POST ${path} failed (${res.status}): ${text}`)
  }
  return JSON.parse(text)
}

async function searchFile(
  engine: PeerEngine,
  groupKey: string,
  query: string,
  expectedName: string,
  ownerPeerId?: string,
  minOwnerMatches = 1
): Promise<MultiGroupSearchResult> {
  const prevQueryId = engine.getState().groups.find((x) => x.groupKey === groupKey)?.search.queryId ?? null
  const donePromise = waitForState(
    engine,
    (s) => {
      const g = s.groups.find((x) => x.groupKey === groupKey)
      const matches =
        g?.search.results.filter(
          (r) => r.file.name === expectedName && (!ownerPeerId || r.ownerPeerId === ownerPeerId)
        ) || []
      return (
        g?.search.queryId !== prevQueryId &&
        g?.search.status === 'complete' &&
        matches.length >= minOwnerMatches
      )
    },
    25000,
    undefined,
    `search:${expectedName}`
  )
  const dispatch = await engine.search(groupKey, query)
  assert.equal(dispatch.ok, true, `Search failed for ${query}: ${!dispatch.ok ? dispatch.message : ''}`)
  await donePromise

  const results = engine.getState().groups.find((x) => x.groupKey === groupKey)?.search.results || []
  const found = results.find((r) => r.file.name === expectedName && (!ownerPeerId || r.ownerPeerId === ownerPeerId))
  assert.ok(found, `Expected search result ${expectedName}`)
  return found
}

async function startTrackedDownload(
  engine: PeerEngine,
  groupKey: string,
  resultId: string,
  destPath: string,
  fileName: string
): Promise<string> {
  const beforeIds = new Set(engine.getState().transfers.map((t) => t.id))
  const idPromise = waitForState(
    engine,
    (s) => s.transfers.some((t) => !beforeIds.has(t.id) && t.direction === 'download' && t.fileName === fileName),
    10000,
    undefined,
    `track-start:${fileName}`
  )
  const dlRes = await engine.download(groupKey, resultId, destPath)
  assert.equal(dlRes.ok, true, `Download failed to start for ${fileName}: ${!dlRes.ok ? dlRes.message : ''}`)
  const st = await idPromise
  const created = st.transfers.find((t) => !beforeIds.has(t.id) && t.direction === 'download' && t.fileName === fileName)!
  return created.id
}

async function waitForTransferCompletion(
  engine: PeerEngine,
  transferId: string,
  destPath: string,
  expectedSize: number,
  expectedSha256: string,
  timeoutMs = 60000
): Promise<void> {
  await waitForState(
    engine,
    (s) => s.transfers.find((t) => t.id === transferId)?.state === 'completed',
    timeoutMs,
    (s) => {
      const t = s.transfers.find((x) => x.id === transferId)
      return t?.state === 'failed' ? `Transfer ${transferId} failed: ${t.message}` : null
    },
    `complete:${transferId.slice(0, 8)}`
  )

  const bytes = await readFile(destPath)
  assert.equal(bytes.length, expectedSize, `Size mismatch at ${destPath}: expected ${expectedSize}, got ${bytes.length}`)
  const sha = createHash('sha256').update(bytes).digest('hex')
  assert.equal(sha, expectedSha256, `SHA-256 mismatch at ${destPath}`)

  const partPath = join(destPath, '..', `.p2p-multiple-groups-${transferId}.part`)
  await assert.rejects(async () => stat(partPath), (err: NodeJS.ErrnoException) => err.code === 'ENOENT')
}

async function waitForVmTransferSettled(transferId: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const st = await fetchVmStatus()
    const t = st.transfers?.find((x) => x.id === transferId)
    if (!t || t.state === 'failed' || t.state === 'completed' || t.state === 'cancelled') {
      return
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Timeout waiting for VM transfer ${transferId} to settle`)
}

async function main() {
  console.log('=================================================================')
  console.log('  CROSS-OS EDGE-CASE SUITE (Windows <-> Ubuntu Linux VM)')
  console.log('=================================================================\n')

  console.log(`[Setup] Checking Linux VM Peer on http://${VM_HOST}:8766/status...`)
  const vmStatus = await fetchVmStatus()
  console.log(`  -> VM Peer: ${vmStatus.peerId} | Files: ${Object.keys(vmStatus.files).length}`)

  const tempDirs: string[] = []
  const dataDir = await mkdtemp(join(tmpdir(), 'win-p2p-edge-'))
  const seed2DataDir = await mkdtemp(join(tmpdir(), 'win-p2p-seed2-'))
  const dlDir = await mkdtemp(join(tmpdir(), 'win-p2p-dl-'))
  const upDir = await mkdtemp(join(tmpdir(), 'win-p2p-up-'))
  tempDirs.push(dataDir, seed2DataDir, dlDir, upDir)

  let winEngine: PeerEngine | null = null
  let winSeed2: PeerEngine | null = null

  try {
    winEngine = await createPeerEngine({ dataDirectory: dataDir })
    await winEngine.joinGroup({
      invitation: {
        version: 2,
        signalingUrl: vmStatus.signalingUrl,
        groupId: vmStatus.groupId,
        token: vmStatus.token
      },
      displayName: 'WindowsHost-EdgeRunner',
      supernodeEligible: false,
      relayOnly: false,
      rememberInvitation: false
    })

    await waitForState(
      winEngine,
      (s) => s.groups.find((x) => x.groupKey === vmStatus.groupKey)?.network.links.find((l) => l.peerId === vmStatus.peerId)?.state === 'open',
      30000,
      undefined,
      'win-link-open'
    )

    const winId = winEngine.getState().identity.peerId
    let vmLinkOpen = false
    for (let i = 0; i < 20; i++) {
      const st = await fetchVmStatus()
      if (st.links?.some((l) => l.peerId === winId && l.state === 'open')) {
        vmLinkOpen = true
        break
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    assert.ok(vmLinkOpen, 'VM must confirm open link to Windows')
    console.log('  -> Bidirectional WebRTC connection established.\n')

    // ------------------------------------------------------------------
    // TC1: Zero-byte and 1-byte files (Windows <- Linux)
    // ------------------------------------------------------------------
    console.log('[TC1] Zero-byte & 1-byte files (Windows <- Linux)...')
    for (const name of ['file-empty.txt', 'file-1byte.bin']) {
      const info = vmStatus.files[name]
      const res = await searchFile(winEngine, vmStatus.groupKey, name.slice(0, 8), name)
      const dest = join(dlDir, name)
      const tid = await startTrackedDownload(winEngine, vmStatus.groupKey, res.resultId, dest, name)
      await waitForTransferCompletion(winEngine, tid, dest, info.size, info.sha256)
    }
    console.log('  -> PASS: 0-byte and 1-byte transfers verified.\n')

    // ------------------------------------------------------------------
    // TC2: Odd-sized non-chunk-aligned file + DESTINATION_EXISTS
    // ------------------------------------------------------------------
    console.log('[TC2] Odd-sized file (1,234,567 bytes) + DESTINATION_EXISTS...')
    {
      const info = vmStatus.files['file-odd-size.bin']
      const res = await searchFile(winEngine, vmStatus.groupKey, 'odd-size', info.name)
      const dest = join(dlDir, info.name)
      const tid = await startTrackedDownload(winEngine, vmStatus.groupKey, res.resultId, dest, info.name)
      await waitForTransferCompletion(winEngine, tid, dest, info.size, info.sha256)

      const dupRes = await winEngine.download(vmStatus.groupKey, res.resultId, dest)
      assert.equal(dupRes.ok, false)
      assert.equal(dupRes.code, 'DESTINATION_EXISTS')
    }
    console.log('  -> PASS: Odd-size integrity & DESTINATION_EXISTS verified.\n')

    // ------------------------------------------------------------------
    // TC3: Cross-OS special NTFS characters & Unicode filenames
    // ------------------------------------------------------------------
    console.log('[TC3] Cross-OS NTFS-illegal chars & Unicode filenames (Windows <- Linux)...')
    {
      const illegalName = 'report:2026?.txt'
      const illegalInfo = vmStatus.files[illegalName]
      const illegalRes = await searchFile(winEngine, vmStatus.groupKey, 'report', illegalName)
      const sanitized = sanitizeDestinationFileName(illegalRes.file.name)
      assert.equal(sanitized, 'report_2026_.txt')
      const illegalDest = join(dlDir, sanitized)
      const tid1 = await startTrackedDownload(winEngine, vmStatus.groupKey, illegalRes.resultId, illegalDest, illegalName)
      await waitForTransferCompletion(winEngine, tid1, illegalDest, illegalInfo.size, illegalInfo.sha256)

      const uniName = 'tài liệu kiểm thử (v1).bin'
      const uniInfo = vmStatus.files[uniName]
      const uniRes = await searchFile(winEngine, vmStatus.groupKey, 'kiểm thử', uniName)
      const uniDest = join(dlDir, sanitizeDestinationFileName(uniRes.file.name))
      const tid2 = await startTrackedDownload(winEngine, vmStatus.groupKey, uniRes.resultId, uniDest, uniName)
      await waitForTransferCompletion(winEngine, tid2, uniDest, uniInfo.size, uniInfo.sha256)
    }
    console.log('  -> PASS: NTFS filename sanitization & Unicode transfer verified.\n')

    // ------------------------------------------------------------------
    // TC4: Large 12 MiB sustained SCTP flow control transfer
    // ------------------------------------------------------------------
    console.log('[TC4] Large 12 MiB sustained flow-control transfer (Windows <- Linux)...')
    {
      const info = vmStatus.files['file-large.bin']
      const res = await searchFile(winEngine, vmStatus.groupKey, 'file-large', info.name)
      const dest = join(dlDir, 'file-large-12mb.bin')
      const t0 = Date.now()
      const tid = await startTrackedDownload(winEngine, vmStatus.groupKey, res.resultId, dest, info.name)
      await waitForTransferCompletion(winEngine, tid, dest, info.size, info.sha256, 90000)
      console.log(`  -> PASS: 12 MiB transferred & SHA-256 verified in ${Date.now() - t0}ms.\n`)
    }

    // ------------------------------------------------------------------
    // TC5: Multiple consecutive interruptions + IMMEDIATE resume (0ms sleep)
    // ------------------------------------------------------------------
    console.log('[TC5] Multi-interrupt (2x drops) + IMMEDIATE resume (0ms sleep) on 4 MiB file...')
    {
      const info = vmStatus.files['file-resumable.bin']
      const res = await searchFile(winEngine, vmStatus.groupKey, 'file-resumable', info.name)
      const dest = join(dlDir, 'file-resumable-multi.bin')
      const tid = await startTrackedDownload(winEngine, vmStatus.groupKey, res.resultId, dest, info.name)

      // Drop #1 at >= 512 KiB
      await waitForState(
        winEngine,
        (s) => {
          const t = s.transfers.find((x) => x.id === tid)
          return Boolean(t && t.state === 'transferring' && t.transferredBytes >= 512 * 1024)
        },
        30000,
        undefined,
        'tc5-drop1'
      )
      assert.equal(winEngine.forceCloseTransferChannel(tid), true)
      await waitForState(
        winEngine,
        (s) => {
          const t = s.transfers.find((x) => x.id === tid)
          return t?.state === 'failed' && Boolean(t?.canResume)
        },
        20000,
        undefined,
        'tc5-failed1'
      )
      await waitForVmTransferSettled(tid)

      // Immediate resume #1 (NO artificial 4s sleep!)
      const r1 = await winEngine.resumeTransfer(tid)
      assert.equal(r1.ok, true, `Immediate resume #1 failed: ${!r1.ok ? r1.message : ''}`)

      // Drop #2 at >= 2.2 MiB
      await waitForState(
        winEngine,
        (s) => {
          const t = s.transfers.find((x) => x.id === tid)
          return Boolean(t && t.state === 'transferring' && t.transferredBytes >= 2200 * 1024)
        },
        30000,
        (s) => {
          const t = s.transfers.find((x) => x.id === tid)
          return t?.state === 'failed' ? `Unexpected fail before drop #2: ${t.message}` : null
        },
        'tc5-drop2'
      )
      assert.equal(winEngine.forceCloseTransferChannel(tid), true)
      await waitForState(
        winEngine,
        (s) => {
          const t = s.transfers.find((x) => x.id === tid)
          return t?.state === 'failed' && Boolean(t?.canResume)
        },
        20000,
        undefined,
        'tc5-failed2'
      )
      await waitForVmTransferSettled(tid)

      // Immediate resume #2
      const r2 = await winEngine.resumeTransfer(tid)
      assert.equal(r2.ok, true, `Immediate resume #2 failed: ${!r2.ok ? r2.message : ''}`)

      await waitForTransferCompletion(winEngine, tid, dest, info.size, info.sha256, 60000)
      console.log('  -> PASS: 2 consecutive interruptions + immediate resumes completed with exact SHA-256.\n')
    }

    // ------------------------------------------------------------------
    // TC6: Concurrency Cap (MAX=2, 3rd=BUSY) + Simultaneous Bidirectional
    // ------------------------------------------------------------------
    console.log('[TC6] Concurrency cap (BUSY on 3rd) + Simultaneous Bidirectional transfers...')
    {
      // Prepare Windows 2 MiB file for simultaneous reverse upload
      const winBidirData = randomBytes(2 * 1024 * 1024)
      const winBidirSha = createHash('sha256').update(winBidirData).digest('hex')
      const winBidirPath = join(upDir, 'win-bidir.bin')
      await writeFile(winBidirPath, winBidirData)
      const ackBidir = waitForState(
        winEngine,
        (s) => {
          const g = s.groups.find((x) => x.groupKey === vmStatus.groupKey)
          return (
            g?.catalog.acknowledgedGeneration !== null &&
            g?.catalog.acknowledgedGeneration === g?.catalog.advertisedGeneration &&
            s.library.files.some((f) => f.name === 'win-bidir.bin' && f.status === 'shared')
          )
        },
        25000,
        undefined,
        'bidir-ack'
      )
      await winEngine.addFiles(vmStatus.groupKey, [winBidirPath])
      await ackBidir

      const infoLarge = vmStatus.files['file-large.bin']
      const infoResum = vmStatus.files['file-resumable.bin']
      const infoComplete = vmStatus.files['file-complete.bin']
      await searchFile(winEngine, vmStatus.groupKey, 'file-', infoLarge.name)
      const allRes = winEngine.getState().groups.find((x) => x.groupKey === vmStatus.groupKey)?.search.results || []
      const resLarge = allRes.find((r) => r.file.name === infoLarge.name)!
      const resResum = allRes.find((r) => r.file.name === infoResum.name)!
      const resComplete = allRes.find((r) => r.file.name === infoComplete.name)!
      assert.ok(resLarge && resResum && resComplete, 'Must find all 3 files in single search')

      const destA = join(dlDir, 'conc-large.bin')
      const destB = join(dlDir, 'conc-resum.bin')
      const destC = join(dlDir, 'conc-busy.bin')

      const tidA = await startTrackedDownload(winEngine, vmStatus.groupKey, resLarge.resultId, destA, infoLarge.name)
      const tidB = await startTrackedDownload(winEngine, vmStatus.groupKey, resResum.resultId, destB, infoResum.name)

      // 3rd simultaneous download must reject with BUSY
      const busyRes = await winEngine.download(vmStatus.groupKey, resComplete.resultId, destC)
      assert.equal(busyRes.ok, false)
      assert.equal(busyRes.code, 'BUSY')

      // Trigger Linux <- Windows download AT THE SAME TIME!
      const revPromise = postVm('/reverse-download', { fileName: 'win-bidir.bin' })

      await Promise.all([
        waitForTransferCompletion(winEngine, tidA, destA, infoLarge.size, infoLarge.sha256, 90000),
        waitForTransferCompletion(winEngine, tidB, destB, infoResum.size, infoResum.sha256, 90000),
        revPromise.then((revJson) => {
          assert.equal(revJson.ok, true)
          assert.equal(revJson.size, winBidirData.length)
          assert.equal(revJson.sha256, winBidirSha)
        })
      ])
      console.log('  -> PASS: Concurrency cap (BUSY) & full-duplex bidirectional multiplexing verified.\n')
    }

    // ------------------------------------------------------------------
    // TC7: Cancel active & failed resumable transfers (.part cleanup)
    // ------------------------------------------------------------------
    console.log('[TC7] Cancel active & failed resumable transfers (.part cleanup)...')
    {
      const info = vmStatus.files['file-cancel.bin']
      const res = await searchFile(winEngine, vmStatus.groupKey, 'file-cancel', info.name)

      // 7a: Interrupt then cancel failed resumable transfer
      const dest1 = join(dlDir, 'cancel-failed.bin')
      const tid1 = await startTrackedDownload(winEngine, vmStatus.groupKey, res.resultId, dest1, info.name)
      await waitForState(
        winEngine,
        (s) => {
          const t = s.transfers.find((x) => x.id === tid1)
          return Boolean(t && t.state === 'transferring' && t.transferredBytes >= 256 * 1024)
        },
        25000,
        undefined,
        'tc7a-progress'
      )
      winEngine.forceCloseTransferChannel(tid1)
      await waitForState(
        winEngine,
        (s) => {
          const t = s.transfers.find((x) => x.id === tid1)
          return t?.state === 'failed' && Boolean(t?.canResume)
        },
        20000,
        undefined,
        'tc7a-failed'
      )
      const part1 = join(dlDir, `.p2p-multiple-groups-${tid1}.part`)
      assert.ok((await stat(part1)).size > 0)
      await winEngine.cancelTransfer(tid1)
      await assert.rejects(async () => stat(part1), (e: NodeJS.ErrnoException) => e.code === 'ENOENT')
      const resumeAfterCancel = await winEngine.resumeTransfer(tid1)
      assert.equal(resumeAfterCancel.ok, false)
      assert.equal(resumeAfterCancel.code, 'NOT_FOUND')

      // 7b: Cancel while actively transferring
      const dest2 = join(dlDir, 'cancel-active.bin')
      const tid2 = await startTrackedDownload(winEngine, vmStatus.groupKey, res.resultId, dest2, info.name)
      await waitForState(
        winEngine,
        (s) => {
          const t = s.transfers.find((x) => x.id === tid2)
          return Boolean(t && t.state === 'transferring' && t.transferredBytes >= 128 * 1024)
        },
        25000,
        undefined,
        'tc7b-progress'
      )
      await winEngine.cancelTransfer(tid2)
      await waitForState(
        winEngine,
        (s) => s.transfers.find((x) => x.id === tid2)?.state === 'cancelled',
        15000,
        undefined,
        'tc7b-cancelled'
      )
      await waitForVmTransferSettled(tid2)
      const part2 = join(dlDir, `.p2p-multiple-groups-${tid2}.part`)
      await assert.rejects(async () => stat(part2), (e: NodeJS.ErrnoException) => e.code === 'ENOENT')
      console.log('  -> PASS: Active and failed-resumable cancel cleanup verified.\n')
    }

    // ------------------------------------------------------------------
    // TC8: File modified on disk (FILE_CHANGED)
    // ------------------------------------------------------------------
    console.log('[TC8] File modified on disk after indexing (FILE_CHANGED)...')
    {
      const info = vmStatus.files['file-mutable.bin']
      const res = await searchFile(winEngine, vmStatus.groupKey, 'file-mutable', info.name)
      await postVm('/modify-file', { name: info.name })

      const dest = join(dlDir, 'mutable-should-fail.bin')
      const tid = await startTrackedDownload(winEngine, vmStatus.groupKey, res.resultId, dest, info.name)
      const failedSt = await waitForState(
        winEngine,
        (s) => s.transfers.find((x) => x.id === tid)?.state === 'failed',
        20000,
        undefined,
        'tc8-failed'
      )
      const failedT = failedSt.transfers.find((x) => x.id === tid)!
      assert.ok(failedT.message?.includes('FILE_CHANGED'), `Expected FILE_CHANGED rejection, got: ${failedT.message}`)
      await assert.rejects(async () => stat(dest), (e: NodeJS.ErrnoException) => e.code === 'ENOENT')
      console.log(`  -> PASS: Rejected cleanly with "${failedT.message}".\n`)
    }

    // ------------------------------------------------------------------
    // TC9: Cross-OS Multi-Host Failover (Linux VM unshares -> Windows Seed2)
    // ------------------------------------------------------------------
    console.log('[TC9] Cross-OS Multi-Host Failover (Linux VM unshares -> Windows Seed2)...')
    {
      const info = vmStatus.files['file-failover.bin']
      // First download full copy to winSeed2's folder so both Linux VM and Windows Seed2 have identical SHA-256!
      const resForSeed = await searchFile(winEngine, vmStatus.groupKey, 'file-failover', info.name, vmStatus.peerId)
      const seedFilePath = join(upDir, 'file-failover.bin')
      const seedPrepTid = await startTrackedDownload(winEngine, vmStatus.groupKey, resForSeed.resultId, seedFilePath, info.name)
      await waitForTransferCompletion(winEngine, seedPrepTid, seedFilePath, info.size, info.sha256)

      // Launch winSeed2
      winSeed2 = await createPeerEngine({ dataDirectory: seed2DataDir })
      await winSeed2.joinGroup({
        invitation: {
          version: 2,
          signalingUrl: vmStatus.signalingUrl,
          groupId: vmStatus.groupId,
          token: vmStatus.token
        },
        displayName: 'Windows-Seed2',
        supernodeEligible: false,
        relayOnly: false,
        rememberInvitation: false
      })
      await waitForState(
        winSeed2,
        (s) => s.groups[0]?.network.links.some((l) => l.peerId === vmStatus.peerId && l.state === 'open') ?? false,
        25000,
        undefined,
        'seed2-link-open'
      )
      const seed2Ack = waitForState(
        winSeed2,
        (s) =>
          s.groups[0]?.catalog.acknowledgedGeneration !== null &&
          s.groups[0]?.catalog.acknowledgedGeneration === s.groups[0]?.catalog.advertisedGeneration &&
          s.library.files.some((f) => f.name === 'file-failover.bin' && f.status === 'shared'),
        25000,
        undefined,
        'seed2-ack'
      )
      await winSeed2.addFiles(vmStatus.groupKey, [seedFilePath])
      await seed2Ack

      const seed2Id = winSeed2.getState().identity.peerId
      await waitForState(
        winEngine,
        (s) => (s.groups[0]?.network.members.length || 0) === 3 && Boolean(s.groups[0]?.network.links.some((l) => l.peerId === seed2Id && l.state === 'open')),
        25000,
        undefined,
        'win-sees-seed2'
      )

      // Search & verify both Linux VM and Windows-Seed2 are indexed, then download from Linux VM
      await searchFile(winEngine, vmStatus.groupKey, 'file-failover', info.name, undefined, 2)
      const failoverResults = winEngine.getState().groups.find((x) => x.groupKey === vmStatus.groupKey)?.search.results || []
      const resFromLinux = failoverResults.find((r) => r.file.name === info.name && r.ownerPeerId === vmStatus.peerId)!
      assert.ok(resFromLinux, 'Linux VM result must be present')
      const destFailover = join(dlDir, 'failover-final.bin')
      const failoverTid = await startTrackedDownload(winEngine, vmStatus.groupKey, resFromLinux.resultId, destFailover, info.name)

      await waitForState(
        winEngine,
        (s) => {
          const t = s.transfers.find((x) => x.id === failoverTid)
          return Boolean(t && t.state === 'transferring' && t.transferredBytes >= 256 * 1024)
        },
        25000,
        undefined,
        'tc9-partial'
      )
      winEngine.forceCloseTransferChannel(failoverTid)
      await waitForState(
        winEngine,
        (s) => {
          const t = s.transfers.find((x) => x.id === failoverTid)
          return t?.state === 'failed' && Boolean(t?.canResume)
        },
        20000,
        undefined,
        'tc9-failed'
      )
      await waitForVmTransferSettled(failoverTid)

      // Linux VM unshares file-failover.bin while staying online
      await postVm('/unshare', { name: info.name })

      // Ordinary peer does not hold supernode index: 1st resume detects rejection from Linux VM,
      // records lastRejectedByPeerId, and preserves .part; 2nd resume fails over to Windows-Seed2.
      const firstAttempt = await winEngine.resumeTransfer(failoverTid)
      assert.equal(firstAttempt.ok, true)
      const rejectedSt = await waitForState(
        winEngine,
        (s) => {
          const t = s.transfers.find((x) => x.id === failoverTid)
          if (t?.state === 'failed') {
            console.log(`  -> [TC9] 1st resume state: state=${t.state}, canResume=${t.canResume}, msg=${t.message}`)
          }
          return t?.state === 'failed' && Boolean(t?.canResume)
        },
        20000,
        undefined,
        'tc9-rejected-by-unshared-linux'
      )
      assert.ok(rejectedSt.transfers.find((x) => x.id === failoverTid)?.canResume)

      const failoverResume = await winEngine.resumeTransfer(failoverTid)
      assert.equal(failoverResume.ok, true, `Failover resume failed: ${!failoverResume.ok ? failoverResume.message : ''}`)
      await waitForTransferCompletion(winEngine, failoverTid, destFailover, info.size, info.sha256, 60000)

      const completedTransfer = winEngine.getState().transfers.find((t) => t.id === failoverTid)!
      assert.equal(completedTransfer.peerId, seed2Id, 'Resumed failover transfer must complete from Windows-Seed2')

      await winSeed2.dispose()
      winSeed2 = null
      console.log('  -> PASS: Failover from Linux VM (unshared) to Windows-Seed2 verified.\n')
    }

    // ------------------------------------------------------------------
    // TC10: Reverse Transfers & Reverse Interruption + Resume (Linux <- Windows)
    // ------------------------------------------------------------------
    console.log('[TC10] Reverse Transfers & Reverse Interruption + Resume (Linux <- Windows)...')
    {
      const revSpecs = [
        { name: 'win-empty.txt', data: Buffer.alloc(0) },
        { name: 'win-odd.bin', data: randomBytes(987654) },
        { name: 'win-tài-liệu.bin', data: randomBytes(256 * 1024) },
        { name: 'win-resumable.bin', data: randomBytes(4 * 1024 * 1024) }
      ]
      const revMeta = new Map<string, { size: number; sha256: string }>()
      const paths: string[] = []
      for (const s of revSpecs) {
        const p = join(upDir, s.name)
        await writeFile(p, s.data)
        revMeta.set(s.name, { size: s.data.length, sha256: createHash('sha256').update(s.data).digest('hex') })
        paths.push(p)
      }

      const ackRev = waitForState(
        winEngine,
        (s) => {
          const g = s.groups.find((x) => x.groupKey === vmStatus.groupKey)
          return (
            g?.catalog.acknowledgedGeneration !== null &&
            g?.catalog.acknowledgedGeneration === g?.catalog.advertisedGeneration &&
            revSpecs.every((sp) => s.library.files.some((f) => f.name === sp.name && f.status === 'shared'))
          )
        },
        25000,
        undefined,
        'rev-files-ack'
      )
      await winEngine.addFiles(vmStatus.groupKey, paths)
      await ackRev

      for (const name of ['win-empty.txt', 'win-odd.bin', 'win-tài-liệu.bin']) {
        const m = revMeta.get(name)!
        const out = await postVm('/reverse-download', { fileName: name })
        assert.equal(out.ok, true)
        assert.equal(out.size, m.size)
        assert.equal(out.sha256, m.sha256)
      }

      const resumMeta = revMeta.get('win-resumable.bin')!
      const resumOut = await postVm('/reverse-download', {
        fileName: 'win-resumable.bin',
        interruptAtBytes: 512 * 1024,
        resumeAfterInterrupt: true
      })
      assert.equal(resumOut.ok, true)
      assert.ok(resumOut.interruptedBytes >= 512 * 1024)
      assert.equal(resumOut.size, resumMeta.size)
      assert.equal(resumOut.sha256, resumMeta.sha256)
      console.log(`  -> PASS: Reverse 0B, odd-size, Unicode, and interrupted/resumed 4 MiB verified (interrupted at ${resumOut.interruptedBytes}B).\n`)
    }

    // ------------------------------------------------------------------
    // TC11: Peer Leave & Rejoin (new sessionId) -> Resume Across Sessions
    // ------------------------------------------------------------------
    console.log('[TC11] Peer Leave & Rejoin (new sessionId) -> Resume Across Sessions (Windows <- Linux)...')
    {
      const info = vmStatus.files['file-large.bin']
      const res = await searchFile(winEngine, vmStatus.groupKey, 'file-large', info.name, vmStatus.peerId)
      const dest = join(dlDir, 'leave-rejoin-12mb.bin')
      const tid = await startTrackedDownload(winEngine, vmStatus.groupKey, res.resultId, dest, info.name)

      await waitForState(
        winEngine,
        (s) => {
          const t = s.transfers.find((x) => x.id === tid)
          return Boolean(t && t.state === 'transferring' && t.transferredBytes >= 1024 * 1024)
        },
        30000,
        undefined,
        'tc11-1mb-progress'
      )

      const leaveRejoinPromise = postVm('/leave-rejoin', { delayMs: 800 })

      await waitForState(
        winEngine,
        (s) => {
          const t = s.transfers.find((x) => x.id === tid)
          return t?.state === 'failed' && Boolean(t?.canResume)
        },
        20000,
        undefined,
        'tc11-interrupted-on-leave'
      )

      const rejoinRes = await leaveRejoinPromise
      assert.notEqual(rejoinRes.beforeSession, rejoinRes.afterSession, 'VM peer must obtain a fresh sessionId on rejoin')

      await waitForState(
        winEngine,
        (s) => s.groups.find((x) => x.groupKey === vmStatus.groupKey)?.network.links.find((l) => l.peerId === vmStatus.peerId)?.state === 'open',
        25000,
        undefined,
        'tc11-link-reopened'
      )

      const partStat = await stat(join(dlDir, `.p2p-multiple-groups-${tid}.part`))
      assert.ok(partStat.size >= 1024 * 1024, 'Partial file must be preserved when uploader leaves group')

      const resumeRes = await winEngine.resumeTransfer(tid)
      assert.equal(resumeRes.ok, true, `Resume after rejoin failed: ${!resumeRes.ok ? resumeRes.message : ''}`)
      await waitForTransferCompletion(winEngine, tid, dest, info.size, info.sha256, 90000)
      console.log(`  -> PASS: Resumed across new Linux sessionId (${rejoinRes.beforeSession?.slice(0, 8)} -> ${rejoinRes.afterSession?.slice(0, 8)}) cleanly!\n`)
    }

    console.log('=================================================================')
    console.log('  ALL 11 CROSS-OS EDGE-CASE TESTS PASSED (100% SUCCESS)')
    console.log('=================================================================\n')
  } finally {
    console.log('[CLEANUP] Cleaning up local and remote peers...')
    try {
      await fetch(`http://${VM_HOST}:8766/shutdown`, { method: 'POST' })
      console.log('  -> Remote Linux VM peer shut down cleanly.')
    } catch {
      // Ignored if already shut down
    }
    if (winSeed2) {
      await winSeed2.dispose().catch(() => {})
    }
    if (winEngine) {
      await winEngine.dispose().catch(() => {})
      console.log('  -> Windows engine disposed.')
    }
    for (const d of tempDirs) {
      await rm(d, { recursive: true, force: true }).catch(() => {})
    }
  }
}

main().catch((err) => {
  console.error('\nFATAL TEST ERROR:', err)
  process.exit(1)
})
