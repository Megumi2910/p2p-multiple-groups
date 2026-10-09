import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
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

describe('P2P Multi-Group Authorization & Security Boundaries', () => {
  it('strictly rejects unauthorized cross-group transfer requests without leaking private file', async () => {
    const groupAlphaId = `sec-alpha-${randomUUID().slice(0, 8)}`
    const groupBetaId = `sec-beta-${randomUUID().slice(0, 8)}`
    const tokenAlpha = Buffer.alloc(32, 201).toString('base64url')
    const tokenBeta = Buffer.alloc(32, 202).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [
        { groupId: groupAlphaId, token: tokenAlpha, name: 'Secure Alpha' },
        { groupId: groupBetaId, token: tokenBeta, name: 'Secure Beta' }
      ]
    })

    const signalUrl = `ws://127.0.0.1:${server.address.port}/signal`
    const alphaKey = makeGroupKey(signalUrl, groupAlphaId)
    const betaKey = makeGroupKey(signalUrl, groupBetaId)

    const tempDirs: string[] = []

    async function createEngine(name: string, isSupernode: boolean): Promise<PeerEngine> {
      const dir = await mkdtemp(join(tmpdir(), `sec-p2p-${name}-`))
      tempDirs.push(dir)
      const engine = await createPeerEngine({ dataDirectory: dir })

      await engine.joinGroup({
        invitation: { version: 2, signalingUrl: signalUrl, groupId: groupAlphaId, token: tokenAlpha },
        displayName: `${name}-Peer`,
        supernodeEligible: isSupernode,
        relayOnly: false,
        rememberInvitation: false
      })
      await engine.joinGroup({
        invitation: { version: 2, signalingUrl: signalUrl, groupId: groupBetaId, token: tokenBeta },
        displayName: `${name}-Peer`,
        supernodeEligible: isSupernode,
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
              return (
                alphaGroup.network.links.some((l) => l.peerId === snPeerId && l.state === 'open') &&
                betaGroup.network.links.some((l) => l.peerId === snPeerId && l.state === 'open')
              )
            }
            return alphaGroup.network.links.filter((l) => l.state === 'open').length >= 2
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

      // Prepare private file on uploader (granted ONLY to Alpha)
      const upDir = await mkdtemp(join(tmpdir(), 'up-sec-files-'))
      tempDirs.push(upDir)
      const secretPayload = Buffer.from('TOP SECRET ALPHA CONTENT ONLY', 'utf-8')
      const secretPath = join(upDir, 'classified-alpha.txt')
      await writeFile(secretPath, secretPayload)

      await uploader.addFiles(alphaKey, [secretPath])

      // Wait for file indexed in Alpha
      await waitForEngineState(
        uploader,
        (s) => {
          const g = s.groups.find((gr) => gr.groupKey === alphaKey)
          return Boolean(
            g &&
            g.catalog.acknowledgedGeneration !== null &&
            g.catalog.acknowledgedGeneration >= 1 &&
            s.library.files.some((f) => f.name === 'classified-alpha.txt' && f.status === 'shared')
          )
        },
        25000,
        undefined,
        'uploader-alpha-catalog-acknowledged'
      )

      // Search in Alpha: file is found
      const searchAlphaDone = waitForEngineState(
        downloader,
        (s) => {
          const g = s.groups.find((gr) => gr.groupKey === alphaKey)
          return Boolean(g && g.search.status === 'complete' && g.search.results.some((r) => r.file.name === 'classified-alpha.txt'))
        },
        25000,
        undefined,
        'search-alpha-done'
      )
      await downloader.search(alphaKey, 'classified')
      await searchAlphaDone

      const alphaGroupState = downloader.getState().groups.find((g) => g.groupKey === alphaKey)!
      const secretResult = alphaGroupState.search.results.find((r) => r.file.name === 'classified-alpha.txt')!
      assert.ok(secretResult)

      // Search in Beta: file MUST NOT appear in Beta
      const searchBetaDone = waitForEngineState(
        downloader,
        (s) => {
          const g = s.groups.find((gr) => gr.groupKey === betaKey)
          return Boolean(g && g.search.status === 'complete')
        },
        25000,
        undefined,
        'search-beta-done'
      )
      await downloader.search(betaKey, 'classified')
      await searchBetaDone

      const betaGroupState = downloader.getState().groups.find((g) => g.groupKey === betaKey)!
      assert.equal(betaGroupState.search.results.length, 0, 'Classified alpha file must not leak to Beta search results')

      // Attacker attempts cross-group download:
      // Try to download classified-alpha using Beta group context (which has NO grant on uploader)
      const dlDir = await mkdtemp(join(tmpdir(), 'dl-sec-files-'))
      tempDirs.push(dlDir)
      const attackDest = join(dlDir, 'leaked-secret.txt')

      // Expect download to fail / reject with NOT_FOUND / NOT_AUTHORIZED
      // The resolveSearchResult will fail if we query betaKey for secretResult.resultId
      const crossResolved = downloader.resolveSearchResult(betaKey, secretResult.resultId)
      assert.equal(crossResolved, undefined, 'Must never resolve result from Group Alpha in Group Beta')

      // Even if downloader tries to download secretResult.resultId in betaKey directly:
      await assert.rejects(
        async () => {
          await downloader!.download(betaKey, secretResult.resultId, attackDest)
        },
        (err: Error) => err.message.includes('NOT_FOUND')
      )

      // Ensure no leaked file was written or published
      await assert.rejects(async () => stat(attackDest), (err: NodeJS.ErrnoException) => err.code === 'ENOENT')
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

  it('cancels active transfer mid-stream when file grant is revoked, while other group continues', async () => {
    const groupAlphaId = `rev-alpha-${randomUUID().slice(0, 8)}`
    const groupBetaId = `rev-beta-${randomUUID().slice(0, 8)}`
    const tokenAlpha = Buffer.alloc(32, 211).toString('base64url')
    const tokenBeta = Buffer.alloc(32, 212).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [
        { groupId: groupAlphaId, token: tokenAlpha, name: 'Revoke Alpha' },
        { groupId: groupBetaId, token: tokenBeta, name: 'Revoke Beta' }
      ]
    })

    const signalUrl = `ws://127.0.0.1:${server.address.port}/signal`
    const alphaKey = makeGroupKey(signalUrl, groupAlphaId)
    const betaKey = makeGroupKey(signalUrl, groupBetaId)

    const tempDirs: string[] = []

    async function createEngine(name: string, isSupernode: boolean): Promise<PeerEngine> {
      const dir = await mkdtemp(join(tmpdir(), `rev-p2p-${name}-`))
      tempDirs.push(dir)
      const engine = await createPeerEngine({ dataDirectory: dir })

      await engine.joinGroup({
        invitation: { version: 2, signalingUrl: signalUrl, groupId: groupAlphaId, token: tokenAlpha },
        displayName: `${name}-Peer`,
        supernodeEligible: isSupernode,
        relayOnly: false,
        rememberInvitation: false
      })
      await engine.joinGroup({
        invitation: { version: 2, signalingUrl: signalUrl, groupId: groupBetaId, token: tokenBeta },
        displayName: `${name}-Peer`,
        supernodeEligible: isSupernode,
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
              return (
                alphaGroup.network.links.some((l) => l.peerId === snPeerId && l.state === 'open') &&
                betaGroup.network.links.some((l) => l.peerId === snPeerId && l.state === 'open')
              )
            }
            return alphaGroup.network.links.filter((l) => l.state === 'open').length >= 2
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

      // Prepare files
      const upDir = await mkdtemp(join(tmpdir(), 'up-rev-files-'))
      tempDirs.push(upDir)

      const payloadAlpha = Buffer.alloc(256 * 1024, 71) // 256 KiB
      const alphaPath = join(upDir, 'rev-alpha.bin')
      await writeFile(alphaPath, payloadAlpha)

      const payloadBeta = Buffer.alloc(64 * 1024, 72) // 64 KiB
      const betaPath = join(upDir, 'safe-beta.bin')
      await writeFile(betaPath, payloadBeta)

      await uploader.addFiles(alphaKey, [alphaPath])
      await uploader.addFiles(betaKey, [betaPath])

      // Wait for acknowledgment on both groups
      await waitForEngineState(
        uploader,
        (s) => {
          const gA = s.groups.find((g) => g.groupKey === alphaKey)
          const gB = s.groups.find((g) => g.groupKey === betaKey)
          return Boolean(
            gA && gA.catalog.acknowledgedGeneration !== null &&
            gB && gB.catalog.acknowledgedGeneration !== null &&
            s.library.files.length === 2 &&
            s.library.files.every((f) => f.status === 'shared')
          )
        },
        25000,
        undefined,
        'catalogs-acknowledged'
      )

      // Search in Alpha
      const searchAlphaDone = waitForEngineState(
        downloader,
        (s) => {
          const g = s.groups.find((gr) => gr.groupKey === alphaKey)
          return Boolean(g && g.search.status === 'complete' && g.search.results.some((r) => r.file.name === 'rev-alpha.bin'))
        },
        25000,
        undefined,
        'search-alpha-done'
      )
      await downloader.search(alphaKey, 'rev')
      await searchAlphaDone

      // Search in Beta
      const searchBetaDone = waitForEngineState(
        downloader,
        (s) => {
          const g = s.groups.find((gr) => gr.groupKey === betaKey)
          return Boolean(g && g.search.status === 'complete' && g.search.results.some((r) => r.file.name === 'safe-beta.bin'))
        },
        25000,
        undefined,
        'search-beta-done'
      )
      await downloader.search(betaKey, 'safe')
      await searchBetaDone

      const resAlpha = downloader.getState().groups.find((g) => g.groupKey === alphaKey)!.search.results.find((r) => r.file.name === 'rev-alpha.bin')!
      const resBeta = downloader.getState().groups.find((g) => g.groupKey === betaKey)!.search.results.find((r) => r.file.name === 'safe-beta.bin')!

      const dlDir = await mkdtemp(join(tmpdir(), 'dl-rev-files-'))
      tempDirs.push(dlDir)
      const destAlpha = join(dlDir, 'revoked.bin')
      const destBeta = join(dlDir, 'safe.bin')

      // Start Beta transfer (which must finish successfully)
      const betaDlDone = waitForEngineState(
        downloader,
        (s) => {
          const t = s.transfers.find((tr) => tr.fileName === 'safe.bin' || tr.fileName === 'safe-beta.bin')
          return t?.state === 'completed'
        },
        30000,
        undefined,
        'beta-dl-done'
      )

      // Start Alpha transfer
      await downloader.download(alphaKey, resAlpha.resultId, destAlpha)
      await downloader.download(betaKey, resBeta.resultId, destBeta)

      // Immediately revoke Alpha grant on uploader
      const uploaderAlphaEntry = uploader.getState().library.files.find((f) => f.name === 'rev-alpha.bin')!
      await uploader.setFileGroups(uploaderAlphaEntry.fileId, []) // Revoke from all groups!

      // Expect Alpha transfer to fail or cancel on downloader
      await waitForEngineState(
        downloader,
        (s) => {
          const t = s.transfers.find((tr) => tr.fileName === 'revoked.bin' || tr.fileName === 'rev-alpha.bin')
          return t?.state === 'failed' || t?.state === 'cancelled'
        },
        25000,
        undefined,
        'alpha-transfer-aborted'
      )

      // Beta transfer must continue and complete!
      await betaDlDone
      const betaBytes = await readFile(destBeta)
      assert.equal(betaBytes.length, payloadBeta.length)
      assert.equal(createHash('sha256').update(betaBytes).digest('hex'), resBeta.file.sha256)

      // Alpha destination file MUST NOT exist (publication aborted)
      await assert.rejects(async () => stat(destAlpha), (err: NodeJS.ErrnoException) => err.code === 'ENOENT')
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
