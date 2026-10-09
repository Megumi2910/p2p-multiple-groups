import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { sanitizeDestinationFileName } from '../src/main/p2p/transfers.ts'
import { createSignalingServer } from '../services/signaling/server.ts'
import { createPeerEngine, type PeerEngine } from '../src/main/p2p/engine.ts'
import type { P2pState } from '../src/shared/p2p.ts'

describe('File Transfer Safety & Protocols', () => {
  it('sanitizes Windows reserved names, illegal chars, and trailing dots/spaces', () => {
    assert.equal(sanitizeDestinationFileName('CON.txt'), '_CON.txt')
    assert.equal(sanitizeDestinationFileName('aux.mp3'), '_aux.mp3')
    assert.equal(sanitizeDestinationFileName('nul'), '_nul')
    assert.equal(sanitizeDestinationFileName('com1.dat'), '_com1.dat')
    assert.equal(sanitizeDestinationFileName('bad:name*?.txt'), 'bad_name__.txt')
    assert.equal(sanitizeDestinationFileName('trailing.dots...   '), 'trailing.dots')
    assert.equal(sanitizeDestinationFileName('   '), 'download')
  })
})

describe('End-to-End Verified Peer Transfers', () => {
  let tempDirs: string[] = []

  beforeEach(() => {
    tempDirs = []
  })

  afterEach(async () => {
    for (const d of tempDirs) {
      await rm(d, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('transfers binary and zero-byte files with hash verification and atomic publication', async () => {
    const roomId = `room-${randomUUID().slice(0, 8)}`
    const token = Buffer.alloc(32, 13).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      roomId,
      token
    })

    const signalUrl = `ws://127.0.0.1:${server.address.port}/signal`

    async function createEngine(name: string, supernodeEligible: boolean): Promise<PeerEngine> {
      const dir = await mkdtemp(join(tmpdir(), `kazaa-xfer-${name}-`))
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

    let sn: PeerEngine | null = null
    let uploader: PeerEngine | null = null
    let downloader: PeerEngine | null = null

    try {
      sn = await createEngine('SN', true)
      uploader = await createEngine('Uploader', false)
      downloader = await createEngine('Downloader', false)

      function waitForState(
        engine: PeerEngine,
        predicate: (state: P2pState) => boolean,
        timeoutMs = 25000,
        rejectPredicate?: (state: P2pState) => string | null,
        label?: string
      ): Promise<P2pState> {
        const { promise, resolve, reject } = Promise.withResolvers<P2pState>()
        let done = false
        // Real-time safety deadline: bounding asynchronous peer engine events across WebRTC network
        const timer = setTimeout(() => {
          if (!done) {
            done = true
            unsub()
            reject(new Error(`Timeout (${timeoutMs}ms) waiting for: ${label || 'peer state condition'}`))
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

      function waitForPeers(engine: PeerEngine, count: number): Promise<P2pState> {
        return waitForState(engine, (s) => s.network.members.length === count, 25000, undefined, 'peers-count-' + count)
      }

      function waitForLink(engine: PeerEngine, targetPeerId: string): Promise<P2pState> {
        return waitForState(
          engine,
          (s) => s.network.links.some((l) => l.peerId === targetPeerId && l.state === 'open'),
          25000,
          undefined,
          'link-open-' + targetPeerId.slice(0, 8)
        )
      }

      await Promise.all([waitForPeers(sn, 3), waitForPeers(uploader, 3), waitForPeers(downloader, 3)])
      await Promise.all([
        waitForLink(uploader, sn.getState().network.peerId),
        waitForLink(downloader, sn.getState().network.peerId),
        waitForLink(sn, uploader.getState().network.peerId),
        waitForLink(sn, downloader.getState().network.peerId)
      ])
      const upDir = await mkdtemp(join(tmpdir(), 'up-files-'))
      tempDirs.push(upDir)

      const binaryPayload = Buffer.alloc(256 * 1024)
      for (let i = 0; i < binaryPayload.length; i++) {
        binaryPayload[i] = (i * 31) & 0xff
      }
      const binaryPath = join(upDir, 'payload.bin')
      await writeFile(binaryPath, binaryPayload)

      const zeroPath = join(upDir, 'empty.txt')
      await writeFile(zeroPath, Buffer.alloc(0))
      const uploadAck = waitForState(
        uploader,
        (s) =>
          s.library.acknowledgedGeneration !== null &&
          s.library.acknowledgedGeneration === s.library.advertisedGeneration &&
          s.library.files.length === 2 &&
          s.library.files.every((f) => f.status === 'shared'),
        25000,
        (s) => {
          const errFile = s.library.files.find((f) => f.status === 'error' || f.status === 'unavailable')
          return errFile ? `File error: ${errFile.name} (${errFile.message})` : null
        },
        'upload-ack'
      )
      await uploader.addFiles([binaryPath, zeroPath])
      await uploadAck

      // 2. Downloader searches for files
      const searchDone = waitForState(
        downloader,
        (s) => s.search.status === 'complete' && s.search.results.some((r) => r.file.name === 'payload.bin'),
        25000,
        undefined,
        'search-done'
      )
      await downloader.search('payload')
      await searchDone
      const results = downloader.getState().search.results
      const binaryResult = results.find((r) => r.file.name === 'payload.bin')!
      assert.ok(binaryResult)

      // 3. Download binary file (120-second transfer deadline)
      const dlDir = await mkdtemp(join(tmpdir(), 'dl-files-'))
      tempDirs.push(dlDir)
      const dlDest = join(dlDir, 'downloaded.bin')

      const binaryDlDone = waitForState(
        downloader,
        (s) => {
          const transfer = s.transfers.find((t) => t.fileName === 'downloaded.bin' || t.fileName === 'payload.bin')
          return transfer?.state === 'completed'
        },
        120000,
        (s) => {
          const transfer = s.transfers.find((t) => t.fileName === 'downloaded.bin' || t.fileName === 'payload.bin')
          return transfer?.state === 'failed' ? `Transfer failed: ${transfer.message}` : null
        },
        'binary-dl-done'
      )
      await downloader.download(binaryResult.resultId, dlDest)
      await binaryDlDone

      // Verify destination file exists and hash matches
      const downloadedBytes = await readFile(dlDest)
      assert.equal(downloadedBytes.length, binaryPayload.length)
      const dlHash = createHash('sha256').update(downloadedBytes).digest('hex')
      assert.equal(dlHash, binaryResult.file.sha256)

      // Verify .part file removed
      const partFiles = join(dlDir, `.kazaa-${downloader.getState().transfers[0].id}.part`)
      await assert.rejects(async () => stat(partFiles), (err: NodeJS.ErrnoException) => err.code === 'ENOENT')

      await assert.rejects(
        async () => {
          await downloader!.download(binaryResult.resultId, dlDest) // dlDest already exists!
        },
        (err: Error) => err.message === 'DESTINATION_EXISTS'
      )

      const zeroSearchDone = waitForState(
        downloader,
        (s) => s.search.status === 'complete' && s.search.results.some((r) => r.file.name === 'empty.txt'),
        25000,
        undefined,
        'zero-search-done'
      )
      await downloader.search('empty')
      await zeroSearchDone

      const zeroResult = downloader.getState().search.results.find((r) => r.file.name === 'empty.txt')!
      assert.ok(zeroResult)
      assert.equal(zeroResult.file.size, 0)

      const zeroDest = join(dlDir, 'downloaded_empty.txt')
      const zeroDlDone = waitForState(
        downloader,
        (s) => {
          const t = s.transfers.find((x) => x.fileName === 'downloaded_empty.txt' || x.fileName === 'empty.txt')
          return t?.state === 'completed'
        },
        120000,
        (s) => {
          const t = s.transfers.find((x) => x.fileName === 'downloaded_empty.txt' || x.fileName === 'empty.txt')
          return t?.state === 'failed' ? `Zero transfer failed: ${t.message}` : null
        },
        'zero-dl-done'
      )
      await downloader.download(zeroResult.resultId, zeroDest)
      await zeroDlDone
      const zeroBytes = await readFile(zeroDest)
      assert.equal(zeroBytes.length, 0)
    } finally {
      if (sn) await sn.dispose()
      if (uploader) await uploader.dispose()
      if (downloader) await downloader.dispose()
      await server.close()
    }
  })
})
