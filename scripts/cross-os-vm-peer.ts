import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createSignalingServer, type SignalingServerInstance } from '../services/signaling/server.ts'
import { createPeerEngine, type PeerEngine } from '../src/main/p2p/engine.ts'
import { makeGroupKey, type MultiGroupP2pState } from '../src/shared/p2p.ts'

interface TestFileInfo {
  name: string
  path: string
  size: number
  sha256: string
}

function waitForCatalogAck(engine: PeerEngine, groupKey: string, expectedMinShared: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub()
      reject(new Error('Timeout waiting for catalog ack on VM peer'))
    }, 25000)

    const check = (s: MultiGroupP2pState) => {
      const g = s.groups.find((x) => x.groupKey === groupKey)
      const sharedCount = s.library.files.filter((f) => f.status === 'shared').length
      if (
        g?.catalog.acknowledgedGeneration !== null &&
        g?.catalog.acknowledgedGeneration === g?.catalog.advertisedGeneration &&
        sharedCount >= expectedMinShared
      ) {
        clearTimeout(timer)
        unsub()
        resolve()
      }
    }

    const unsub = engine.subscribe(check)
    check(engine.getState())
  })
}

async function createAndShareTestFiles(
  filesDir: string,
  engine: PeerEngine,
  groupKey: string
): Promise<Record<string, TestFileInfo>> {
  const specs: Array<{ name: string; data: Buffer }> = [
    { name: 'file-empty.txt', data: Buffer.alloc(0) },
    { name: 'file-1byte.bin', data: Buffer.from([0xab]) },
    { name: 'file-odd-size.bin', data: randomBytes(1234567) },
    { name: 'file-complete.bin', data: randomBytes(512 * 1024) },
    { name: 'file-resumable.bin', data: randomBytes(4 * 1024 * 1024) },
    { name: 'file-large.bin', data: randomBytes(12 * 1024 * 1024) },
    { name: 'file-cancel.bin', data: randomBytes(2 * 1024 * 1024) },
    { name: 'file-mutable.bin', data: randomBytes(256 * 1024) },
    { name: 'file-failover.bin', data: randomBytes(2 * 1024 * 1024) },
    { name: 'report:2026?.txt', data: randomBytes(64 * 1024) },
    { name: 'tài liệu kiểm thử (v1).bin', data: randomBytes(128 * 1024) }
  ]

  const testFiles: Record<string, TestFileInfo> = {}
  const paths: string[] = []

  for (const spec of specs) {
    const filePath = join(filesDir, spec.name)
    await writeFile(filePath, spec.data)
    const sha256 = createHash('sha256').update(spec.data).digest('hex')
    testFiles[spec.name] = {
      name: spec.name,
      path: filePath,
      size: spec.data.length,
      sha256
    }
    paths.push(filePath)
  }

  await engine.addFiles(groupKey, paths)
  await waitForCatalogAck(engine, groupKey, specs.length)
  return testFiles
}

async function main() {
  const HTTP_PORT = 8766
  const SIGNAL_PORT = 8765
  const GROUP_ID = 'cross-os-test-group'
  const TOKEN = Buffer.alloc(32, 42).toString('base64url')
  const VM_HOST = process.env.VM_PEER_HOST || '192.168.123.128'
  const SIGNAL_URL = `ws://${VM_HOST}:${SIGNAL_PORT}/signal`
  const GROUP_KEY = makeGroupKey(SIGNAL_URL, GROUP_ID)

  console.log('[VM-PEER] Initializing Cross-OS Linux Peer...')

  const workDir = await mkdtemp(join(tmpdir(), 'cross-os-linux-'))
  const filesDir = join(workDir, 'shared')
  const dlDir = join(workDir, 'downloads')
  const dataDir = join(workDir, 'engine-data')
  await mkdir(filesDir, { recursive: true })
  await mkdir(dlDir, { recursive: true })

  const signalingServer: SignalingServerInstance = await createSignalingServer({
    host: '0.0.0.0',
    port: SIGNAL_PORT,
    groups: [{ groupId: GROUP_ID, token: TOKEN }]
  })
  console.log(`[VM-PEER] Signaling server listening on ws://0.0.0.0:${SIGNAL_PORT}/signal`)

  let engine: PeerEngine = await createPeerEngine({ dataDirectory: dataDir })
  await engine.joinGroup({
    invitation: {
      version: 2,
      signalingUrl: SIGNAL_URL,
      groupId: GROUP_ID,
      token: TOKEN
    },
    displayName: 'LinuxVM-Supernode',
    supernodeEligible: true,
    relayOnly: false,
    rememberInvitation: false
  })

  const testFiles = await createAndShareTestFiles(filesDir, engine, GROUP_KEY)
  console.log(`[VM-PEER] ${Object.keys(testFiles).length} test files shared and acknowledged.`)

  const controlServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Content-Type', 'application/json')
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    try {
      if (req.method === 'GET' && url.pathname === '/status') {
        const state = engine.getState()
        const group = state.groups.find((g) => g.groupKey === GROUP_KEY)
        res.writeHead(200)
        res.end(
          JSON.stringify({
            ready: true,
            peerId: state.identity.peerId,
            sessionId: group?.network.sessionId ?? null,
            groupKey: GROUP_KEY,
            groupId: GROUP_ID,
            token: TOKEN,
            signalingUrl: SIGNAL_URL,
            peersConnected: group?.network.members.length ?? 0,
            role: group?.network.role,
            primaryPeerId: group?.network.primaryPeerId,
            links: group?.network.links.map((l) => ({ peerId: l.peerId, state: l.state, path: l.path })),
            libraryFiles: state.library.files.map((f) => ({
              fileId: f.fileId,
              name: f.name,
              status: f.status,
              groupKeys: f.groupKeys
            })),
            groupCatalog: group?.catalog,
            files: testFiles,
            transfers: state.transfers.map((t) => ({
              id: t.id,
              name: t.fileName,
              direction: t.direction,
              state: t.state,
              transferred: t.transferredBytes,
              total: t.size,
              canResume: t.canResume,
              message: t.message
            }))
          })
        )
        return
      }

      if (req.method === 'POST' && url.pathname === '/unshare') {
        const body = await readBody(req)
        const { name } = JSON.parse(body) as { name: string }
        const file = engine.getState().library.files.find((f) => f.name === name)
        if (!file) {
          res.writeHead(404)
          res.end(JSON.stringify({ ok: false, error: 'File not found' }))
          return
        }
        await engine.removeFile(file.fileId)
        await waitForCatalogAck(engine, GROUP_KEY, 0)
        console.log(`[VM-PEER] Unshared file ${name} (${file.fileId})`)
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true, unshared: name }))
        return
      }

      if (req.method === 'POST' && url.pathname === '/modify-file') {
        const body = await readBody(req)
        const { name } = JSON.parse(body) as { name: string }
        const info = testFiles[name]
        if (!info) {
          res.writeHead(404)
          res.end(JSON.stringify({ ok: false, error: 'Test file not found' }))
          return
        }
        // Overwrite with different size + contents and bump mtime
        const newBytes = randomBytes(info.size + 123)
        await writeFile(info.path, newBytes)
        console.log(`[VM-PEER] Modified ${name} on disk (${info.size} -> ${newBytes.length} bytes)`)
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true, oldSize: info.size, newSize: newBytes.length }))
        return
      }

      if (req.method === 'POST' && url.pathname === '/leave-rejoin') {
        const body = await readBody(req)
        const { delayMs = 800 } = body ? (JSON.parse(body) as { delayMs?: number }) : {}
        const beforeSession = engine.getState().groups.find((g) => g.groupKey === GROUP_KEY)?.network.sessionId
        console.log(`[VM-PEER] Restarting engine for ${delayMs}ms (old session=${beforeSession})...`)
        await engine.dispose()
        await new Promise((r) => setTimeout(r, delayMs))
        engine = await createPeerEngine({ dataDirectory: dataDir })
        await engine.joinGroup({
          invitation: {
            version: 2,
            signalingUrl: SIGNAL_URL,
            groupId: GROUP_ID,
            token: TOKEN
          },
          displayName: 'LinuxVM-Supernode',
          supernodeEligible: true,
          relayOnly: false,
          rememberInvitation: false
        })
        await waitForCatalogAck(engine, GROUP_KEY, 1)
        const afterSession = engine.getState().groups.find((g) => g.groupKey === GROUP_KEY)?.network.sessionId
        console.log(`[VM-PEER] Engine restarted and rejoined (new session=${afterSession})`)
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true, beforeSession, afterSession }))
        return
      }

      if (req.method === 'POST' && url.pathname === '/reverse-download') {
        const body = await readBody(req)
        const {
          fileName,
          destName,
          interruptAtBytes,
          resumeAfterInterrupt = false
        } = JSON.parse(body) as {
          fileName: string
          destName?: string
          interruptAtBytes?: number
          resumeAfterInterrupt?: boolean
        }
        console.log(`[VM-PEER] Searching for reverse download: ${fileName}`)
        const searchDispatch = await engine.search(GROUP_KEY, fileName)
        if (!searchDispatch.ok) {
          throw new Error(`Reverse search failed: ${searchDispatch.message}`)
        }

        const searchRes = await new Promise<any>((resolve, reject) => {
          const timeout = setTimeout(() => {
            unsub()
            reject(new Error(`Reverse search timeout for ${fileName}`))
          }, 15000)
          const check = (s: MultiGroupP2pState) => {
            const g = s.groups.find((x) => x.groupKey === GROUP_KEY)
            const found = g?.search.results.find((r) => r.file.name === fileName)
            if (found) {
              clearTimeout(timeout)
              unsub()
              resolve(found)
            }
          }
          const unsub = engine.subscribe(check)
          check(engine.getState())
        })

        const destPath = join(dlDir, destName || `downloaded-${Date.now()}-${fileName}`)
        console.log(`[VM-PEER] Starting reverse download of ${fileName} to ${destPath}`)
        const dlRes = await engine.download(GROUP_KEY, searchRes.resultId, destPath)
        if (!dlRes.ok) {
          throw new Error(`Reverse download start failed: ${dlRes.code} ${dlRes.message}`)
        }

        // Locate transferId
        const transferId = await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => {
            unsub()
            reject(new Error('Reverse transfer creation timeout'))
          }, 10000)
          const check = (s: MultiGroupP2pState) => {
            const t = s.transfers.find(
              (x) =>
                x.direction === 'download' &&
                x.fileName === fileName &&
                (x.state === 'connecting' || x.state === 'transferring' || x.state === 'verifying' || x.state === 'completed')
            )
            if (t) {
              clearTimeout(timeout)
              unsub()
              resolve(t.id)
            }
          }
          const unsub = engine.subscribe(check)
          check(engine.getState())
        })

        let interruptedBytes = 0
        if (typeof interruptAtBytes === 'number' && interruptAtBytes > 0) {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              unsub()
              reject(new Error('Timeout waiting for partial reverse download'))
            }, 30000)
            const check = (s: MultiGroupP2pState) => {
              const t = s.transfers.find((x) => x.id === transferId)
              if (t && t.transferredBytes >= interruptAtBytes && t.state === 'transferring') {
                clearTimeout(timeout)
                unsub()
                resolve()
              } else if (t?.state === 'failed') {
                clearTimeout(timeout)
                unsub()
                reject(new Error(`Reverse download failed before interrupt threshold: ${t.message}`))
              }
            }
            const unsub = engine.subscribe(check)
            check(engine.getState())
          })

          const closed = engine.forceCloseTransferChannel(transferId)
          if (!closed) throw new Error('Failed to force-close reverse transfer channel')

          const failedTransfer = await new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(() => {
              unsub()
              reject(new Error('Timeout waiting for failed reverse transfer state'))
            }, 15000)
            const check = (s: MultiGroupP2pState) => {
              const t = s.transfers.find((x) => x.id === transferId)
              if (t?.state === 'failed' && t.canResume) {
                clearTimeout(timeout)
                unsub()
                resolve(t)
              }
            }
            const unsub = engine.subscribe(check)
            check(engine.getState())
          })
          interruptedBytes = failedTransfer.transferredBytes

          const partPath = join(dlDir, `.p2p-multiple-groups-${transferId}.part`)
          const partStat = await stat(partPath)
          if (partStat.size < interruptAtBytes) {
            throw new Error(`Expected .part >= ${interruptAtBytes}, got ${partStat.size}`)
          }

          if (resumeAfterInterrupt) {
            // Immediate resume without artificial delay
            const resumeRes = await engine.resumeTransfer(transferId)
            if (!resumeRes.ok) {
              throw new Error(`Reverse resumeTransfer failed: ${resumeRes.code} ${resumeRes.message}`)
            }
          } else {
            res.writeHead(200)
            res.end(JSON.stringify({ ok: true, interrupted: true, transferId, interruptedBytes, partSize: partStat.size }))
            return
          }
        }

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            unsub()
            reject(new Error('Reverse download completion timeout'))
          }, 60000)
          const check = (s: MultiGroupP2pState) => {
            const t = s.transfers.find((x) => x.id === transferId)
            if (t?.state === 'completed') {
              clearTimeout(timeout)
              unsub()
              resolve()
            } else if (t?.state === 'failed') {
              clearTimeout(timeout)
              unsub()
              reject(new Error(`Reverse download failed: ${t.message}`))
            }
          }
          const unsub = engine.subscribe(check)
          check(engine.getState())
        })

        const downloadedContent = await readFile(destPath)
        const downloadedReverseSha = createHash('sha256').update(downloadedContent).digest('hex')
        console.log(`[VM-PEER] Reverse download complete (${downloadedContent.length} bytes). SHA-256: ${downloadedReverseSha}`)

        res.writeHead(200)
        res.end(
          JSON.stringify({
            ok: true,
            transferId,
            interruptedBytes,
            sha256: downloadedReverseSha,
            size: downloadedContent.length
          })
        )
        return
      }

      if (req.method === 'POST' && url.pathname === '/shutdown') {
        console.log('[VM-PEER] Shutting down...')
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true }))
        setTimeout(async () => {
          controlServer.close()
          await engine.dispose()
          await signalingServer.close()
          await rm(workDir, { recursive: true, force: true }).catch(() => {})
          process.exit(0)
        }, 300)
        return
      }

      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Not found' }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[VM-PEER] Request error:', msg)
      res.writeHead(500)
      res.end(JSON.stringify({ ok: false, error: msg }))
    }
  })

  controlServer.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`[VM-PEER] Control server ready on http://0.0.0.0:${HTTP_PORT}`)
  })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

main().catch((err) => {
  console.error('[VM-PEER] Fatal error:', err)
  process.exit(1)
})
