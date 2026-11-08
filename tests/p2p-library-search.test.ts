import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import {
  LibraryManager,
  sanitizeBasename
} from '../src/main/p2p/library.ts'
import {
  SupernodeIndexManager,
  SearchResultsTracker
} from '../src/main/p2p/search-index.ts'
import { createSignalingServer } from '../services/signaling/server.ts'
import { createPeerEngine, type PeerEngine } from '../src/main/p2p/engine.ts'
import { makeGroupKey, type P2pFileMetadata, type MultiGroupP2pState } from '../src/shared/p2p.ts'
import type {
  OverlayCatalogBatchMessageV2,
  OverlayCatalogBeginMessageV2,
  OverlayCatalogEndMessageV2,
  OverlaySearchResultsMessageV2,
  OverlayControlMessageV2
} from '../src/shared/p2p-wire.ts'
import { TransportManager } from '../src/main/p2p/transport.ts'

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

  const unsub = engine.subscribe((s) => check(s))
  check(engine.getState())
  return promise
}

describe('LibraryManager Discovery & File Hashing', () => {
  it('sanitizes file basenames properly and rejects paths containing directory traversals', () => {
    assert.equal(sanitizeBasename('normal-song.mp3'), 'normal-song.mp3')
    assert.equal(sanitizeBasename('song with spaces.flac'), 'song with spaces.flac')
    assert.equal(sanitizeBasename(''), null)
    assert.equal(sanitizeBasename('.'), null)
    assert.equal(sanitizeBasename('..'), null)
    assert.equal(sanitizeBasename('sub/dir'), null)
    assert.equal(sanitizeBasename('C:\\escape'), null)
    assert.equal(sanitizeBasename('null\x00byte.txt'), null)
  })

  it('scans files, calculates SHA256 hashes, detects vanishing files, and batches metadata', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'library-test-'))
    const lib = new LibraryManager()

    try {
      const file1Path = join(tempDir, 'file1.txt')
      const file2Path = join(tempDir, 'file2.bin')
      await writeFile(file1Path, 'Hello world content', 'utf-8')
      await writeFile(file2Path, Buffer.alloc(1024, 42))

      const { promise: scannedPromise, resolve: resolveScanned } = Promise.withResolvers<void>()
      let scanCount = 0
      lib.subscribe(() => {
        const files = lib.getFiles()
        if (files.length === 2 && !lib.isScanning() && files.every((f) => f.status === 'shared')) {
          resolveScanned()
        }
      })

      const added = await lib.addFiles([file1Path, file2Path])
      assert.equal(added.length, 2)
      await scannedPromise

      const files = lib.getFiles()
      assert.equal(files.length, 2)
      const f1 = files.find((f) => f.name === 'file1.txt')
      const f2 = files.find((f) => f.name === 'file2.bin')
      assert.ok(f1)
      assert.ok(f2)
      assert.equal(f1.status, 'shared')
      assert.equal(f2.status, 'shared')
      assert.ok(f1.sha256)
      assert.ok(f2.sha256)
      assert.equal(f1.size, Buffer.byteLength('Hello world content', 'utf-8'))
      assert.equal(f2.size, 1024)

      // Test batch generation
      const batches = lib.createBatches()
      assert.ok(batches.length >= 1)
      assert.equal(batches[0].length, 2)

      // Remove file
      assert.equal(lib.removeFile(f1.fileId), true)
      assert.equal(lib.getFiles().length, 1)
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe('SupernodeIndexManager & Search Routing', () => {
  it('stages batches, verifies counts on catalog-end, and performs tokenized searches', () => {
    const index = new SupernodeIndexManager()
    const peerId = randomUUID()
    const sessionId = randomUUID()
    const memId = randomUUID()

    const beginMsg: OverlayCatalogBeginMessageV2 = {
      v: 2,
      type: 'catalog-begin',
      groupId: 'grp1',
      epoch: randomUUID(),
      revision: 1,
      senderMembershipId: memId,
      generation: 1,
      count: 2
    }
    const instant = index.handleCatalogBegin(peerId, sessionId, beginMsg, memId)
    assert.equal(instant, false) // 2 files expected

    const meta1: P2pFileMetadata = {
      fileId: randomUUID(),
      name: 'the-beatles-hey-jude.mp3',
      size: 5000000,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    }
    const meta2: P2pFileMetadata = {
      fileId: randomUUID(),
      name: 'queen-bohemian-rhapsody.flac',
      size: 30000000,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    }

    const batchMsg: OverlayCatalogBatchMessageV2 = {
      v: 2,
      type: 'catalog-batch',
      groupId: 'grp1',
      epoch: beginMsg.epoch,
      revision: 1,
      senderMembershipId: memId,
      generation: 1,
      entries: [meta1, meta2]
    }
    index.handleCatalogBatch(peerId, sessionId, batchMsg)

    const endMsg: OverlayCatalogEndMessageV2 = {
      v: 2,
      type: 'catalog-end',
      groupId: 'grp1',
      epoch: beginMsg.epoch,
      revision: 1,
      senderMembershipId: memId,
      generation: 1
    }
    const committed = index.handleCatalogEnd(peerId, sessionId, endMsg, memId)
    assert.equal(committed, true)

    // Search matches
    const searchRes = index.search('beatles jude', 'origin-peer', randomUUID())
    assert.equal(searchRes.entries.length, 1)
    assert.equal(searchRes.entries[0].file.name, 'the-beatles-hey-jude.mp3')
    assert.equal(searchRes.entries[0].ownerPeerId, peerId)

    // Unmatched search
    const noRes = index.search('pink floyd', 'origin-peer', randomUUID())
    assert.equal(noRes.entries.length, 0)
  })

  it('tracks search results with deduplication and opaque result IDs', () => {
    const tracker = new SearchResultsTracker()
    const queryId = randomUUID()
    tracker.startNewSearch(queryId, 'beatles')

    const fileMeta: P2pFileMetadata = {
      fileId: randomUUID(),
      name: 'song.mp3',
      size: 1000,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    }

    const peer1 = randomUUID()
    const sess1 = randomUUID()

    const added = tracker.addBatch(
      queryId,
      [{ ownerPeerId: peer1, ownerSessionId: sess1, file: fileMeta }],
      () => 'Alice'
    )
    assert.equal(added, true)
    assert.equal(tracker.getResults().length, 1)

    // Duplicate batch: same file from same session ignored
    const addedDup = tracker.addBatch(
      queryId,
      [{ ownerPeerId: peer1, ownerSessionId: sess1, file: fileMeta }],
      () => 'Alice'
    )
    assert.equal(addedDup, false)
    assert.equal(tracker.getResults().length, 1)
  })
})

describe('End-to-End Search & Catalogue Propagation', () => {
  it('propagates catalogue between supernode and ordinary peer, and routes search', async () => {
    const groupId = `group-${randomUUID().slice(0, 8)}`
    const token = Buffer.alloc(32, 11).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [{ groupId, token }]
    })

    const signalUrl = `ws://127.0.0.1:${server.address.port}/signal`
    const groupKey = makeGroupKey(signalUrl, groupId)
    const tempDirs: string[] = []

    async function createTestEngine(name: string, supernodeEligible: boolean): Promise<PeerEngine> {
      const dir = await mkdtemp(join(tmpdir(), `p2p-e2e-${name}-`))
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

    let snEngine: PeerEngine | null = null
    let peerEngine: PeerEngine | null = null

    try {
      // 1. Supernode joins first
      snEngine = await createTestEngine('Supernode1', true)
      // 2. Ordinary peer joins second
      peerEngine = await createTestEngine('OrdinaryPeer', false)

      // Wait for peer to see supernode and have its role set to ordinary
      await waitForState(
        peerEngine,
        (state) =>
          state.groups[0]?.network.status === 'connected' &&
          state.groups[0]?.network.role === 'ordinary' &&
          Boolean(state.groups[0]?.network.primaryPeerId) &&
          state.groups[0]?.network.links.some((l) => l.peerId === state.groups[0]?.network.primaryPeerId && l.state === 'open'),
        25000,
        undefined,
        'peer-ordinary-connected'
      )

      // Ordinary peer adds a file
      const shareDir = await mkdtemp(join(tmpdir(), 'p2p-share-'))
      tempDirs.push(shareDir)
      const sharedFilePath = join(shareDir, 'great-anthem.mp3')
      await writeFile(sharedFilePath, 'Anthem MP3 Content', 'utf-8')

      const ackPromise = waitForState(
        peerEngine,
        (state) => {
          return (
            state.groups[0]?.catalog.acknowledgedGeneration !== null &&
            state.groups[0]?.catalog.acknowledgedGeneration >= 2 &&
            state.groups[0]?.catalog.acknowledgedGeneration === state.groups[0]?.catalog.advertisedGeneration &&
            state.library.files.some((f) => f.name === 'great-anthem.mp3' && f.status === 'shared' && f.groupKeys.includes(groupKey))
          )
        },
        25000,
        (s) => {
          const errFile = s.library.files.find((f) => f.status === 'error' || f.status === 'unavailable')
          return errFile ? `File error: ${errFile.name} (${errFile.message})` : null
        },
        'peer-library-ack'
      )

      await peerEngine.addFiles(groupKey, [sharedFilePath])
      await ackPromise

      // Supernode searches for 'anthem'
      const searchDone = waitForState(
        snEngine,
        (state) => (state.groups[0]?.search.status === 'complete') && (state.groups[0]?.search.results.length || 0) > 0,
        25000,
        undefined,
        'sn-search-done'
      )

      await snEngine.search(groupKey, 'anthem')
      await searchDone

      const results = snEngine.getState().groups[0]?.search.results || []
      assert.equal(results.length, 1)
      assert.equal(results[0].file.name, 'great-anthem.mp3')
      assert.equal(results[0].ownerName, 'OrdinaryPeer')

      // Ordinary peer removes file: search no longer returns it
      const fileId = peerEngine.getState().library.files[0].fileId
      const removeAckPromise = waitForState(
        peerEngine,
        (state) =>
          state.groups[0]?.catalog.acknowledgedGeneration !== null &&
          state.groups[0]?.catalog.acknowledgedGeneration >= 3 &&
          state.groups[0]?.catalog.acknowledgedGeneration === state.groups[0]?.catalog.advertisedGeneration &&
          state.library.files.length === 0,
        25000,
        undefined,
        'peer-remove-ack'
      )
      await peerEngine.removeFile(fileId)
      await removeAckPromise

      // Search again on supernode
      const search2Done = waitForState(
        snEngine,
        (state) => state.groups[0]?.search.query === 'anthem' && state.groups[0]?.search.status === 'complete' && (state.groups[0]?.search.results.length || 0) === 0,
        25000,
        undefined,
        'sn-search2-done'
      )
      await snEngine.search(groupKey, 'anthem')
      await search2Done
      assert.equal((snEngine.getState().groups[0]?.search.results.length || 0), 0)
    } finally {
      if (snEngine) await snEngine.dispose()
      if (peerEngine) await peerEngine.dispose()
      await server.close()
      for (const d of tempDirs) {
        await rm(d, { recursive: true, force: true }).catch(() => {})
      }
    }
  })

  it('routes search across two elected supernodes to find files on distant ordinary peers', async () => {
    const groupId = `group-${randomUUID().slice(0, 8)}`
    const token = Buffer.alloc(32, 12).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [{ groupId, token }]
    })

    const signalUrl = `ws://127.0.0.1:${server.address.port}/signal`
    const groupKey = makeGroupKey(signalUrl, groupId)
    const tempDirs: string[] = []

    async function createTestEngine(name: string, supernodeEligible: boolean): Promise<PeerEngine> {
      const dir = await mkdtemp(join(tmpdir(), `p2p-xsn-${name}-`))
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

    let sn1: PeerEngine | null = null
    let sn2: PeerEngine | null = null
    let p1: PeerEngine | null = null
    let p2: PeerEngine | null = null

    try {
      sn1 = await createTestEngine('SN1', true)
      sn2 = await createTestEngine('SN2', true)

      p1 = await createTestEngine('P1', false)
      p2 = await createTestEngine('P2', false)

      await Promise.all([
        waitForState(sn1, (s) => (s.groups[0]?.network.members.length || 0) === 4, 25000, undefined, 'sn1-members-4'),
        waitForState(sn2, (s) => (s.groups[0]?.network.members.length || 0) === 4, 25000, undefined, 'sn2-members-4'),
        waitForState(p1, (s) => (s.groups[0]?.network.members.length || 0) === 4 && Boolean(s.groups[0]?.network.primaryPeerId) && s.groups[0]?.network.links.some(l => l.peerId === s.groups[0]?.network.primaryPeerId && l.state === 'open'), 25000, undefined, 'p1-members-4-open'),
        waitForState(p2, (s) => (s.groups[0]?.network.members.length || 0) === 4 && Boolean(s.groups[0]?.network.primaryPeerId) && s.groups[0]?.network.links.some(l => l.peerId === s.groups[0]?.network.primaryPeerId && l.state === 'open'), 25000, undefined, 'p2-members-4-open')
      ])

      const dir1 = await mkdtemp(join(tmpdir(), 'p1-share-'))
      tempDirs.push(dir1)
      const file1 = join(dir1, 'alpha-rock.mp3')
      await writeFile(file1, 'Rock content', 'utf-8')
      const p1Ack = waitForState(
        p1,
        (state) => state.groups[0]?.catalog.acknowledgedGeneration === state.groups[0]?.catalog.advertisedGeneration && state.library.files.length === 1 && state.library.files[0].status === 'shared',
        25000,
        undefined,
        'p1-ack'
      )
      await p1.addFiles(groupKey, [file1])
      await p1Ack

      const dir2 = await mkdtemp(join(tmpdir(), 'p2-share-'))
      tempDirs.push(dir2)
      const file2 = join(dir2, 'beta-jazz.mp3')
      await writeFile(file2, 'Jazz content', 'utf-8')

      const p2Ack = waitForState(
        p2,
        (state) => state.groups[0]?.catalog.acknowledgedGeneration === state.groups[0]?.catalog.advertisedGeneration && state.library.files.length === 1 && state.library.files[0].status === 'shared',
        25000,
        undefined,
        'p2-ack'
      )
      await p2.addFiles(groupKey, [file2])
      await p2Ack

      const p2SearchDone = waitForState(
        p2,
        (state) => state.groups[0]?.search.status === 'complete' && Boolean(state.groups[0]?.search.results.some((r) => r.file.name === 'alpha-rock.mp3')),
        25000,
        undefined,
        'p2-search-rock'
      )
      await p2.search(groupKey, 'rock')
      await p2SearchDone
      const rockResults = p2.getState().groups[0]?.search.results || []
      assert.ok(rockResults.length >= 1)
      assert.equal(rockResults[0].file.name, 'alpha-rock.mp3')
      assert.equal(rockResults[0].ownerName, 'P1')
    } finally {
      if (sn1) await sn1.dispose()
      if (sn2) await sn2.dispose()
      if (p1) await p1.dispose()
      if (p2) await p2.dispose()
      await server.close()
      for (const d of tempDirs) {
        await rm(d, { recursive: true, force: true }).catch(() => {})
      }
    }
  })

  it('waits for connecting primary link before dispatching search, bounds failures, and suppresses superseded queries', async () => {
    const groupId = `early-search-${randomUUID().slice(0, 8)}`
    const token = Buffer.alloc(32, 241).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [{ groupId, token }]
    })
    const signalUrl = `ws://127.0.0.1:${server.address.port}/signal`
    const groupKey = makeGroupKey(signalUrl, groupId)
    const tempDirs: string[] = []

    let pauseLinkOpen = true
    const linkControl = {
      resolvers: [] as Array<() => void>,
      trigger() {
        const list = this.resolvers.splice(0)
        for (const fn of list) fn()
      }
    }

    class ControllableTransport extends TransportManager {
      async waitForLinkOpen(peerId: string, timeoutMs: number = 10000): Promise<void> {
        if (pauseLinkOpen) {
          const { promise, resolve } = Promise.withResolvers<void>()
          linkControl.resolvers.push(resolve)
          await promise
        }
        return super.waitForLinkOpen(peerId, timeoutMs)
      }
    }

    const snDir = await mkdtemp(join(tmpdir(), 'sn-early-'))
    const peerDir = await mkdtemp(join(tmpdir(), 'peer-early-'))
    tempDirs.push(snDir, peerDir)

    let sn: PeerEngine | null = null
    let peer: PeerEngine | null = null

    try {
      sn = await createPeerEngine({ dataDirectory: snDir })
      await sn.joinGroup({
        invitation: {
          version: 2,
          signalingUrl: signalUrl,
          groupId,
          token
        },
        displayName: 'SN',
        supernodeEligible: true,
        relayOnly: false,
        rememberInvitation: false
      })

      const shareDir = await mkdtemp(join(tmpdir(), 'share-early-'))
      tempDirs.push(shareDir)
      const testFile = join(shareDir, 'early-target.txt')
      await writeFile(testFile, 'Early search content', 'utf-8')

      const snAck = waitForState(
        sn,
        (s) => s.groups[0]?.catalog.acknowledgedGeneration !== null && s.library.files.length === 1 && s.library.files[0].status === 'shared',
        25000,
        undefined,
        'sn-ack'
      )
      await sn.addFiles(groupKey, [testFile])
      await snAck

      peer = await createPeerEngine({
        dataDirectory: peerDir,
        transportFactory: (_url, events) => new ControllableTransport(events)
      })
      await peer.joinGroup({
        invitation: {
          version: 2,
          signalingUrl: signalUrl,
          groupId,
          token
        },
        displayName: 'OrdinaryPeer',
        supernodeEligible: false,
        relayOnly: false,
        rememberInvitation: false
      })

      await waitForState(
        peer,
        (s) => Boolean(s.groups[0]?.network.primaryPeerId),
        25000,
        undefined,
        'peer-has-primary'
      )

      // 1. Issue search while link is held paused in connecting state
      const searchProm = peer.search(groupKey, 'early')

      assert.equal(peer.getState().groups[0]?.search.status, 'searching')

      // Unpause link
      pauseLinkOpen = false
      linkControl.trigger()

      const sRes = await searchProm
      assert.equal(sRes.ok, true)
      await waitForState(
        peer,
        (s) => s.groups[0]?.search.status === 'complete' && Boolean(s.groups[0]?.search.results.some((r) => r.file.name === 'early-target.txt')),
        25000,
        undefined,
        'search-completed-with-result'
      )

      const results = peer.getState().groups[0]?.search.results || []
      assert.ok(results.length >= 1)
      assert.equal(results[0].file.name, 'early-target.txt')

      // 2. Query superseding check
      pauseLinkOpen = true
      const q1Prom = peer.search(groupKey, 'first-query')
      const firstQueryId = peer.getState().groups[0]?.search.queryId

      const q2Prom = peer.search(groupKey, 'second-query')
      const secondQueryId = peer.getState().groups[0]?.search.queryId
      assert.notEqual(firstQueryId, secondQueryId)

      pauseLinkOpen = false
      linkControl.trigger()

      const [res1, res2] = await Promise.all([q1Prom, q2Prom])
      assert.equal(res1.ok, false)
      assert.equal(res1.code, 'UNREACHABLE')
      assert.equal(res2.ok, true)
      assert.equal(peer.getState().groups[0]?.search.query, 'second-query')
    } finally {
      if (sn) await sn.dispose()
      if (peer) await peer.dispose()
      await server.close()
      for (const d of tempDirs) {
        await rm(d, { recursive: true, force: true }).catch(() => {})
      }
    }
  })

  it('correctly rebinds sender membership, epoch, and revision in supernode search relay', async () => {
    const groupId = `relay-hdr-${randomUUID().slice(0, 8)}`
    const token = Buffer.alloc(32, 242).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [{ groupId, token }]
    })
    const signalUrl = `ws://127.0.0.1:${server.address.port}/signal`
    const groupKey = makeGroupKey(signalUrl, groupId)

    const tempDirs: string[] = []
    const interceptState: { frame: OverlaySearchResultsMessageV2 | null } = { frame: null }

    class Sn1Transport extends TransportManager {
      sendControl(grpId: string, targetPeerId: string, message: OverlayControlMessageV2): boolean {
        if (message.type === 'search-results') {
          if (sn1 && message.responderPeerId !== sn1.getState().identity.peerId) {
            interceptState.frame = message
          }
        }
        return super.sendControl(grpId, targetPeerId, message)
      }
    }

    const dirSn1 = await mkdtemp(join(tmpdir(), 'sn1-relay-'))
    const dirSn2 = await mkdtemp(join(tmpdir(), 'sn2-relay-'))
    const dirDistant = await mkdtemp(join(tmpdir(), 'dist-relay-'))
    const dirReq = await mkdtemp(join(tmpdir(), 'req-relay-'))
    tempDirs.push(dirSn1, dirSn2, dirDistant, dirReq)

    let sn1: PeerEngine | null = null
    let sn2: PeerEngine | null = null
    let distantPeer: PeerEngine | null = null
    let requester: PeerEngine | null = null

    try {
      sn1 = await createPeerEngine({
        dataDirectory: dirSn1,
        transportFactory: (_url, events) => new Sn1Transport(events)
      })
      await sn1.joinGroup({
        invitation: { version: 2, signalingUrl: signalUrl, groupId, token },
        displayName: 'SN1',
        supernodeEligible: true,
        relayOnly: false,
        rememberInvitation: false
      })

      sn2 = await createPeerEngine({ dataDirectory: dirSn2 })
      await sn2.joinGroup({
        invitation: { version: 2, signalingUrl: signalUrl, groupId, token },
        displayName: 'SN2',
        supernodeEligible: true,
        relayOnly: false,
        rememberInvitation: false
      })

      const sn1PeerId = sn1.getState().identity.peerId
      const sn2PeerId = sn2.getState().identity.peerId

      function findPeerId(targetSn: string, otherSn: string): string {
        for (let i = 0; i < 1000; i++) {
          const id = randomUUID()
          const scoreTarget = createHash('sha256').update(`${id}:${targetSn}`).digest('hex')
          const scoreOther = createHash('sha256').update(`${id}:${otherSn}`).digest('hex')
          if (scoreTarget > scoreOther) return id
        }
        return randomUUID()
      }

      const reqPeerId = findPeerId(sn1PeerId, sn2PeerId)
      const distPeerId = findPeerId(sn2PeerId, sn1PeerId)

      await writeFile(join(dirReq, 'peer-state.json'), JSON.stringify({
        version: 2,
        peerId: reqPeerId,
        displayName: 'RequesterPeer',
        relayOnly: false,
        groups: [],
        sharedFiles: []
      }))

      await writeFile(join(dirDistant, 'peer-state.json'), JSON.stringify({
        version: 2,
        peerId: distPeerId,
        displayName: 'DistantPeer',
        relayOnly: false,
        groups: [],
        sharedFiles: []
      }))

      class RequesterTransport extends TransportManager {
        async handleSignal(
          grpId: string,
          fromPeerId: string,
          fromSessionId: string,
          connectionId: string,
          kind: string,
          payload: unknown
        ): Promise<void> {
          if (fromPeerId === sn2PeerId) return
          return super.handleSignal(grpId, fromPeerId, fromSessionId, connectionId, kind, payload)
        }
      }

      distantPeer = await createPeerEngine({ dataDirectory: dirDistant })
      await distantPeer.joinGroup({
        invitation: { version: 2, signalingUrl: signalUrl, groupId, token },
        displayName: 'DistantPeer',
        supernodeEligible: false,
        relayOnly: false,
        rememberInvitation: false
      })

      requester = await createPeerEngine({
        dataDirectory: dirReq,
        transportFactory: (_url, events) => new RequesterTransport(events)
      })
      await requester.joinGroup({
        invitation: { version: 2, signalingUrl: signalUrl, groupId, token },
        displayName: 'RequesterPeer',
        supernodeEligible: false,
        relayOnly: false,
        rememberInvitation: false
      })

      await Promise.all([
        waitForState(sn1, (s) => (s.groups[0]?.network.members.length || 0) === 4, 25000, undefined, 'sn1-mesh-ready'),
        waitForState(sn2, (s) => (s.groups[0]?.network.members.length || 0) === 4, 25000, undefined, 'sn2-mesh-ready'),
        waitForState(distantPeer, (s) => (s.groups[0]?.network.members.length || 0) === 4 && Boolean(s.groups[0]?.network.primaryPeerId) && s.groups[0]?.network.links.some((l) => l.peerId === s.groups[0]?.network.primaryPeerId && l.state === 'open'), 25000, undefined, 'distant-mesh-ready'),
        waitForState(requester, (s) => (s.groups[0]?.network.members.length || 0) === 4 && Boolean(s.groups[0]?.network.primaryPeerId) && s.groups[0]?.network.links.some((l) => l.peerId === s.groups[0]?.network.primaryPeerId && l.state === 'open'), 25000, undefined, 'req-mesh-ready')
      ])

      const shareDir = await mkdtemp(join(tmpdir(), 'dist-share-'))
      tempDirs.push(shareDir)
      const secretFile = join(shareDir, 'secret-unique-doc.txt')
      await writeFile(secretFile, 'Secret content across supernodes', 'utf-8')

      const distAck = waitForState(
        distantPeer,
        (s) => s.groups[0]?.catalog.acknowledgedGeneration !== null && s.library.files.length === 1 && s.library.files[0].status === 'shared',
        25000,
        undefined,
        'distant-ack'
      )
      await distantPeer.addFiles(groupKey, [secretFile])
      await distAck

      const searchDone = waitForState(
        requester,
        (s) => s.groups[0]?.search.status === 'complete' && Boolean(s.groups[0]?.search.results.some((r) => r.file.name === 'secret-unique-doc.txt')),
        25000,
        undefined,
        'requester-search-done'
      )
      await requester.search(groupKey, 'unique')
      await searchDone

      const results = requester.getState().groups[0]?.search.results || []
      assert.ok(results.length >= 1, 'Requester must receive relayed search result')
      assert.equal(results[0].file.name, 'secret-unique-doc.txt')
      assert.ok(interceptState.frame, 'Sn1 must have intercepted the relayed search results frame')
      const sn1State = sn1.getState()
      const sn1Group = sn1State.groups[0]
      const sn1MembershipId = sn1Group?.network.membershipId || ''
      assert.equal(
        interceptState.frame.senderMembershipId,
        sn1MembershipId,
        'Relayed frame senderMembershipId must be rebound to the relaying supernode'
      )
    } finally {
      if (sn1) await sn1.dispose()
      if (sn2) await sn2.dispose()
      if (distantPeer) await distantPeer.dispose()
      if (requester) await requester.dispose()
      await server.close()
      for (const d of tempDirs) {
        await rm(d, { recursive: true, force: true }).catch(() => {})
      }
    }
  })
})
