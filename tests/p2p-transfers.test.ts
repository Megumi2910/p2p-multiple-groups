import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { sanitizeDestinationFileName } from '../src/main/p2p/transfers.ts'
import { createSignalingServer } from '../services/signaling/server.ts'
import { createPeerEngine, type PeerEngine } from '../src/main/p2p/engine.ts'
import { makeGroupKey, type MultiGroupP2pState } from '../src/shared/p2p.ts'

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
    const groupId = `group-${randomUUID().slice(0, 8)}`
    const token = Buffer.alloc(32, 13).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [{ groupId, token }]
    })

    const signalUrl = `ws://127.0.0.1:${server.address.port}/signal`
    const groupKey = makeGroupKey(signalUrl, groupId)

    async function createEngine(name: string, supernodeEligible: boolean): Promise<PeerEngine> {
      const dir = await mkdtemp(join(tmpdir(), `p2p-xfer-${name}-`))
      tempDirs.push(dir)
      const engine = await createPeerEngine({ dataDirectory: dir })
      await engine.joinGroup({
        invitation: {
          version: 2,
          signalingUrl: signalUrl,
          groupId,
          token
        },
        displayName: name,
        supernodeEligible,
        relayOnly: false,
        rememberInvitation: false
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
        predicate: (state: MultiGroupP2pState) => boolean,
        timeoutMs = 25000,
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

      function waitForPeers(engine: PeerEngine, count: number): Promise<MultiGroupP2pState> {
        return waitForState(engine, (s) => (s.groups[0]?.network.members.length || 0) === count, 25000, undefined, 'peers-count-' + count)
      }

      function waitForLink(engine: PeerEngine, targetPeerId: string): Promise<MultiGroupP2pState> {
        return waitForState(
          engine,
          (s) => Boolean(s.groups[0]?.network.links.some((l) => l.peerId === targetPeerId && l.state === 'open')),
          25000,
          undefined,
          'link-open-' + targetPeerId.slice(0, 8)
        )
      }

      await Promise.all([waitForPeers(sn, 3), waitForPeers(uploader, 3), waitForPeers(downloader, 3)])
      await Promise.all([
        waitForLink(uploader, sn.getState().identity.peerId),
        waitForLink(downloader, sn.getState().identity.peerId),
        waitForLink(sn, uploader.getState().identity.peerId),
        waitForLink(sn, downloader.getState().identity.peerId)
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
          s.groups[0]?.catalog.acknowledgedGeneration !== null &&
          s.groups[0]?.catalog.acknowledgedGeneration === s.groups[0]?.catalog.advertisedGeneration &&
          s.library.files.length === 2 &&
          s.library.files.every((f) => f.status === 'shared'),
        25000,
        (s) => {
          const errFile = s.library.files.find((f) => f.status === 'error' || f.status === 'unavailable')
          return errFile ? `File error: ${errFile.name} (${errFile.message})` : null
        },
        'upload-ack'
      )
      await uploader.addFiles(groupKey, [binaryPath, zeroPath])
      await uploadAck

      // 2. Downloader searches for files
      const searchDone = waitForState(
        downloader,
        (s) => {
          return s.groups[0]?.search.status === 'complete' && Boolean(s.groups[0]?.search.results.some((r) => r.file.name === 'payload.bin'))
        },
        25000,
        undefined,
        'search-done'
      )
      await downloader.search(groupKey, 'payload')
      await searchDone
      const results = downloader.getState().groups[0]?.search.results || []
      const binaryResult = results.find((r) => r.file.name === 'payload.bin')!
      assert.ok(binaryResult)

      // 3. Download binary file
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
      await downloader.download(groupKey, binaryResult.resultId, dlDest)
      await binaryDlDone

      // Verify destination file exists and hash matches
      const downloadedBytes = await readFile(dlDest)
      assert.equal(downloadedBytes.length, binaryPayload.length)
      const dlHash = createHash('sha256').update(downloadedBytes).digest('hex')
      assert.equal(dlHash, binaryResult.file.sha256)

      // Verify .part file removed
      const partFiles = join(dlDir, `.p2p-multiple-groups-${downloader.getState().transfers[0].id}.part`)
      await assert.rejects(async () => stat(partFiles), (err: NodeJS.ErrnoException) => err.code === 'ENOENT')

      const secondDl = await downloader.download(groupKey, binaryResult.resultId, dlDest)
      assert.equal(secondDl.ok, false)
      assert.equal(secondDl.code, 'DESTINATION_EXISTS')

      const zeroSearchDone = waitForState(
        downloader,
        (s) => s.groups[0]?.search.status === 'complete' && Boolean(s.groups[0]?.search.results.some((r) => r.file.name === 'empty.txt')),
        25000,
        undefined,
        'zero-search-done'
      )
      await downloader.search(groupKey, 'empty')
      await zeroSearchDone

      const zeroResults = downloader.getState().groups[0]?.search.results || []
      const zeroResult = zeroResults.find((r) => r.file.name === 'empty.txt')!
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
      await downloader.download(groupKey, zeroResult.resultId, zeroDest)
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

  it('resumes interrupted transfer from same host and verifies file integrity', async () => {
    const groupId = `group-${randomUUID().slice(0, 8)}`
    const token = Buffer.alloc(32, 14).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [{ groupId, token }]
    })

    const signalUrl = `ws://127.0.0.1:${server.address.port}/signal`
    const groupKey = makeGroupKey(signalUrl, groupId)

    async function createEngine(name: string, supernodeEligible: boolean): Promise<PeerEngine> {
      const dir = await mkdtemp(join(tmpdir(), `p2p-resume-same-${name}-`))
      tempDirs.push(dir)
      const engine = await createPeerEngine({ dataDirectory: dir })
      await engine.joinGroup({
        invitation: { version: 2, signalingUrl: signalUrl, groupId, token },
        displayName: name,
        supernodeEligible,
        relayOnly: false,
        rememberInvitation: false
      })
      return engine
    }

    function waitForState(
      engine: PeerEngine,
      predicate: (state: MultiGroupP2pState) => boolean,
      timeoutMs = 25000,
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

    function waitForPeers(engine: PeerEngine, count: number): Promise<MultiGroupP2pState> {
      return waitForState(engine, (s) => (s.groups[0]?.network.members.length || 0) === count, 25000, undefined, 'peers-count-' + count)
    }

    function waitForLink(engine: PeerEngine, targetPeerId: string): Promise<MultiGroupP2pState> {
      return waitForState(
        engine,
        (s) => Boolean(s.groups[0]?.network.links.some((l) => l.peerId === targetPeerId && l.state === 'open')),
        25000,
        undefined,
        'link-open-' + targetPeerId.slice(0, 8)
      )
    }

    let sn: PeerEngine | null = null
    let uploader: PeerEngine | null = null
    let downloader: PeerEngine | null = null

    try {
      sn = await createEngine('SN', true)
      uploader = await createEngine('Uploader', false)
      downloader = await createEngine('Downloader', false)

      await Promise.all([waitForPeers(sn, 3), waitForPeers(uploader, 3), waitForPeers(downloader, 3)])
      await Promise.all([
        waitForLink(uploader, sn.getState().identity.peerId),
        waitForLink(downloader, sn.getState().identity.peerId)
      ])

      const upDir = await mkdtemp(join(tmpdir(), 'up-resume-files-'))
      tempDirs.push(upDir)

      const binaryPayload = Buffer.alloc(1024 * 1024)
      for (let i = 0; i < binaryPayload.length; i++) {
        binaryPayload[i] = (i * 17 + 3) & 0xff
      }
      const binaryPath = join(upDir, 'large.bin')
      await writeFile(binaryPath, binaryPayload)

      const uploadAck = waitForState(
        uploader,
        (s) =>
          s.groups[0]?.catalog.acknowledgedGeneration !== null &&
          s.groups[0]?.catalog.acknowledgedGeneration === s.groups[0]?.catalog.advertisedGeneration &&
          s.library.files.length === 1 &&
          s.library.files.every((f) => f.status === 'shared'),
        25000,
        undefined,
        'upload-ack'
      )
      await uploader.addFiles(groupKey, [binaryPath])
      await uploadAck

      const searchDone = waitForState(
        downloader,
        (s) => s.groups[0]?.search.status === 'complete' && Boolean(s.groups[0]?.search.results.some((r) => r.file.name === 'large.bin')),
        25000,
        undefined,
        'search-done'
      )
      await downloader.search(groupKey, 'large')
      await searchDone
      const results = downloader.getState().groups[0]?.search.results || []
      const binaryResult = results.find((r) => r.file.name === 'large.bin')!
      assert.ok(binaryResult)

      const dlDir = await mkdtemp(join(tmpdir(), 'dl-resume-files-'))
      tempDirs.push(dlDir)
      const dlDest = join(dlDir, 'large-dl.bin')

      let binaryTransferId = ''
      const progressPromise = waitForState(
        downloader,
        (s) => {
          const t = s.transfers.find((x) => x.fileName === 'large-dl.bin' || x.fileName === 'large.bin')
          if (t && t.transferredBytes >= 256 * 1024 && t.state === 'transferring') {
            binaryTransferId = t.id
            return true
          }
          return false
        },
        25000,
        undefined,
        'progress-256k'
      )

      await downloader.download(groupKey, binaryResult.resultId, dlDest)
      await progressPromise

      // Simulate unexpected connection drop by force-closing the active transfer channel
      const closed = downloader.forceCloseTransferChannel(binaryTransferId)
      assert.equal(closed, true)

      // Wait for downloader transfer to fail with canResume === true
      const failedState = await waitForState(
        downloader,
        (s) => {
          const t = s.transfers.find((x) => x.id === binaryTransferId)
          return t?.state === 'failed' && Boolean(t?.canResume)
        },
        25000,
        undefined,
        'transfer-failed-resumable'
      )

      const failedTransfer = failedState.transfers.find((x) => x.id === binaryTransferId)!
      assert.ok(failedTransfer.canResume)
      assert.ok(failedTransfer.transferredBytes >= 256 * 1024)

      const partPath = join(dlDir, `.p2p-multiple-groups-${failedTransfer.id}.part`)
      const partStat = await stat(partPath)
      assert.ok(partStat.size >= 256 * 1024)

      // Ensure uploader has also detected the channel closure and settled
      await waitForState(
        uploader,
        (s) => {
          const t = s.transfers.find((x) => x.id === binaryTransferId)
          return !t || t.state === 'failed' || t.state === 'completed' || t.state === 'cancelled'
        },
        25000,
        undefined,
        'uploader-settled'
      )

      const completedPromise = waitForState(
        downloader,
        (s) => {
          const t = s.transfers.find((x) => x.id === failedTransfer.id)
          return t?.state === 'completed'
        },
        120000,
        undefined,
        'resume-completed'
      )

      const resumeRes = await downloader.resumeTransfer(failedTransfer.id)
      assert.equal(resumeRes.ok, true)
      await completedPromise

      const finalBytes = await readFile(dlDest)
      assert.equal(finalBytes.length, binaryPayload.length)
      const finalHash = createHash('sha256').update(finalBytes).digest('hex')
      assert.equal(finalHash, binaryResult.file.sha256)

      await assert.rejects(async () => stat(partPath), (err: NodeJS.ErrnoException) => err.code === 'ENOENT')
    } finally {
      if (sn) await sn.dispose()
      if (uploader) await uploader.dispose()
      if (downloader) await downloader.dispose()
      await server.close()
    }
  })

  it('fails over to another host sharing identical file by sha256 upon original host disconnect', async () => {
    const groupId = `group-${randomUUID().slice(0, 8)}`
    const token = Buffer.alloc(32, 15).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [{ groupId, token }]
    })

    const signalUrl = `ws://127.0.0.1:${server.address.port}/signal`
    const groupKey = makeGroupKey(signalUrl, groupId)

    async function createEngine(name: string, supernodeEligible: boolean): Promise<PeerEngine> {
      const dir = await mkdtemp(join(tmpdir(), `p2p-failover-${name}-`))
      tempDirs.push(dir)
      const engine = await createPeerEngine({ dataDirectory: dir })
      await engine.joinGroup({
        invitation: { version: 2, signalingUrl: signalUrl, groupId, token },
        displayName: name,
        supernodeEligible,
        relayOnly: false,
        rememberInvitation: false
      })
      return engine
    }

    function waitForState(
      engine: PeerEngine,
      predicate: (state: MultiGroupP2pState) => boolean,
      timeoutMs = 25000,
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

    function waitForPeers(engine: PeerEngine, count: number): Promise<MultiGroupP2pState> {
      return waitForState(engine, (s) => (s.groups[0]?.network.members.length || 0) === count, 25000, 'peers-count-' + count)
    }

    function waitForLink(engine: PeerEngine, targetPeerId: string): Promise<MultiGroupP2pState> {
      return waitForState(
        engine,
        (s) => Boolean(s.groups[0]?.network.links.some((l) => l.peerId === targetPeerId && l.state === 'open')),
        25000,
        'link-open-' + targetPeerId.slice(0, 8)
      )
    }

    let sn: PeerEngine | null = null
    let uploaderA: PeerEngine | null = null
    let uploaderB: PeerEngine | null = null
    let downloader: PeerEngine | null = null

    try {
      sn = await createEngine('SN', true)
      uploaderA = await createEngine('UploaderA', false)
      uploaderB = await createEngine('UploaderB', false)
      downloader = await createEngine('Downloader', false)

      await Promise.all([waitForPeers(sn, 4), waitForPeers(uploaderA, 4), waitForPeers(uploaderB, 4), waitForPeers(downloader, 4)])
      await Promise.all([
        waitForLink(uploaderA, sn.getState().identity.peerId),
        waitForLink(uploaderB, sn.getState().identity.peerId),
        waitForLink(downloader, sn.getState().identity.peerId)
      ])

      const upDirA = await mkdtemp(join(tmpdir(), 'up-failover-a-'))
      const upDirB = await mkdtemp(join(tmpdir(), 'up-failover-b-'))
      tempDirs.push(upDirA, upDirB)

      const binaryPayload = Buffer.alloc(1024 * 1024)
      for (let i = 0; i < binaryPayload.length; i++) {
        binaryPayload[i] = (i * 23 + 7) & 0xff
      }
      const pathA = join(upDirA, 'shared.bin')
      const pathB = join(upDirB, 'shared.bin')
      await writeFile(pathA, binaryPayload)
      await writeFile(pathB, binaryPayload)

      const ackA = waitForState(
        uploaderA,
        (s) =>
          s.groups[0]?.catalog.acknowledgedGeneration !== null &&
          s.groups[0]?.catalog.acknowledgedGeneration === s.groups[0]?.catalog.advertisedGeneration &&
          s.library.files.length === 1 &&
          s.library.files.every((f) => f.status === 'shared'),
        25000,
        'upA-ack'
      )
      const ackB = waitForState(
        uploaderB,
        (s) =>
          s.groups[0]?.catalog.acknowledgedGeneration !== null &&
          s.groups[0]?.catalog.acknowledgedGeneration === s.groups[0]?.catalog.advertisedGeneration &&
          s.library.files.length === 1 &&
          s.library.files.every((f) => f.status === 'shared'),
        25000,
        'upB-ack'
      )

      await uploaderA.addFiles(groupKey, [pathA])
      await uploaderB.addFiles(groupKey, [pathB])
      await Promise.all([ackA, ackB])

      await downloader.search(groupKey, 'shared')
      await waitForState(
        downloader,
        (s) =>
          s.groups[0]?.search.status === 'complete' &&
          (s.groups[0]?.search.results.length || 0) >= 2 &&
          s.groups[0]?.search.results.some((r) => r.ownerPeerId === uploaderA!.getState().identity.peerId) &&
          s.groups[0]?.search.results.some((r) => r.ownerPeerId === uploaderB!.getState().identity.peerId),
        25000,
        'search-results'
      )

      const searchResults = downloader.getState().groups[0]?.search.results || []
      const targetResult = searchResults.find((r) => r.ownerPeerId === uploaderA!.getState().identity.peerId)!
      assert.ok(targetResult)

      const dlDir = await mkdtemp(join(tmpdir(), 'dl-failover-'))
      tempDirs.push(dlDir)
      const dlDest = join(dlDir, 'shared-dl.bin')

      let transferId = ''
      const progressPromise = waitForState(
        downloader,
        (s) => {
          const t = s.transfers.find((x) => x.fileName === 'shared-dl.bin' || x.fileName === 'shared.bin')
          if (t && t.transferredBytes >= 256 * 1024 && t.state === 'transferring') {
            transferId = t.id
            return true
          }
          return false
        },
        25000,
        'progress-256k'
      )

      await downloader.download(groupKey, targetResult.resultId, dlDest)
      await progressPromise

      // Force close channel and dispose uploaderA to make it permanently offline
      downloader.forceCloseTransferChannel(transferId)
      await uploaderA.dispose()
      uploaderA = null

      const failedState = await waitForState(
        downloader,
        (s) => {
          const t = s.transfers.find((x) => x.id === transferId)
          return t?.state === 'failed' && Boolean(t?.canResume)
        },
        25000,
        'transfer-failed'
      )

      const failedTransfer = failedState.transfers.find((x) => x.id === transferId)!
      assert.ok(failedTransfer.canResume)

      // Resume download - should automatically failover to uploaderB
      const completedPromise = waitForState(
        downloader,
        (s) => {
          const t = s.transfers.find((x) => x.id === failedTransfer.id)
          return t?.state === 'completed'
        },
        120000,
        'failover-completed'
      )

      const resumeRes = await downloader.resumeTransfer(failedTransfer.id)
      assert.equal(resumeRes.ok, true)
      await completedPromise

      const downloadedBytes = await readFile(dlDest)
      assert.equal(downloadedBytes.length, binaryPayload.length)
      const digest = createHash('sha256').update(downloadedBytes).digest('hex')
      assert.equal(digest, targetResult.file.sha256)
    } finally {
      if (sn) await sn.dispose()
      if (uploaderA) await uploaderA.dispose()
      if (uploaderB) await uploaderB.dispose()
      if (downloader) await downloader.dispose()
      await server.close()
    }
  })

  it('cleans up .part file on disk when interrupted resumable transfer is cancelled', async () => {
    const groupId = `group-${randomUUID().slice(0, 8)}`
    const token = Buffer.alloc(32, 16).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [{ groupId, token }]
    })

    const signalUrl = `ws://127.0.0.1:${server.address.port}/signal`
    const groupKey = makeGroupKey(signalUrl, groupId)

    async function createEngine(name: string, supernodeEligible: boolean): Promise<PeerEngine> {
      const dir = await mkdtemp(join(tmpdir(), `p2p-cancel-${name}-`))
      tempDirs.push(dir)
      const engine = await createPeerEngine({ dataDirectory: dir })
      await engine.joinGroup({
        invitation: { version: 2, signalingUrl: signalUrl, groupId, token },
        displayName: name,
        supernodeEligible,
        relayOnly: false,
        rememberInvitation: false
      })
      return engine
    }

    function waitForState(
      engine: PeerEngine,
      predicate: (state: MultiGroupP2pState) => boolean,
      timeoutMs = 25000,
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

    let sn: PeerEngine | null = null
    let uploader: PeerEngine | null = null
    let downloader: PeerEngine | null = null

    try {
      sn = await createEngine('SN', true)
      uploader = await createEngine('Uploader', false)
      downloader = await createEngine('Downloader', false)

      await Promise.all([
        waitForState(sn, (s) => (s.groups[0]?.network.members.length || 0) === 3, 25000, 'sn-3-peers'),
        waitForState(downloader, (s) => (s.groups[0]?.network.members.length || 0) === 3, 25000, 'dl-3-peers'),
        waitForState(uploader, (s) => (s.groups[0]?.network.members.length || 0) === 3, 25000, 'up-3-peers')
      ])

      await Promise.all([
        waitForState(uploader, (s) => Boolean(s.groups[0]?.network.links.some((l) => l.peerId === sn!.getState().identity.peerId && l.state === 'open')), 25000, 'up-sn-link'),
        waitForState(downloader, (s) => Boolean(s.groups[0]?.network.links.some((l) => l.peerId === sn!.getState().identity.peerId && l.state === 'open')), 25000, 'dl-sn-link')
      ])

      const upDir = await mkdtemp(join(tmpdir(), 'up-cancel-'))
      tempDirs.push(upDir)
      const binaryPayload = Buffer.alloc(1024 * 1024)
      const binaryPath = join(upDir, 'cancel.bin')
      await writeFile(binaryPath, binaryPayload)

      const uploadAck = waitForState(
        uploader,
        (s) =>
          s.groups[0]?.catalog.acknowledgedGeneration !== null &&
          s.groups[0]?.catalog.acknowledgedGeneration === s.groups[0]?.catalog.advertisedGeneration &&
          s.library.files.length === 1 &&
          s.library.files.every((f) => f.status === 'shared'),
        25000,
        'up-ack'
      )
      await uploader.addFiles(groupKey, [binaryPath])
      await uploadAck

      await downloader.search(groupKey, 'cancel')
      await waitForState(downloader, (s) => s.groups[0]?.search.status === 'complete' && (s.groups[0]?.search.results.length || 0) >= 1, 25000, 'search')

      const result = downloader.getState().groups[0]?.search.results[0]!
      const dlDir = await mkdtemp(join(tmpdir(), 'dl-cancel-'))
      tempDirs.push(dlDir)
      const dlDest = join(dlDir, 'cancel-dl.bin')

      let transferId = ''
      const progressPromise = waitForState(
        downloader,
        (s) => {
          const t = s.transfers.find((x) => x.fileName === 'cancel-dl.bin' || x.fileName === 'cancel.bin')
          if (t && t.transferredBytes >= 256 * 1024 && t.state === 'transferring') {
            transferId = t.id
            return true
          }
          return false
        },
        25000,
        'progress-256k'
      )

      await downloader.download(groupKey, result.resultId, dlDest)
      await progressPromise

      // Force close channel to simulate drop
      const closed = downloader.forceCloseTransferChannel(transferId)
      assert.equal(closed, true)

      const failedState = await waitForState(
        downloader,
        (s) => {
          const t = s.transfers.find((x) => x.id === transferId)
          return t?.state === 'failed' && Boolean(t?.canResume)
        },
        25000,
        'failed'
      )

      const transfer = failedState.transfers.find((x) => x.id === transferId)!
      const partPath = join(dlDir, `.p2p-multiple-groups-${transfer.id}.part`)
      const partStat = await stat(partPath)
      assert.ok(partStat.size >= 256 * 1024)

      // Cancel transfer
      const cancelRes = await downloader.cancelTransfer(transfer.id)
      assert.equal(cancelRes.ok, true)

      // Verify .part file is deleted
      await assert.rejects(async () => stat(partPath), (err: NodeJS.ErrnoException) => err.code === 'ENOENT')
    } finally {
      if (sn) await sn.dispose()
      if (uploader) await uploader.dispose()
      if (downloader) await downloader.dispose()
      await server.close()
    }
  })

  it('fails over to another host sharing identical file by sha256 when original host unshares file while remaining online in group', async () => {
    const groupId = `group-${randomUUID().slice(0, 8)}`
    const token = Buffer.alloc(32, 17).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [{ groupId, token }]
    })

    const signalUrl = `ws://127.0.0.1:${server.address.port}/signal`
    const groupKey = makeGroupKey(signalUrl, groupId)

    async function createEngine(name: string, supernodeEligible: boolean): Promise<PeerEngine> {
      const dir = await mkdtemp(join(tmpdir(), `p2p-unshare-failover-${name}-`))
      tempDirs.push(dir)
      const engine = await createPeerEngine({ dataDirectory: dir })
      await engine.joinGroup({
        invitation: { version: 2, signalingUrl: signalUrl, groupId, token },
        displayName: name,
        supernodeEligible,
        relayOnly: false,
        rememberInvitation: false
      })
      return engine
    }

    function waitForState(
      engine: PeerEngine,
      predicate: (state: MultiGroupP2pState) => boolean,
      timeoutMs = 25000,
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

    function waitForPeers(engine: PeerEngine, count: number): Promise<MultiGroupP2pState> {
      return waitForState(engine, (s) => (s.groups[0]?.network.members.length || 0) === count, 25000, 'peers-count-' + count)
    }

    function waitForLink(engine: PeerEngine, targetPeerId: string): Promise<MultiGroupP2pState> {
      return waitForState(
        engine,
        (s) => Boolean(s.groups[0]?.network.links.some((l) => l.peerId === targetPeerId && l.state === 'open')),
        25000,
        'link-open-' + targetPeerId.slice(0, 8)
      )
    }

    let downloader: PeerEngine | null = null
    let uploaderA: PeerEngine | null = null
    let uploaderB: PeerEngine | null = null

    try {
      downloader = await createEngine('DownloaderSN', true)
      uploaderA = await createEngine('UploaderA', false)
      uploaderB = await createEngine('UploaderB', false)

      await Promise.all([waitForPeers(downloader, 3), waitForPeers(uploaderA, 3), waitForPeers(uploaderB, 3)])
      await Promise.all([
        waitForLink(uploaderA, downloader.getState().identity.peerId),
        waitForLink(uploaderB, downloader.getState().identity.peerId)
      ])

      const upDirA = await mkdtemp(join(tmpdir(), 'up-unshare-a-'))
      const upDirB = await mkdtemp(join(tmpdir(), 'up-unshare-b-'))
      tempDirs.push(upDirA, upDirB)

      const binaryPayload = Buffer.alloc(1024 * 1024)
      for (let i = 0; i < binaryPayload.length; i++) {
        binaryPayload[i] = (i * 29 + 11) & 0xff
      }
      const pathA = join(upDirA, 'file-unshare.bin')
      const pathB = join(upDirB, 'file-unshare.bin')
      await writeFile(pathA, binaryPayload)
      await writeFile(pathB, binaryPayload)

      const ackA = waitForState(
        uploaderA,
        (s) =>
          s.groups[0]?.catalog.acknowledgedGeneration !== null &&
          s.groups[0]?.catalog.acknowledgedGeneration === s.groups[0]?.catalog.advertisedGeneration &&
          s.library.files.length === 1 &&
          s.library.files.every((f) => f.status === 'shared'),
        25000,
        'upA-ack'
      )
      const ackB = waitForState(
        uploaderB,
        (s) =>
          s.groups[0]?.catalog.acknowledgedGeneration !== null &&
          s.groups[0]?.catalog.acknowledgedGeneration === s.groups[0]?.catalog.advertisedGeneration &&
          s.library.files.length === 1 &&
          s.library.files.every((f) => f.status === 'shared'),
        25000,
        'upB-ack'
      )

      await uploaderA.addFiles(groupKey, [pathA])
      await uploaderB.addFiles(groupKey, [pathB])
      await Promise.all([ackA, ackB])

      await downloader.search(groupKey, 'unshare')
      await waitForState(
        downloader,
        (s) =>
          s.groups[0]?.search.status === 'complete' &&
          (s.groups[0]?.search.results.length || 0) >= 2 &&
          s.groups[0]?.search.results.some((r) => r.ownerPeerId === uploaderA!.getState().identity.peerId) &&
          s.groups[0]?.search.results.some((r) => r.ownerPeerId === uploaderB!.getState().identity.peerId),
        25000,
        'search-results'
      )

      const searchResults = downloader.getState().groups[0]?.search.results || []
      const targetResult = searchResults.find((r) => r.ownerPeerId === uploaderA!.getState().identity.peerId)!
      assert.ok(targetResult)

      const dlDir = await mkdtemp(join(tmpdir(), 'dl-unshare-'))
      tempDirs.push(dlDir)
      const dlDest = join(dlDir, 'unshare-dl.bin')

      let transferId = ''
      const progressPromise = waitForState(
        downloader,
        (s) => {
          const t = s.transfers.find((x) => x.fileName === 'unshare-dl.bin' || x.fileName === 'file-unshare.bin')
          if (t && t.transferredBytes >= 256 * 1024 && t.state === 'transferring') {
            transferId = t.id
            return true
          }
          return false
        },
        25000,
        'progress-256k'
      )

      await downloader.download(groupKey, targetResult.resultId, dlDest)
      await progressPromise

      // Force close channel to simulate drop
      const closed = downloader.forceCloseTransferChannel(transferId)
      assert.equal(closed, true)

      const failedState = await waitForState(
        downloader,
        (s) => {
          const t = s.transfers.find((x) => x.id === transferId)
          return t?.state === 'failed' && Boolean(t?.canResume)
        },
        25000,
        'transfer-failed'
      )

      const failedTransfer = failedState.transfers.find((x) => x.id === transferId)!
      assert.ok(failedTransfer.canResume)
      assert.ok(failedTransfer.transferredBytes >= 256 * 1024)

      // Host A unshares the file while REMAINING ONLINE in the group
      const fileIdA = uploaderA.getState().library.files[0]!.fileId
      const unshareAckA = waitForState(
        uploaderA,
        (s) =>
          s.groups[0]?.catalog.acknowledgedGeneration !== null &&
          s.groups[0]?.catalog.acknowledgedGeneration === s.groups[0]?.catalog.advertisedGeneration &&
          s.library.files.length === 0,
        25000,
        'upA-unshare-ack'
      )
      await uploaderA.removeFile(fileIdA)
      await unshareAckA

      // Verify Host A is STILL online in the group roster
      assert.ok(downloader.getState().groups[0]?.network.members.some((m) => m.peerId === uploaderA!.getState().identity.peerId))

      // Wait for uploaderA's transfer to settle
      await waitForState(
        uploaderA,
        (s) => {
          const t = s.transfers.find((x) => x.id === transferId)
          return !t || t.state === 'failed' || t.state === 'completed' || t.state === 'cancelled'
        },
        25000,
        'uploaderA-settled'
      )

      // Resume download - should skip Host A (unshared) and failover to Host B
      const completedPromise = waitForState(
        downloader,
        (s) => {
          const t = s.transfers.find((x) => x.id === failedTransfer.id)
          return t?.state === 'completed'
        },
        120000,
        'failover-unshared-completed'
      )

      const resumeRes = await downloader.resumeTransfer(failedTransfer.id)
      assert.equal(resumeRes.ok, true)
      await completedPromise

      const downloadedBytes = await readFile(dlDest)
      assert.equal(downloadedBytes.length, binaryPayload.length)
      const digest = createHash('sha256').update(downloadedBytes).digest('hex')
      assert.equal(digest, targetResult.file.sha256)
    } finally {
      if (downloader) await downloader.dispose()
      if (uploaderA) await uploaderA.dispose()
      if (uploaderB) await uploaderB.dispose()
      await server.close()
    }
  })
})
