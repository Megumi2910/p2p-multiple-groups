import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createPeerEngine, type PeerEngine } from '../src/main/p2p/engine.ts'
import { makeGroupKey, type MultiGroupP2pState } from '../src/shared/p2p.ts'

interface VmStatusResponse {
  ready: boolean
  peerId: string
  groupKey: string
  groupId: string
  token: string
  signalingUrl: string
  peersConnected: number
  files: Record<string, { name: string; path: string; size: number; sha256: string }>
}

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
        reject(new Error(`Condition rejected: ${err}`))
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

const VM_HOST = process.env.VM_PEER_HOST || '192.168.123.128'

async function fetchVmStatus(): Promise<VmStatusResponse> {
  const res = await fetch(`http://${VM_HOST}:8766/status`)
  if (!res.ok) throw new Error(`HTTP error ${res.status}: ${res.statusText}`)
  return (await res.json()) as VmStatusResponse
}

async function main() {
  console.log('=================================================================')
  console.log('  CROSS-OS P2P END-TO-END VERIFICATION (Windows <-> Linux VM)')
  console.log('=================================================================\n')

  // 1. Check VM Peer Status
  console.log(`[1/5] Checking Linux VM Peer Status on http://${VM_HOST}:8766/status...`)
  let vmStatus: VmStatusResponse
  try {
    vmStatus = await fetchVmStatus()
    console.log(`  -> Linux VM Peer online: ${vmStatus.peerId}`)
    console.log(`  -> Group: ${vmStatus.groupId} | Signaling: ${vmStatus.signalingUrl}`)
    console.log(`  -> Available Files on VM:`)
    for (const [k, v] of Object.entries(vmStatus.files)) {
      console.log(`     - ${v.name}: ${v.size} bytes (SHA: ${v.sha256.slice(0, 16)}...)`)
    }
  } catch (err) {
    console.error('  FAIL: Could not connect to Linux VM Peer:', err)
    process.exit(1)
  }

  const tempDirs: string[] = []
  const dataDir = await mkdtemp(join(tmpdir(), 'win-p2p-engine-'))
  const dlDir = await mkdtemp(join(tmpdir(), 'win-p2p-dl-'))
  const upDir = await mkdtemp(join(tmpdir(), 'win-p2p-up-'))
  tempDirs.push(dataDir, dlDir, upDir)

  let winEngine: PeerEngine | null = null

  try {
    // 2. Initialize Windows PeerEngine
    console.log('\n[2/5] Initializing Windows PeerEngine...')
    winEngine = await createPeerEngine({ dataDirectory: dataDir })
    await winEngine.joinGroup({
      invitation: {
        version: 2,
        signalingUrl: vmStatus.signalingUrl,
        groupId: vmStatus.groupId,
        token: vmStatus.token
      },
      displayName: 'WindowsHost-Downloader',
      supernodeEligible: false,
      relayOnly: false,
      rememberInvitation: false
    })

    console.log('  -> Waiting for WebRTC connection to Linux VM Peer...')
    await waitForState(
      winEngine,
      (s) => {
        const g = s.groups.find((x) => x.groupKey === vmStatus.groupKey)
        const link = g?.network.links.find((l) => l.peerId === vmStatus.peerId)
        console.log(`     [Link check] members=${g?.network.members.length ?? 0}, links=${g?.network.links.length ?? 0}, targetLinkState=${link?.state ?? 'none'}, path=${link?.path ?? 'none'}`)
        return link?.state === 'open'
      },
      30000,
      undefined,
      'webrtc-connected-to-linux-peer'
    )
    console.log('  -> PASS: Windows WebRTC data connection established with Linux VM Peer!')

    // Verify bidirectional link readiness on VM side
    console.log('  -> Verifying bidirectional link readiness on Linux VM...')
    let vmLinkOpen = false
    const winId = winEngine.getState().identity.peerId
    for (let i = 0; i < 20; i++) {
      const st = (await fetchVmStatus()) as any
      const l = st.links?.find((x: any) => x.peerId === winId)
      console.log(`     [VM side check] VM links to Windows: state=${l?.state ?? 'none'}`)
      if (l?.state === 'open') {
        vmLinkOpen = true
        break
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    assert.ok(vmLinkOpen, 'Linux VM must also confirm WebRTC link state as open')
    console.log('  -> PASS: Bidirectional WebRTC connection confirmed open on both Windows and Linux!')

    // 3. Test Case 1: Baseline Complete Download (Windows <- Linux)
    console.log('\n[3/5] TEST CASE 1: Full Baseline File Transfer (Windows <- Linux)...')
    const file1Info = vmStatus.files['file-complete.bin']
    assert.ok(file1Info, 'file-complete.bin should exist on VM')

    const winNet = winEngine.getState().groups.find((x) => x.groupKey === vmStatus.groupKey)?.network
    console.log(`  -> Windows Group Network State: role=${winNet?.role}, primaryPeerId=${winNet?.primaryPeerId}, links=${winNet?.links.map(l => `${l.peerId}:${l.state}`).join(', ')}`)

    console.log(`  -> Initiating search for 'file-complete'...`)
    const searchPromise = waitForState(
      winEngine,
      (s) => {
        const g = s.groups.find((x) => x.groupKey === vmStatus.groupKey)
        console.log(`     [Search check] status=${g?.search.status}, results=${g?.search.results.length}, message=${g?.search.message}`)
        return g?.search.status === 'complete' && Boolean(g.search.results.some((r) => r.file.name === file1Info.name))
      },
      25000,
      undefined,
      'search-file-complete'
    )
    const searchRes = await winEngine.search(vmStatus.groupKey, 'file-complete')
    console.log(`  -> Search dispatch result:`, searchRes)
    assert.equal(searchRes.ok, true, `Search initiation failed: ${!searchRes.ok ? searchRes.message : ''}`)
    await searchPromise

    const searchResults = winEngine.getState().groups.find((x) => x.groupKey === vmStatus.groupKey)?.search.results || []
    const file1Result = searchResults.find((r) => r.file.name === file1Info.name)!
    assert.ok(file1Result, 'file-complete search result must exist')

    const file1Dest = join(dlDir, 'file-complete-downloaded.bin')
    console.log(`  -> Downloading ${file1Info.name} (${file1Info.size} bytes) from Linux VM...`)

    const file1Done = waitForState(
      winEngine,
      (s) => {
        const t = s.transfers.find((x) => x.fileName === file1Info.name || x.fileName === 'file-complete-downloaded.bin')
        console.log(`     [File1 Progress] state=${t?.state}, transferred=${t?.transferredBytes}/${t?.size}`)
        return t?.state === 'completed'
      },
      30000,
      (s) => {
        const t = s.transfers.find((x) => x.fileName === file1Info.name || x.fileName === 'file-complete-downloaded.bin')
        return t?.state === 'failed' ? `Transfer failed: ${t.message}` : null
      },
      'file1-download-completed'
    )

    const dlRes = await winEngine.download(vmStatus.groupKey, file1Result.resultId, file1Dest)
    console.log(`  -> winEngine.download response:`, dlRes)
    assert.equal(dlRes.ok, true, `Download failed to initiate: ${!dlRes.ok ? dlRes.message : ''}`)
    await file1Done

    const file1DownloadedBytes = await readFile(file1Dest)
    assert.equal(file1DownloadedBytes.length, file1Info.size, 'File size must match')
    const file1DownloadedSha = createHash('sha256').update(file1DownloadedBytes).digest('hex')
    assert.equal(file1DownloadedSha, file1Info.sha256, 'SHA-256 must match exactly')

    console.log(`  -> PASS: Downloaded ${file1DownloadedBytes.length} bytes cleanly.`)
    console.log(`  -> SHA-256 match verified: ${file1DownloadedSha}`)

    // 4. Test Case 2: Interrupted Transfer & Resumption (Windows <- Linux)
    console.log('\n[4/5] TEST CASE 2: Interruption Simulation & Resumption across OS boundaries...')
    const file2Info = vmStatus.files['file-resumable.bin']
    assert.ok(file2Info, 'file-resumable.bin should exist on VM')

    const search2Promise = waitForState(
      winEngine,
      (s) => {
        const g = s.groups.find((x) => x.groupKey === vmStatus.groupKey)
        return g?.search.status === 'complete' && Boolean(g.search.results.some((r) => r.file.name === file2Info.name))
      },
      25000,
      undefined,
      'search-file-resumable'
    )
    await winEngine.search(vmStatus.groupKey, 'file-resumable')
    await search2Promise

    const file2Results = winEngine.getState().groups.find((x) => x.groupKey === vmStatus.groupKey)?.search.results || []
    const file2Result = file2Results.find((r) => r.file.name === file2Info.name)!
    assert.ok(file2Result, 'file-resumable search result must exist')

    const file2Dest = join(dlDir, 'file-resumable-downloaded.bin')
    let resumableTransferId = ''

    console.log(`  -> Starting 4MB download of ${file2Info.name} from Linux VM...`)
    const progressPromise = waitForState(
      winEngine,
      (s) => {
        const t = s.transfers.find((x) => x.fileName === file2Info.name || x.fileName === 'file-resumable-downloaded.bin')
        if (t && t.transferredBytes >= 512 * 1024 && t.state === 'transferring') {
          resumableTransferId = t.id
          return true
        }
        return false
      },
      30000,
      undefined,
      'file2-partial-progress'
    )

    await winEngine.download(vmStatus.groupKey, file2Result.resultId, file2Dest)
    await progressPromise

    console.log(`  -> Reached partial transfer: ${winEngine.getState().transfers.find((t) => t.id === resumableTransferId)?.transferredBytes} bytes`)
    console.log(`  -> Simulating sudden network drop by closing transfer data channel...`)
    const closed = winEngine.forceCloseTransferChannel(resumableTransferId)
    assert.equal(closed, true, 'Channel should close successfully')

    const failedState = await waitForState(
      winEngine,
      (s) => {
        const t = s.transfers.find((x) => x.id === resumableTransferId)
        return t?.state === 'failed' && Boolean(t?.canResume)
      },
      25000,
      undefined,
      'transfer-failed-with-can-resume'
    )

    const failedTransfer = failedState.transfers.find((x) => x.id === resumableTransferId)!
    console.log(`  -> Transfer transitioned to: ${failedTransfer.state} (canResume: ${failedTransfer.canResume})`)
    assert.ok(failedTransfer.canResume, 'canResume must be true')

    const partFilePath = join(dlDir, `.p2p-multiple-groups-${resumableTransferId}.part`)
    const partStat = await stat(partFilePath)
    console.log(`  -> Verified .part file on Windows disk: ${partStat.size} bytes preserved`)
    assert.ok(partStat.size > 0, '.part file must have nonzero bytes')

    // Wait for Linux VM uploader to detect disconnection and settle
    console.log('  -> Waiting for Linux VM uploader to detect disconnection and settle...')
    let uploaderSettled = false
    for (let i = 0; i < 30; i++) {
      const st = (await fetchVmStatus()) as any
      const t = st.transfers?.find((x: any) => x.id === resumableTransferId)
      console.log(`     [VM Uploader check] transfer state=${t?.state ?? 'none'}`)
      if (!t || t.state === 'failed' || t.state === 'completed' || t.state === 'cancelled') {
        uploaderSettled = true
        break
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    assert.ok(uploaderSettled, 'Linux VM uploader should detect connection closure')

    // Wait 4 seconds for SCTP stream reset to propagate cleanly across VM network
    await new Promise((r) => setTimeout(r, 4000))

    console.log(`  -> Resuming transfer from byte offset ${failedTransfer.transferredBytes}...`)
    const resumeRes = await winEngine.resumeTransfer(resumableTransferId)
    assert.equal(resumeRes.ok, true, 'resumeTransfer must return ok: true')

    const resumedCompletion = waitForState(
      winEngine,
      (s) => {
        const t = s.transfers.find((x) => x.id === resumableTransferId)
        console.log(`     [Resumed Progress] state=${t?.state}, transferred=${t?.transferredBytes}/${t?.size}`)
        return t?.state === 'completed'
      },
      60000,
      (s) => {
        const t = s.transfers.find((x) => x.id === resumableTransferId)
        return t?.state === 'failed' ? `Resumed transfer failed: ${t.message}` : null
      },
      'resumed-transfer-completed'
    )
    await resumedCompletion

    const file2DownloadedBytes = await readFile(file2Dest)
    assert.equal(file2DownloadedBytes.length, file2Info.size, 'Resumed file size must match original 4MB exactly')
    const file2DownloadedSha = createHash('sha256').update(file2DownloadedBytes).digest('hex')
    assert.equal(file2DownloadedSha, file2Info.sha256, 'Resumed file SHA-256 must match original exactly')

    // Verify .part file removed
    await assert.rejects(async () => stat(partFilePath), (err: NodeJS.ErrnoException) => err.code === 'ENOENT')

    console.log(`  -> PASS: Resumed transfer finished successfully: ${file2DownloadedBytes.length} bytes!`)
    console.log(`  -> SHA-256 match verified: ${file2DownloadedSha}`)

    // 5. Test Case 3: Reverse Transfer (Linux VM <- Windows Host)
    console.log('\n[5/5] TEST CASE 3: Reverse Transfer (Linux VM downloads from Windows Host)...')
    const winFileData = randomBytes(1024 * 1024) // 1MB
    const winFileSha = createHash('sha256').update(winFileData).digest('hex')
    const winFilePath = join(upDir, 'windows-reverse.bin')
    await writeFile(winFilePath, winFileData)
    console.log(`  -> Windows host created test file: windows-reverse.bin (1048576 bytes, SHA: ${winFileSha.slice(0, 16)}...)`)

    const uploadAck = waitForState(
      winEngine,
      (s) => {
        const g = s.groups.find((x) => x.groupKey === vmStatus.groupKey)
        return (
          g?.catalog.acknowledgedGeneration !== null &&
          g?.catalog.acknowledgedGeneration === g?.catalog.advertisedGeneration &&
          s.library.files.some((f) => f.name === 'windows-reverse.bin' && f.status === 'shared')
        )
      },
      25000,
      undefined,
      'windows-upload-catalog-ack'
    )

    await winEngine.addFiles(vmStatus.groupKey, [winFilePath])
    await uploadAck
    console.log('  -> Catalog update advertised and acknowledged by Linux VM supernode.')

    console.log('  -> Triggering Linux VM to search and download windows-reverse.bin...')
    const revRes = await fetch(`http://${VM_HOST}:8766/reverse-download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'windows-reverse.bin' })
    })

    if (!revRes.ok) {
      throw new Error(`Reverse download HTTP error: ${revRes.status} ${await revRes.text()}`)
    }
    const revJson = (await revRes.json()) as { ok: boolean; sha256: string; size: number }
    assert.equal(revJson.ok, true, 'Reverse download response must be ok')
    assert.equal(revJson.size, winFileData.length, 'Size on Linux VM must match Windows original')
    assert.equal(revJson.sha256, winFileSha, 'SHA-256 on Linux VM must match Windows original exactly')

    console.log(`  -> PASS: Linux VM successfully downloaded file from Windows host!`)
    console.log(`  -> Linux received size: ${revJson.size} bytes, SHA-256: ${revJson.sha256}`)

    console.log('\n=================================================================')
    console.log('  ALL CROSS-OS TESTS PASSED (100% SUCCESS)')
    console.log('=================================================================\n')
  } finally {
    console.log('[CLEANUP] Cleaning up local and remote peers...')
    try {
      await fetch(`http://${VM_HOST}:8766/shutdown`, { method: 'POST' })
      console.log('  -> Remote Linux VM peer shut down cleanly.')
    } catch {
      // Ignored if already shut down
    }

    if (winEngine) {
      await winEngine.dispose()
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
