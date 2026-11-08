import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { randomUUID, createHash } from 'node:crypto'
import electron from 'electron'
import WebSocket from 'ws'
import { createMultiGroupPeerStore } from '../src/main/p2p/peer-store.ts'
import { createSignalingServer } from '../services/signaling/server.ts'
import { createPeerEngine, type PeerEngine } from '../src/main/p2p/engine.ts'
import { makeGroupKey } from '../src/shared/p2p.ts'

const electronPath = (electron as unknown as string) || 'electron'

async function getFreePort(): Promise<number> {
  const srv = createServer()
  const { promise, resolve, reject } = Promise.withResolvers<number>()
  srv.listen(0, '127.0.0.1', () => {
    const addr = srv.address()
    if (addr && typeof addr === 'object') {
      srv.close(() => resolve(addr.port))
    } else {
      srv.close(() => reject(new Error('Failed to obtain free port')))
    }
  })
  srv.on('error', reject)
  return promise
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

interface CdpClient {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  evaluate<T = unknown>(expression: string): Promise<T>
  close(): Promise<void>
}

async function connectToCdp(webSocketDebuggerUrl: string): Promise<CdpClient> {
  const ws = new WebSocket(webSocketDebuggerUrl)
  const { promise: openPromise, resolve: resolveOpen } = Promise.withResolvers<void>()
  ws.on('open', () => resolveOpen())
  await openPromise

  let idCounter = 1
  const pending = new Map<number, { resolve: (val: unknown) => void; reject: (err: Error) => void }>()

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const p = pending.get(msg.id)!
        pending.delete(msg.id)
        if (msg.error) {
          p.reject(new Error(msg.error.message || 'CDP Error'))
        } else {
          p.resolve(msg.result)
        }
      }
    } catch {
      // ignore parse errors
    }
  })

  const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    const id = idCounter++
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    return promise
  }

  const evaluate = async <T = unknown>(expression: string): Promise<T> => {
    const res = (await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })) as { result?: { value?: T } }
    return res.result?.value as T
  }

  return {
    send,
    evaluate,
    close: async () => {
      ws.close()
    }
  }
}

async function captureView(
  cdp: CdpClient,
  navName: string,
  outPath: string
): Promise<void> {
  console.log(`[Docs Screenshot] Navigating to ${navName}...`)
  await cdp.evaluate(`new Promise(resolve => {
    const btn = Array.from(document.querySelectorAll('.nav-link')).find(b => (b.textContent || '').includes('${navName}'));
    if (btn) {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
    setTimeout(resolve, 500);
  })`)

  // Wait extra time for React render and CSS transition stabilization
  await delay(400)

  console.log(`[Docs Screenshot] Capturing ${navName} -> ${outPath}`)
  const res = (await cdp.send('Page.captureScreenshot', {
    format: 'png'
  })) as { data: string }

  const buffer = Buffer.from(res.data, 'base64')
  await writeFile(outPath, buffer)
  console.log(`[Docs Screenshot] Wrote ${outPath} (${buffer.length} bytes)`)
}

async function main(): Promise<void> {
  const assetsDir = join(process.cwd(), 'docs', 'assets')
  await mkdir(assetsDir, { recursive: true })

  const dirApp = await mkdtemp(join(tmpdir(), 'docs-app-'))
  const dirPeer = await mkdtemp(join(tmpdir(), 'docs-peer-'))
  const tempDirs = [dirApp, dirPeer]
  const children: ChildProcess[] = []
  let headlessPeer: PeerEngine | null = null
  let cdp: CdpClient | null = null

  try {
    const testGroupId = 'engineering-team'
    const testToken = Buffer.alloc(32, 101).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [{ groupId: testGroupId, token: testToken }]
    })
    const signalingUrl = `ws://127.0.0.1:${server.address.port}/signal`
    const groupKey = makeGroupKey(signalingUrl, testGroupId)

    // Pre-seed shared files in app
    const file1Content = Buffer.alloc(48 * 1024, 65) // 48 KiB
    const file1Path = join(dirApp, 'distributed-systems-whitepaper.pdf')
    await writeFile(file1Path, file1Content)

    const file2Content = Buffer.alloc(16 * 1024, 66) // 16 KiB
    const file2Path = join(dirApp, 'p2p-webrtc-rfc-spec.md')
    await writeFile(file2Path, file2Content)

    const appStore = await createMultiGroupPeerStore(dirApp)
    await appStore.setDisplayName('P2P Core Architect')

    await appStore.upsertGroup({
      groupKey,
      signalingUrl,
      groupId: testGroupId,
      supernodeEligible: true,
      autoJoin: true,
      credentialCiphertext: null
    })

    await appStore.addSharedFile({
      fileId: randomUUID(),
      path: file1Path,
      groupKeys: [groupKey]
    })
    await appStore.addSharedFile({
      fileId: randomUUID(),
      path: file2Path,
      groupKeys: [groupKey]
    })

    // Pre-seed file on headless peer
    const peerFileContent = Buffer.alloc(32 * 1024, 77)
    const peerFilePath = join(dirPeer, 'cluster-consensus-raft-paper.pdf')
    await writeFile(peerFilePath, peerFileContent)

    const peerStore = await createMultiGroupPeerStore(dirPeer)
    await peerStore.setDisplayName('Peer-Node-Beta')
    await peerStore.addSharedFile({
      fileId: randomUUID(),
      path: peerFilePath,
      groupKeys: [groupKey]
    })

    // Launch Electron with CDP
    const cdpPort = await getFreePort()
    console.log(`[Docs Screenshot] Spawning Electron with CDP on port ${cdpPort}...`)
    const child = spawn(
      electronPath,
      ['.', `--data-dir=${dirApp}`, `--remote-debugging-port=${cdpPort}`],
      {
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
      }
    )
    children.push(child)

    // Wait for CDP readiness
    let tabs: Array<{ webSocketDebuggerUrl?: string }> = []
    for (let i = 0; i < 40; i++) {
      await delay(250)
      try {
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json`)
        tabs = await res.json()
        if (tabs.length > 0 && tabs[0].webSocketDebuggerUrl) break
      } catch {
        // retry
      }
    }

    if (!tabs.length || !tabs[0].webSocketDebuggerUrl) {
      throw new Error('Electron CDP target not found')
    }

    cdp = await connectToCdp(tabs[0].webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 820,
      deviceScaleFactor: 1,
      mobile: false
    })

    // Connect app to group via window.p2p.p2p.joinGroup
    console.log('[Docs Screenshot] Joining group from Electron UI...')
    await cdp.evaluate(`
      window.p2p.p2p.joinGroup({
        invitation: { version: 2, signalingUrl: '${signalingUrl}', groupId: '${testGroupId}', token: '${testToken}' },
        displayName: 'P2P Core Architect',
        supernodeEligible: true,
        relayOnly: false,
        rememberInvitation: true,
        autoJoin: true
      })
    `)

    // Start headless peer
    console.log('[Docs Screenshot] Starting headless peer...')
    headlessPeer = await createPeerEngine({ dataDirectory: dirPeer })
    await headlessPeer.joinGroup({
      invitation: { version: 2, signalingUrl, groupId: testGroupId, token: testToken },
      displayName: 'Peer-Node-Beta',
      supernodeEligible: false,
      relayOnly: false,
      rememberInvitation: false,
      autoJoin: false
    })

    // Wait for mesh connection
    console.log('[Docs Screenshot] Awaiting mesh connection...')
    const { promise: meshPromise, resolve: resolveMesh } = Promise.withResolvers<void>()
    const checkMesh = () => {
      const g = headlessPeer?.getState().groups.find((gr) => gr.groupKey === groupKey)
      if (g && g.network.links.some((l) => l.state === 'open')) {
        resolveMesh()
      } else {
        setTimeout(checkMesh, 200)
      }
    }
    checkMesh()
    await Promise.race([meshPromise, delay(8000)])

    // Headless peer downloads a file from app to populate transfers
    try {
      console.log('[Docs Screenshot] Initiating headless peer search and transfer...')
      const { promise: searchPromise, resolve: resolveSearch } = Promise.withResolvers<void>()
      const unsub = headlessPeer.subscribe((st) => {
        const g = st.groups.find((gr) => gr.groupKey === groupKey)
        if (g && g.search.results.length > 0) {
          unsub()
          resolveSearch()
        }
      })
      await headlessPeer.search(groupKey, 'whitepaper')
      await Promise.race([searchPromise, delay(5000)])

      const resList = headlessPeer.getState().groups.find((g) => g.groupKey === groupKey)?.search.results
      if (resList && resList.length > 0) {
        const dest = join(dirPeer, 'downloaded-whitepaper.pdf')
        await headlessPeer.download(groupKey, resList[0].resultId, dest)
        await delay(1500)
      }
    } catch (err) {
      console.warn('[Docs Screenshot] Non-critical transfer prep warning:', err)
    }

    // App searches for paper to populate search view
    try {
      await cdp.evaluate(`
        window.p2p.p2p.search('${groupKey}', 'consensus')
      `)
      await delay(1000)
    } catch (err) {
      console.warn('[Docs Screenshot] Non-critical search prep warning:', err)
    }

    // Now capture all required views
    await captureView(cdp, 'Home', join(assetsDir, 'home-view.png'))
    await captureView(cdp, 'Network', join(assetsDir, 'network-view.png'))
    await captureView(cdp, 'Library', join(assetsDir, 'library-view.png'))
    await captureView(cdp, 'Search', join(assetsDir, 'search-view.png'))
    await captureView(cdp, 'Transfers', join(assetsDir, 'transfers-view.png'))
    await captureView(cdp, 'Appearance', join(assetsDir, 'appearance-view.png'))

    console.log('[Docs Screenshot] All views captured successfully!')
    await server.close()
  } finally {
    if (cdp) {
      await cdp.close().catch(() => {})
    }
    if (headlessPeer) {
      await headlessPeer.dispose().catch(() => {})
    }
    for (const c of children) {
      try {
        c.kill()
      } catch {
        // ignore
      }
    }
    for (const d of tempDirs) {
      await rm(d, { recursive: true, force: true }).catch(() => {})
    }
  }
}

main().catch((err) => {
  console.error('[Docs Screenshot Error]:', err)
  process.exit(1)
})
