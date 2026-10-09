import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createSignalingServer } from '../services/signaling/server.ts'
import { createPeerEngine, type PeerEngine } from '../src/main/p2p/engine.ts'
import { makeGroupKey, type MultiGroupP2pState, type P2pState } from '../src/shared/p2p.ts'

function waitForEngineState(
  engine: PeerEngine,
  predicate: (state: MultiGroupP2pState & P2pState) => boolean,
  timeoutMs = 25000,
  rejectPredicate?: (state: MultiGroupP2pState & P2pState) => string | null,
  label?: string
): Promise<MultiGroupP2pState & P2pState> {
  const { promise, resolve, reject } = Promise.withResolvers<MultiGroupP2pState & P2pState>()
  let done = false

  const timer = setTimeout(() => {
    if (!done) {
      done = true
      unsub()
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for: ${label || 'state condition'}`))
    }
  }, timeoutMs)

  const check = (s: MultiGroupP2pState & P2pState) => {
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

describe('Simultaneous Multi-Group P2P Mesh', () => {
  it('executes concurrent independent catalogs, searches, and transfers across multiple groups over pooled connection', async () => {
    const groupAlphaId = `group-alpha-${randomUUID().slice(0, 8)}`
    const groupBetaId = `group-beta-${randomUUID().slice(0, 8)}`
    const tokenAlpha = Buffer.alloc(32, 101).toString('base64url')
    const tokenBeta = Buffer.alloc(32, 102).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [
        { groupId: groupAlphaId, token: tokenAlpha, name: 'Group Alpha' },
        { groupId: groupBetaId, token: tokenBeta, name: 'Group Beta' }
      ]
    })

    const signalUrl = `ws://127.0.0.1:${server.address.port}/signal`
    const alphaKey = makeGroupKey(signalUrl, groupAlphaId)
    const betaKey = makeGroupKey(signalUrl, groupBetaId)

    const tempDirs: string[] = []

    async function createTestEngine(name: string, isSupernode: boolean): Promise<PeerEngine> {
      const dir = await mkdtemp(join(tmpdir(), `p2p-multi-${name}-`))
      tempDirs.push(dir)
      const engine = await createPeerEngine({ dataDirectory: dir })

        // Join Alpha
        const resAlpha = await engine.joinGroup({
          invitation: { version: 2, signalingUrl: signalUrl, groupId: groupAlphaId, token: tokenAlpha },
          displayName: `${name}-Peer`,
          supernodeEligible: isSupernode,
          relayOnly: false,
          rememberInvitation: false
        })
        assert.ok(resAlpha.ok, `Join alpha failed: ${resAlpha.message}`)

        // Join Beta
        const resBeta = await engine.joinGroup({
          invitation: { version: 2, signalingUrl: signalUrl, groupId: groupBetaId, token: tokenBeta },
          displayName: `${name}-Peer`,
          supernodeEligible: isSupernode,
          relayOnly: false,
          rememberInvitation: false
        })
        assert.ok(resBeta.ok, `Join beta failed: ${resBeta.message}`)

      return engine
    }

    let sn: PeerEngine | null = null
    let uploader: PeerEngine | null = null
    let downloader: PeerEngine | null = null

    try {
      sn = await createTestEngine('SN', true)
      uploader = await createTestEngine('Uploader', false)
      downloader = await createTestEngine('Downloader', false)

      // Wait for all peers to join and establish mesh links across both groups
      const snPeerId = sn.getState().identity.peerId
      const waitForMesh = (eng: PeerEngine, name: string) =>
        waitForEngineState(
          eng,
          (s) => {
            const alphaGroup = s.groups.find((g) => g.groupKey === alphaKey)
            const betaGroup = s.groups.find((g) => g.groupKey === betaKey)
            if (!alphaGroup || !betaGroup) return false
            if (alphaGroup.network.status !== 'connected' || betaGroup.network.status !== 'connected') return false
            if (alphaGroup.network.members.length !== 3 || betaGroup.network.members.length !== 3) return false
            if (s.identity.peerId !== snPeerId) {
              const alphaHasLink = alphaGroup.network.links.some((l) => l.peerId === snPeerId && l.state === 'open')
              const betaHasLink = betaGroup.network.links.some((l) => l.peerId === snPeerId && l.state === 'open')
              return alphaHasLink && betaHasLink
            } else {
              return alphaGroup.network.links.filter((l) => l.state === 'open').length >= 2
            }
          },
          25000,
          undefined,
          `${name}-mesh-ready`
        )
      await Promise.all([
        waitForMesh(sn, 'sn'),
        waitForMesh(uploader, 'uploader'),
        waitForMesh(downloader, 'downloader')
      ])

      // Prepare files on uploader
      const upDir = await mkdtemp(join(tmpdir(), 'up-multi-files-'))
      tempDirs.push(upDir)

      const payloadAlpha = Buffer.alloc(64 * 1024, 65) // 64 KiB of 'A'
      const alphaPath = join(upDir, 'alpha-data.bin')
      await writeFile(alphaPath, payloadAlpha)

      const payloadBeta = Buffer.alloc(96 * 1024, 66) // 96 KiB of 'B'
      const betaPath = join(upDir, 'beta-data.bin')
      await writeFile(betaPath, payloadBeta)

      const payloadBoth = Buffer.alloc(32 * 1024, 67) // 32 KiB of 'C'
      const bothPath = join(upDir, 'shared-both.bin')
      await writeFile(bothPath, payloadBoth)

      // Add files with explicit scoped group grants
      await uploader.addFiles(alphaKey, [alphaPath])
      await uploader.addFiles(betaKey, [betaPath])
      await uploader.addFiles(alphaKey, [bothPath])
      // Grant betaKey to bothPath as well
      const uploaderFiles = uploader.getState().library.files
      const bothEntry = uploaderFiles.find((f) => f.name === 'shared-both.bin')!
      assert.ok(bothEntry)
      await uploader.setFileGroups(bothEntry.fileId, [alphaKey, betaKey])

      // Wait for uploader library catalog acknowledged on both groups
      await waitForEngineState(
        uploader,
        (s) => {
          const alphaGroup = s.groups.find((g) => g.groupKey === alphaKey)
          const betaGroup = s.groups.find((g) => g.groupKey === betaKey)
          return (
            Boolean(alphaGroup && alphaGroup.catalog.acknowledgedGeneration !== null && alphaGroup.catalog.acknowledgedGeneration >= 1) &&
            Boolean(betaGroup && betaGroup.catalog.acknowledgedGeneration !== null && betaGroup.catalog.acknowledgedGeneration >= 1) &&
            s.library.files.length === 3 &&
            s.library.files.every((f) => f.status === 'shared')
          )
        },
        25000,
        undefined,
        'uploader-catalogs-acknowledged'
      )

      // Search in Group Alpha for "data"
      const alphaSearchDone = waitForEngineState(
        downloader,
        (s) => {
          const g = s.groups.find((gr) => gr.groupKey === alphaKey)
          return Boolean(g && g.search.status === 'complete' && g.search.results.length > 0)
        },
        25000,
        undefined,
        'alpha-search-done'
      )
      await downloader.search(alphaKey, 'data')
      await alphaSearchDone

      const downloaderAlphaGroup = downloader.getState().groups.find((g) => g.groupKey === alphaKey)!
      const alphaResults = downloaderAlphaGroup.search.results
      // Group Alpha must contain alpha-data.bin but strictly exclude beta-data.bin
      assert.ok(alphaResults.some((r) => r.file.name === 'alpha-data.bin'))
      assert.ok(!alphaResults.some((r) => r.file.name === 'beta-data.bin'))

      // Search in Group Beta for "data"
      const betaSearchDone = waitForEngineState(
        downloader,
        (s) => {
          const g = s.groups.find((gr) => gr.groupKey === betaKey)
          return Boolean(g && g.search.status === 'complete' && g.search.results.length > 0)
        },
        25000,
        undefined,
        'beta-search-done'
      )
      await downloader.search(betaKey, 'data')
      await betaSearchDone

      const downloaderBetaGroup = downloader.getState().groups.find((g) => g.groupKey === betaKey)!
      const betaResults = downloaderBetaGroup.search.results
      // Group Beta must contain beta-data.bin but strictly exclude alpha-data.bin
      assert.ok(betaResults.some((r) => r.file.name === 'beta-data.bin'))
      assert.ok(!betaResults.some((r) => r.file.name === 'alpha-data.bin'))

      // Concurrent downloads: downloader downloads alpha-data.bin in Alpha and beta-data.bin in Beta simultaneously
      const alphaResultEntry = alphaResults.find((r) => r.file.name === 'alpha-data.bin')!
      const betaResultEntry = betaResults.find((r) => r.file.name === 'beta-data.bin')!

      const dlDir = await mkdtemp(join(tmpdir(), 'dl-multi-files-'))
      tempDirs.push(dlDir)
      const dlAlphaPath = join(dlDir, 'received-alpha.bin')
      const dlBetaPath = join(dlDir, 'received-beta.bin')

      const transfersDone = waitForEngineState(
        downloader,
        (s) => {
          const tAlpha = s.transfers.find((t) => t.fileName === 'received-alpha.bin' || t.fileName === 'alpha-data.bin')
          const tBeta = s.transfers.find((t) => t.fileName === 'received-beta.bin' || t.fileName === 'beta-data.bin')
          return Boolean(tAlpha?.state === 'completed' && tBeta?.state === 'completed')
        },
        60000,
        (s) => {
          const failed = s.transfers.find((t) => t.state === 'failed')
          return failed ? `Transfer failed: ${failed.message}` : null
        },
        'concurrent-transfers-completed'
      )

      await Promise.all([
        downloader.download(alphaKey, alphaResultEntry.resultId, dlAlphaPath),
        downloader.download(betaKey, betaResultEntry.resultId, dlBetaPath)
      ])

      await transfersDone

      // Verify received files on disk
      const bytesAlpha = await readFile(dlAlphaPath)
      const bytesBeta = await readFile(dlBetaPath)

      assert.equal(bytesAlpha.length, payloadAlpha.length)
      assert.equal(createHash('sha256').update(bytesAlpha).digest('hex'), alphaResultEntry.file.sha256)

      assert.equal(bytesBeta.length, payloadBeta.length)
      assert.equal(createHash('sha256').update(bytesBeta).digest('hex'), betaResultEntry.file.sha256)
    } finally {
      if (sn) await sn.dispose()
      if (uploader) await uploader.dispose()
      if (downloader) await downloader.dispose()
      await server.close()
      for (const d of tempDirs) {
        await rm(d, { recursive: true, force: true }).catch(() => {})
      }
    }
  })
})
