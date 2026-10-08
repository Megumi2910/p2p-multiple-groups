import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createSignalingServer } from '../services/signaling/server.ts'
import { createPeerEngine, type PeerEngine } from '../src/main/p2p/engine.ts'

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

      function waitForPeers(engine: PeerEngine, count: number): Promise<void> {
        const { promise, resolve } = Promise.withResolvers<void>()
        let done = false
        const unsub = engine.subscribe((s) => {
          if (!done && s.network.members.length === count) {
            done = true
            unsub()
            resolve()
          }
        })
        if (engine.getState().network.members.length === count) {
          done = true
          unsub()
          resolve()
        }
        return promise
      }

      await Promise.all([
        waitForPeers(sn1, 4),
        waitForPeers(sn2, 4),
        waitForPeers(uploader, 4),
        waitForPeers(downloader, 4)
      ])

      // Prepare large file (1 MiB) on uploader
      const upDir = await mkdtemp(join(tmpdir(), 'up-surv-'))
      tempDirs.push(upDir)
      const payload = Buffer.alloc(256 * 1024, 77)
      const filePath = join(upDir, 'bigfile.dat')
      await writeFile(filePath, payload)

      const { promise: ack, resolve: resolveAck } = Promise.withResolvers<void>()
      uploader.subscribe((state) => {
        if (state.library.acknowledgedGeneration === state.library.advertisedGeneration && state.library.files.length === 1) {
          resolveAck()
        }
      })
      await uploader.addFiles([filePath])
      await ack

      // Downloader searches
      const { promise: searchDone, resolve: resolveSearchDone } = Promise.withResolvers<void>()
      const unsubSearch2 = downloader.subscribe((state) => {
        if (state.search.status === 'complete' && state.search.results.some((r) => r.file.name === 'bigfile.dat')) {
          unsubSearch2()
          resolveSearchDone()
        }
      })
      await downloader.search('bigfile')
      await searchDone

      const fileResult = downloader.getState().search.results.find((r) => r.file.name === 'bigfile.dat')!
      assert.ok(fileResult)

      const dlDir = await mkdtemp(join(tmpdir(), 'dl-surv-'))
      tempDirs.push(dlDir)
      const destPath = join(dlDir, 'downloaded_bigfile.dat')

      // Start transfer and observe that bytes have started transferring
      const { promise: transferStarted, resolve: resolveStarted } = Promise.withResolvers<void>()
      const { promise: transferDone, resolve: resolveTransferDone, reject: rejectTransfer } = Promise.withResolvers<void>()

      let startedDone = false
      const unsubSurv = downloader.subscribe((state) => {
        const t = state.transfers.find((x) => x.fileName === 'downloaded_bigfile.dat' || x.fileName === 'bigfile.dat')
        if (t && t.transferredBytes > 0 && !startedDone) {
          startedDone = true
          resolveStarted()
        }
        if (t && t.state === 'completed') {
          unsubSurv()
          resolveTransferDone()
        } else if (t && t.state === 'failed') {
          unsubSurv()
          rejectTransfer(new Error(`Transfer failed: ${t.message}`))
        }
      })
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
