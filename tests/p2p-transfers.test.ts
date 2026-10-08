import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { sanitizeDestinationFileName } from '../src/main/p2p/transfers.ts'
import { createSignalingServer } from '../services/signaling/server.ts'
import { createPeerEngine, type PeerEngine } from '../src/main/p2p/engine.ts'

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
      function waitForLink(engine: PeerEngine, targetPeerId: string): Promise<void> {
        const { promise, resolve } = Promise.withResolvers<void>()
        let done = false
        const unsub = engine.subscribe((s) => {
          const l = s.network.links.find((x) => x.peerId === targetPeerId)
          if (!done && l && l.state === 'open') {
            done = true
            unsub()
            resolve()
          }
        })
        const cur = engine.getState().network.links.find((x) => x.peerId === targetPeerId)
        if (cur && cur.state === 'open') {
          done = true
          unsub()
          resolve()
        }
        return promise
      }
      await Promise.all([waitForPeers(sn, 3), waitForPeers(uploader, 3), waitForPeers(downloader, 3)])
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

      const { promise: uploadAck, resolve: resolveUploadAck } = Promise.withResolvers<void>()
      uploader.subscribe((state) => {
        if (
          state.library.acknowledgedGeneration === state.library.advertisedGeneration &&
          state.library.files.length === 2 &&
          state.library.files.every((f) => f.status === 'shared')
        ) {
          resolveUploadAck()
        }
      })
      await uploader.addFiles([binaryPath, zeroPath])
      await uploadAck
      // 2. Downloader searches for files
      const { promise: searchDone, resolve: resolveSearchDone } = Promise.withResolvers<void>()
      const unsubSearch = downloader.subscribe((state) => {
        if (state.search.status === 'complete' && state.search.results.some((r) => r.file.name === 'payload.bin')) {
          unsubSearch()
          resolveSearchDone()
        }
      })
      await downloader.search('payload')
      await searchDone
      const results = downloader.getState().search.results
      const binaryResult = results.find((r) => r.file.name === 'payload.bin')!
      assert.ok(binaryResult)

      // 3. Download binary file
      const dlDir = await mkdtemp(join(tmpdir(), 'dl-files-'))
      tempDirs.push(dlDir)
      const dlDest = join(dlDir, 'downloaded.bin')

      const { promise: binaryDlDone, resolve: resolveBinaryDlDone, reject: rejectBinaryDl } = Promise.withResolvers<void>()
      const unsubDl = downloader.subscribe((state) => {
        const transfer = state.transfers.find((t) => t.fileName === 'downloaded.bin' || t.fileName === 'payload.bin')
        if (transfer && transfer.state === 'completed') {
          unsubDl()
          resolveBinaryDlDone()
        } else if (transfer && transfer.state === 'failed') {
          unsubDl()
          rejectBinaryDl(new Error(`Transfer failed: ${transfer.message}`))
        }
      })
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

      const { promise: zeroSearchDone, resolve: resolveZeroSearchDone } = Promise.withResolvers<void>()
      const unsubZeroSearch = downloader.subscribe((state) => {
        if (state.search.status === 'complete' && state.search.results.some((r) => r.file.name === 'empty.txt')) {
          unsubZeroSearch()
          resolveZeroSearchDone()
        }
      })
      await downloader.search('empty')
      await zeroSearchDone

      const zeroResult = downloader.getState().search.results.find((r) => r.file.name === 'empty.txt')!
      assert.ok(zeroResult)
      assert.equal(zeroResult.file.size, 0)

      const zeroDest = join(dlDir, 'downloaded_empty.txt')
      const { promise: zeroDlDone, resolve: resolveZeroDlDone, reject: rejectZeroDl } = Promise.withResolvers<void>()
      const unsubZeroDl = downloader.subscribe((state) => {
        const t = state.transfers.find((x) => x.fileName === 'downloaded_empty.txt' || x.fileName === 'empty.txt')
        if (t && t.state === 'completed') {
          unsubZeroDl()
          resolveZeroDlDone()
        } else if (t && t.state === 'failed') {
          unsubZeroDl()
          rejectZeroDl(new Error(`Zero transfer failed: ${t.message}`))
        }
      })
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
