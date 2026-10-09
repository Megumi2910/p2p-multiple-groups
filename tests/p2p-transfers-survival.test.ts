import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createSignalingServer } from '../services/signaling/server.ts'
import { createPeerEngine, type PeerEngine } from '../src/main/p2p/engine.ts'
import type { P2pState } from '../src/shared/p2p.ts'

function waitForState(
  engine: PeerEngine,
  predicate: (state: P2pState) => boolean,
  timeoutMs = 25000,
  rejectPredicate?: (state: P2pState) => string | null
): Promise<P2pState> {
  const { promise, resolve, reject } = Promise.withResolvers<P2pState>()
  let done = false
  // Real-time safety deadline: bounding asynchronous peer engine events across WebRTC network
  const timer = setTimeout(() => {
    if (!done) {
      done = true
      unsub()
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for peer state condition`))
    }
  }, timeoutMs)

  const check = (s: P2pState) => {
    if (done) return
    if (rejectPredicate) {
      const err = rejectPredicate(s)
      if (err) {
        done = true
        clearTimeout(timer)
        unsub()
        reject(new Error(err))
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

describe('Peer Transfer Survival Across Supernode Failure', () => {
  let tempDirs: string[] = []

  beforeEach(() => {
    tempDirs = []
  })

  afterEach(async () => {
    for (const d of tempDirs) {
      await rm(d, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('preserves active transfer between ordinary peers when supernode dies', async () => {
    const roomId = `room-${randomUUID().slice(0, 8)}`
    const token = Buffer.alloc(32, 14).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      roomId,
      token
    })

    const signalUrl = `ws://127.0.0.1:${server.address.port}/signal`

    async function createEngine(name: string, supernodeEligible: boolean): Promise<PeerEngine> {
      const dir = await mkdtemp(join(tmpdir(), `kazaa-surv-${name}-`))
      tempDirs.push(dir)
      const engine = await createPeerEngine({ dataDirectory: dir })
      await engine.connect({
        signalingUrl: signalUrl,
        roomId,
        token,
        displayName: name,
        supernodeEligible,
        relayOnly: false
      })
      return engine
    }

    let sn1: PeerEngine | null = null
    let sn2: PeerEngine | null = null
    let uploader: PeerEngine | null = null
    let downloader: PeerEngine | null = null

    try {
      sn1 = await createEngine('SN1', true)
      sn2 = await createEngine('SN2', true)
      uploader = await createEngine('Uploader', false)
      downloader = await createEngine('Downloader', false)

      function waitForPeers(engine: PeerEngine, count: number): Promise<P2pState> {
        return waitForState(engine, (s) => s.network.members.length === count, 25000)
      }

      await Promise.all([
        waitForPeers(sn1, 4),
        waitForPeers(sn2, 4),
        waitForPeers(uploader, 4),
        waitForPeers(downloader, 4)
      ])

      // Prepare large file (256 KiB) on uploader
      const upDir = await mkdtemp(join(tmpdir(), 'up-surv-'))
      tempDirs.push(upDir)
      const payload = Buffer.alloc(256 * 1024, 77)
      const filePath = join(upDir, 'bigfile.dat')
      await writeFile(filePath, payload)

      const ack = waitForState(
        uploader,
        (state) =>
          state.library.acknowledgedGeneration !== null &&
          state.library.acknowledgedGeneration === state.library.advertisedGeneration &&
          state.library.files.length === 1 &&
          state.library.files[0].status === 'shared',
        25000,
        (s) => {
          const errFile = s.library.files.find((f) => f.status === 'error' || f.status === 'unavailable')
          return errFile ? `File error: ${errFile.name} (${errFile.message})` : null
        }
      )
      await uploader.addFiles([filePath])
      await ack

      // Downloader searches
      const searchDone = waitForState(
        downloader,
        (state) => state.search.status === 'complete' && state.search.results.some((r) => r.file.name === 'bigfile.dat'),
        25000
      )
      await downloader.search('bigfile')
      await searchDone

      const fileResult = downloader.getState().search.results.find((r) => r.file.name === 'bigfile.dat')!
      assert.ok(fileResult)

      const dlDir = await mkdtemp(join(tmpdir(), 'dl-surv-'))
      tempDirs.push(dlDir)
      const destPath = join(dlDir, 'downloaded_bigfile.dat')

      // Start transfer and observe that bytes have started transferring
      const transferStarted = waitForState(
        downloader,
        (state) => {
          const t = state.transfers.find((x) => x.fileName === 'downloaded_bigfile.dat' || x.fileName === 'bigfile.dat')
          return Boolean(t && t.transferredBytes > 0)
        },
        25000
      )

      const transferDone = waitForState(
        downloader,
        (state) => {
          const t = state.transfers.find((x) => x.fileName === 'downloaded_bigfile.dat' || x.fileName === 'bigfile.dat')
          return t?.state === 'completed'
        },
        120000,
        (state) => {
          const t = state.transfers.find((x) => x.fileName === 'downloaded_bigfile.dat' || x.fileName === 'bigfile.dat')
          return t?.state === 'failed' ? `Transfer failed: ${t.message}` : null
        }
      )

      await downloader.download(fileResult.resultId, destPath)
      await transferStarted

      // Kill SN1 while transfer is in flight
      await sn1.dispose()
      sn1 = null

      // Await transfer completion between surviving endpoints
      await transferDone

      const savedBytes = await readFile(destPath)
      assert.equal(savedBytes.length, payload.length)
      const savedHash = createHash('sha256').update(savedBytes).digest('hex')
      assert.equal(savedHash, fileResult.file.sha256)
    } finally {
      if (sn1) await sn1.dispose()
      if (sn2) await sn2.dispose()
      if (uploader) await uploader.dispose()
      if (downloader) await downloader.dispose()
      await server.close()
    }
  })
})
