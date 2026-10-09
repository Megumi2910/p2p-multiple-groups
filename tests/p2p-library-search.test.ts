import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  LibraryManager,
  sanitizeBasename,
  MAX_FILE_SIZE,
  MAX_LIBRARY_FILES
} from '../src/main/p2p/library.ts'
import {
  SupernodeIndexManager,
  SearchResultsTracker,
  normalizeQuery,
  matchesQuery
} from '../src/main/p2p/search-index.ts'
import { createSignalingServer } from '../services/signaling/server.ts'
import { createPeerEngine, type PeerEngine } from '../src/main/p2p/engine.ts'
import type { P2pFileMetadata, P2pState } from '../src/shared/p2p.ts'
import type { OverlayCatalogBatchMessage, OverlayCatalogBeginMessage, OverlayCatalogEndMessage } from '../src/shared/p2p-wire.ts'

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

describe('LibraryManager & File Indexing', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kazaa-lib-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('sanitizes basenames properly', () => {
    assert.equal(sanitizeBasename('song.mp3'), 'song.mp3')
    assert.equal(sanitizeBasename('  spaced.txt  '), 'spaced.txt')
    assert.equal(sanitizeBasename('.'), null)
    assert.equal(sanitizeBasename('..'), null)
    assert.equal(sanitizeBasename('path/traversal'), null)
    assert.equal(sanitizeBasename('path\\traversal'), null)
    assert.equal(sanitizeBasename('null\x00byte'), null)
  })

  it('indexes, streams SHA-256 hashes, and batches file metadata', async () => {
    const file1 = join(tempDir, 'file1.txt')
    const file2 = join(tempDir, 'file2.bin')
    await writeFile(file1, 'Hello Kazaa P2P World', 'utf-8')
    await writeFile(file2, Buffer.alloc(1024, 42))

    const lib = new LibraryManager()
    const { promise: scannedPromise, resolve: resolveScanned, reject: rejectScanned } = Promise.withResolvers<void>()
    let scanDone = false
    // Real-time safety deadline: bounding asynchronous library scan operations
    const scanTimer = setTimeout(() => {
      if (!scanDone) {
        scanDone = true
        unsub()
        rejectScanned(new Error('Timeout waiting for library scanning to complete'))
      }
    }, 25000)

    const unsub = lib.subscribe(() => {
      const state = lib.getState()
      if (!scanDone && state.status === 'idle' && state.files.length === 2 && state.files.every((f) => f.status === 'shared')) {
        scanDone = true
        clearTimeout(scanTimer)
        unsub()
        resolveScanned()
      }
    })
    const added = await lib.addFiles([file1, file2])
    assert.equal(added.length, 2)
    await scannedPromise

    const shared = lib.getSharedMetadata()
    assert.equal(shared.length, 2)
    assert.ok(shared[0].sha256)
    assert.ok(shared[1].sha256)

    const batches = lib.createBatches()
    assert.equal(batches.length, 1)
    assert.equal(batches[0].length, 2)

    // Authorization lookup
    const auth = await lib.getAuthorizedFile(added[0].fileId)
    assert.equal(auth.size, shared.find((s) => s.fileId === added[0].fileId)?.size)
    assert.equal(auth.sha256, shared.find((s) => s.fileId === added[0].fileId)?.sha256)

    // Modification detection
    await writeFile(file1, 'Modified content after indexing', 'utf-8')
    await assert.rejects(
      async () => {
        await lib.getAuthorizedFile(added[0].fileId)
      },
      (err: Error) => err.message === 'FILE_CHANGED'
    )
  })

  it('rejects duplicate paths and non-existent files gracefully', async () => {
    const file1 = join(tempDir, 'single.txt')
    await writeFile(file1, 'content', 'utf-8')

    const lib = new LibraryManager()
    const added1 = await lib.addFiles([file1])
    assert.equal(added1.length, 1)

    // Duplicate path
    const added2 = await lib.addFiles([file1])
    assert.equal(added2.length, 0)

    // Non-existent path
    const added3 = await lib.addFiles([join(tempDir, 'ghost.txt')])
    assert.equal(added3.length, 0)
  })
})

describe('SupernodeIndexManager & Search Routing', () => {
  it('normalizes query tokens and performs case-insensitive substring matching', () => {
    const tokens = normalizeQuery('  ROCK   Anthem  ')
    assert.deepEqual(tokens, ['rock', 'anthem'])

    assert.equal(matchesQuery('01 - Classic Rock Anthem (Live).mp3', tokens), true)
    assert.equal(matchesQuery('Classic Rock Song.mp3', tokens), false) // missing 'anthem'
  })

  it('atomically swaps staged catalogues only when count matches, rejecting incomplete batches', () => {
    const manager = new SupernodeIndexManager()
    const ownerId = 'owner-1'
    const sessionId = 'session-1'

    const begin: OverlayCatalogBeginMessage = {
      v: 1,
      type: 'catalog-begin',
      epoch: 'ep1',
      revision: 1,
      generation: 1,
      count: 2
    }

    const item1: P2pFileMetadata = {
      fileId: randomUUID(),
      name: 'song.mp3',
      size: 1000,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    }

    const batch1: OverlayCatalogBatchMessage = {
      v: 1,
      type: 'catalog-batch',
      epoch: 'ep1',
      revision: 1,
      generation: 1,
      entries: [item1]
    }

    const endCorrupt: OverlayCatalogEndMessage = {
      v: 1,
      type: 'catalog-end',
      epoch: 'ep1',
      revision: 1,
      generation: 1
    }

    manager.handleCatalogBegin(ownerId, sessionId, begin)
    manager.handleCatalogBatch(ownerId, batch1)
    // Only 1 item sent when count was 2 -> handleCatalogEnd returns false (atomic swap rejected!)
    const swapped = manager.handleCatalogEnd(ownerId, sessionId, endCorrupt)
    assert.equal(swapped, false)

    // Search for song: should NOT be indexed
    const res = manager.search('song', 'searcher-1', 'q1')
    assert.equal(res.entries.length, 0)

    // Complete transaction
    manager.handleCatalogBegin(ownerId, sessionId, begin)
    const item2: P2pFileMetadata = {
      fileId: randomUUID(),
      name: 'song-part2.mp3',
      size: 2000,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    }
    manager.handleCatalogBatch(ownerId, { ...batch1, entries: [item1, item2] })
    const validSwap = manager.handleCatalogEnd(ownerId, sessionId, endCorrupt)
    assert.equal(validSwap, true)

    // Search for song: now returns both files
    const res2 = manager.search('song', 'searcher-1', 'q2')
    assert.equal(res2.entries.length, 2)
  })

  it('tracks search results with deduplication and opaque result IDs', () => {
    const tracker = new SearchResultsTracker()
    const queryId = 'query-100'
    tracker.startNewSearch(queryId, 'rock')

    const fileMeta: P2pFileMetadata = {
      fileId: 'file-uuid-1',
      name: 'rock.mp3',
      size: 100,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    }

    const batch = [
      { ownerPeerId: 'owner-A', ownerSessionId: 'sess-A', file: fileMeta },
      { ownerPeerId: 'owner-A', ownerSessionId: 'sess-A', file: fileMeta } // duplicate in batch
    ]

    tracker.addBatch(queryId, batch, () => 'Alice')
    const results = tracker.getResults()
    assert.equal(results.length, 1) // deduplicated

    const resultId = results[0].resultId
    const resolved = tracker.resolveResult(resultId)
    assert.ok(resolved)
    assert.equal(resolved?.ownerPeerId, 'owner-A')
    assert.equal(resolved?.file.name, 'rock.mp3')
  })
})

describe('End-to-End Search & Catalogue Propagation', () => {
  it('propagates catalogue between supernode and ordinary peer, and routes search', async () => {
    const roomId = `room-${randomUUID().slice(0, 8)}`
    const token = Buffer.alloc(32, 11).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      roomId,
      token
    })

    const signalUrl = `ws://127.0.0.1:${server.address.port}/signal`
    const tempDirs: string[] = []

    async function createTestEngine(name: string, supernodeEligible: boolean): Promise<PeerEngine> {
      const dir = await mkdtemp(join(tmpdir(), `kazaa-e2e-${name}-`))
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
          state.network.status === 'connected' &&
          state.network.role === 'ordinary' &&
          Boolean(state.network.primaryPeerId) &&
          state.network.links.some((l) => l.peerId === state.network.primaryPeerId && l.state === 'open'),
        25000,
        undefined,
        'peer-ordinary-connected'
      )
      // Ordinary peer adds a file
      const shareDir = await mkdtemp(join(tmpdir(), 'kazaa-share-'))
      tempDirs.push(shareDir)
      const sharedFilePath = join(shareDir, 'great-anthem.mp3')
      await writeFile(sharedFilePath, 'Anthem MP3 Content', 'utf-8')

      const ackPromise = waitForState(
        peerEngine,
        (state) => {
          return (
            state.library.acknowledgedGeneration !== null &&
            state.library.acknowledgedGeneration === state.library.advertisedGeneration &&
            state.library.files.some((f) => f.name === 'great-anthem.mp3' && f.status === 'shared')
          )
        },
        25000,
        (s) => {
          const errFile = s.library.files.find((f) => f.status === 'error' || f.status === 'unavailable')
          return errFile ? `File error: ${errFile.name} (${errFile.message})` : null
        },
        'peer-library-ack'
      )

      await peerEngine.addFiles([sharedFilePath])
      await ackPromise

      // Supernode searches for 'anthem'
      const searchDone = waitForState(
        snEngine,
        (state) => state.search.status === 'complete' && state.search.results.length > 0,
        25000,
        undefined,
        'sn-search-done'
      )

      await snEngine.search('anthem')
      await searchDone

      const results = snEngine.getState().search.results
      assert.equal(results.length, 1)
      assert.equal(results[0].file.name, 'great-anthem.mp3')
      assert.equal(results[0].ownerName, 'OrdinaryPeer')

      // Ordinary peer removes file: search no longer returns it
      const fileId = peerEngine.getState().library.files[0].fileId
      const removeAckPromise = waitForState(
        peerEngine,
        (state) =>
          state.library.acknowledgedGeneration === state.library.advertisedGeneration &&
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
        (state) => state.search.query === 'anthem' && state.search.status === 'complete' && state.search.results.length === 0,
        25000,
        undefined,
        'sn-search2-done'
      )
      await snEngine.search('anthem')
      await search2Done
      assert.equal(snEngine.getState().search.results.length, 0)
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
    const roomId = `room-${randomUUID().slice(0, 8)}`
    const token = Buffer.alloc(32, 12).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      roomId,
      token
    })

    const signalUrl = `ws://127.0.0.1:${server.address.port}/signal`
    const tempDirs: string[] = []

    async function createTestEngine(name: string, supernodeEligible: boolean): Promise<PeerEngine> {
      const dir = await mkdtemp(join(tmpdir(), `kazaa-xsn-${name}-`))
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
    let p1: PeerEngine | null = null
    let p2: PeerEngine | null = null

    try {
      // Elect SN1 and SN2
      sn1 = await createTestEngine('SN1', true)
      sn2 = await createTestEngine('SN2', true)

      // Spawn ordinary peers P1 and P2
      p1 = await createTestEngine('P1', false)
      p2 = await createTestEngine('P2', false)

      // Wait for all 4 to see 4 members and links to primary supernodes to be open
      await Promise.all([
        waitForState(sn1, (s) => s.network.members.length === 4, 25000, undefined, 'sn1-members-4'),
        waitForState(sn2, (s) => s.network.members.length === 4, 25000, undefined, 'sn2-members-4'),
        waitForState(p1, (s) => s.network.members.length === 4 && Boolean(s.network.primaryPeerId) && s.network.links.some(l => l.peerId === s.network.primaryPeerId && l.state === 'open'), 25000, undefined, 'p1-members-4-open'),
        waitForState(p2, (s) => s.network.members.length === 4 && Boolean(s.network.primaryPeerId) && s.network.links.some(l => l.peerId === s.network.primaryPeerId && l.state === 'open'), 25000, undefined, 'p2-members-4-open')
      ])

      // P1 shares alpha-rock.mp3
      const dir1 = await mkdtemp(join(tmpdir(), 'p1-share-'))
      tempDirs.push(dir1)
      const file1 = join(dir1, 'alpha-rock.mp3')
      await writeFile(file1, 'Rock content', 'utf-8')
      const p1Ack = waitForState(
        p1,
        (state) => state.library.acknowledgedGeneration === state.library.advertisedGeneration && state.library.files.length === 1 && state.library.files[0].status === 'shared',
        25000,
        undefined,
        'p1-ack'
      )
      await p1.addFiles([file1])
      await p1Ack

      // P2 shares beta-jazz.mp3
      const dir2 = await mkdtemp(join(tmpdir(), 'p2-share-'))
      tempDirs.push(dir2)
      const file2 = join(dir2, 'beta-jazz.mp3')
      await writeFile(file2, 'Jazz content', 'utf-8')

      const p2Ack = waitForState(
        p2,
        (state) => state.library.acknowledgedGeneration === state.library.advertisedGeneration && state.library.files.length === 1 && state.library.files[0].status === 'shared',
        25000,
        undefined,
        'p2-ack'
      )
      await p2.addFiles([file2])
      await p2Ack

      // P2 searches for 'rock' -> cross-supernode discovery of P1's file!
      const p2SearchDone = waitForState(
        p2,
        (state) => state.search.status === 'complete' && state.search.results.some((r) => r.file.name === 'alpha-rock.mp3'),
        25000,
        undefined,
        'p2-search-rock'
      )
      await p2.search('rock')
      await p2SearchDone
      const rockResults = p2.getState().search.results
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
})
