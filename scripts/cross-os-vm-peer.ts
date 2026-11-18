import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
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

async function main() {
  const HTTP_PORT = 8766
  const SIGNAL_PORT = 8765
  const GROUP_ID = 'cross-os-test-group'
  const TOKEN = Buffer.alloc(32, 42).toString('base64url')
  const VM_HOST = process.env.VM_PEER_HOST || '192.168.123.128'
  const SIGNAL_URL = `ws://${VM_HOST}:${SIGNAL_PORT}/signal`
  const GROUP_KEY = makeGroupKey(SIGNAL_URL, GROUP_ID)

  console.log('[VM-PEER] Initializing Cross-OS Linux Peer...')

  // 1. Prepare temp dirs and test files
  const workDir = await mkdtemp(join(tmpdir(), 'cross-os-linux-'))
  const filesDir = join(workDir, 'shared')
  const dlDir = join(workDir, 'downloads')
  const dataDir = join(workDir, 'engine-data')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(filesDir, { recursive: true })
  await mkdir(dlDir, { recursive: true })

  // 512 KB complete test file
  const file1Data = randomBytes(512 * 1024)
  const file1Sha = createHash('sha256').update(file1Data).digest('hex')
  const file1Path = join(filesDir, 'file-complete.bin')
  await writeFile(file1Path, file1Data)

  // 4 MB resumable test file
  const file2Data = randomBytes(4 * 1024 * 1024)
  const file2Sha = createHash('sha256').update(file2Data).digest('hex')
  const file2Path = join(filesDir, 'file-resumable.bin')
  await writeFile(file2Path, file2Data)

  const testFiles: Record<string, TestFileInfo> = {
    'file-complete.bin': { name: 'file-complete.bin', path: file1Path, size: file1Data.length, sha256: file1Sha },
    'file-resumable.bin': { name: 'file-resumable.bin', path: file2Path, size: file2Data.length, sha256: file2Sha }
  }

  // 2. Start signaling server
  const signalingServer: SignalingServerInstance = await createSignalingServer({
    host: '0.0.0.0',
    port: SIGNAL_PORT,
    groups: [{ groupId: GROUP_ID, token: TOKEN }]
  })
  console.log(`[VM-PEER] Signaling server listening on ws://0.0.0.0:${SIGNAL_PORT}/signal`)

  // 3. Start PeerEngine
  const engine: PeerEngine = await createPeerEngine({ dataDirectory: dataDir })
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

  // Share files
  await engine.addFiles(GROUP_KEY, [file1Path, file2Path])

  console.log('[VM-PEER] Files shared in group. Waiting for catalog advertisement...')
  // Wait for catalog ack
  await new Promise<void>((resolve) => {
    const unsub = engine.subscribe((s: MultiGroupP2pState) => {
      const g = s.groups.find((x) => x.groupKey === GROUP_KEY)
      if (
        g?.catalog.acknowledgedGeneration !== null &&
        g?.catalog.acknowledgedGeneration === g?.catalog.advertisedGeneration &&
        s.library.files.filter((f) => f.status === 'shared').length >= 2
      ) {
        unsub()
        resolve()
      }
    })
  })
  console.log('[VM-PEER] Catalog advertised and acknowledged.')

  let downloadedReverseSha: string | null = null

  // 4. Start HTTP Control API on port 8766
  const controlServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Content-Type', 'application/json')
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    if (req.method === 'GET' && url.pathname === '/status') {
      const state = engine.getState()
      const group = state.groups.find((g) => g.groupKey === GROUP_KEY)
      res.writeHead(200)
      res.end(
        JSON.stringify({
          ready: true,
          peerId: state.identity.peerId,
          groupKey: GROUP_KEY,
          groupId: GROUP_ID,
          token: TOKEN,
          signalingUrl: SIGNAL_URL,
          peersConnected: group?.network.members.length ?? 0,
          role: group?.network.role,
          primaryPeerId: group?.network.primaryPeerId,
          links: group?.network.links.map((l) => ({ peerId: l.peerId, state: l.state, path: l.path })),
          libraryFiles: state.library.files.map((f) => ({ name: f.name, status: f.status, groupKeys: f.groupKeys })),
          groupCatalog: group?.catalog,
          files: testFiles,
          transfers: state.transfers.map((t) => ({
            id: t.id,
            name: t.fileName,
            direction: t.direction,
            state: t.state,
            transferred: t.transferredBytes,
            total: t.size
          }))
        })
      )
      return
    }

    if (req.method === 'GET' && url.pathname === '/debug-search') {
      const q = url.searchParams.get('q') || 'file-complete'
      await engine.search(GROUP_KEY, q)
      // Wait for search to complete on supernode
      await new Promise<void>((resolve) => {
        const unsub = engine.subscribe((s) => {
          const g = s.groups.find((x) => x.groupKey === GROUP_KEY)
          if (g?.search.status === 'complete' || g?.search.status === 'error') {
            unsub()
            resolve()
          }
        })
      })
      const g = engine.getState().groups.find((x) => x.groupKey === GROUP_KEY)
      res.writeHead(200)
      res.end(JSON.stringify({ query: q, search: g?.search }))
      return
    }

    if (req.method === 'POST' && url.pathname === '/unshare') {
      const body = await readBody(req)
      const { name } = JSON.parse(body)
      const file = engine.getState().library.files.find((f) => f.name === name)
      if (file) {
        await engine.removeFile(file.fileId)
        console.log(`[VM-PEER] Unshared file ${name} (${file.fileId})`)
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true, unshared: name }))
      } else {
        res.writeHead(404)
        res.end(JSON.stringify({ ok: false, error: 'File not found' }))
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/reverse-download') {
      const body = await readBody(req)
      const { fileName } = JSON.parse(body)
      console.log(`[VM-PEER] Searching for reverse download: ${fileName}`)
      await engine.search(GROUP_KEY, fileName)

      // Wait for search result
      const searchRes = await new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Reverse search timeout')), 15000)
        const unsub = engine.subscribe((s) => {
          const g = s.groups.find((x) => x.groupKey === GROUP_KEY)
          const found = g?.search.results.find((r) => r.file.name === fileName)
          if (found) {
            clearTimeout(timeout)
            unsub()
            resolve(found)
          }
        })
      })

      const destPath = join(dlDir, `downloaded-${fileName}`)
      console.log(`[VM-PEER] Starting reverse download to ${destPath}`)
      await engine.download(GROUP_KEY, searchRes.resultId, destPath)

      // Wait for completion
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Reverse download timeout')), 30000)
        const unsub = engine.subscribe((s) => {
          const t = s.transfers.find((x) => x.fileName === fileName)
          if (t?.state === 'completed') {
            clearTimeout(timeout)
            unsub()
            resolve()
          } else if (t?.state === 'failed') {
            clearTimeout(timeout)
            unsub()
            reject(new Error(`Reverse download failed: ${t.message}`))
          }
        })
      })

      const downloadedContent = await readFile(destPath)
      downloadedReverseSha = createHash('sha256').update(downloadedContent).digest('hex')
      console.log(`[VM-PEER] Reverse download complete. SHA-256: ${downloadedReverseSha}`)

      res.writeHead(200)
      res.end(JSON.stringify({ ok: true, sha256: downloadedReverseSha, size: downloadedContent.length }))
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
      }, 500)
      return
    }

    res.writeHead(404)
    res.end(JSON.stringify({ error: 'Not found' }))
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
