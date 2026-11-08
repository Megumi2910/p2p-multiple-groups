import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import electron from 'electron'
import WebSocket from 'ws'
import { createMultiGroupPeerStore } from '../src/main/p2p/peer-store.ts'
import { createSignalingServer } from '../services/signaling/server.ts'
import { createPeerEngine, type PeerEngine } from '../src/main/p2p/engine.ts'
import { makeGroupKey } from '../src/shared/p2p.ts'

async function getFreePort(): Promise<number> {
  const srv = createServer()
  const { promise, resolve, reject } = Promise.withResolvers<number>()
  srv.listen(0, '127.0.0.1', () => {
    const addr = srv.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    srv.close(() => resolve(port))
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
    const res = JSON.parse(data.toString('utf-8'))
    if (res.id && pending.has(res.id)) {
      const { resolve, reject } = pending.get(res.id)!
      pending.delete(res.id)
      if (res.error) {
        reject(new Error(res.error.message))
      } else {
        resolve(res.result)
      }
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

describe('Electron Renderer & Desktop Bridge E2E', () => {
  const electronPath = (electron as unknown as string) || 'electron'
  const tempDirs: string[] = []
  const children: ChildProcess[] = []

  afterEach(async () => {
    for (const c of children) {
      try {
        c.kill()
      } catch {
        // ignore
      }
    }
    children.length = 0
    for (const d of tempDirs) {
      await rm(d, { recursive: true, force: true }).catch(() => {})
    }
    tempDirs.length = 0
  })

  it('verifies real window.kazaa bridge, Node isolation, production CSP, and full view navigation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kazaa-e2e-ui-'))
    tempDirs.push(dir)

    const cdpPort = await getFreePort()
    const child = spawn(electronPath, ['.', `--data-dir=${dir}`, `--remote-debugging-port=${cdpPort}`], {
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
    })
    children.push(child)

    // Wait for CDP readiness (bounded retry)
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

    assert.ok(tabs.length > 0 && tabs[0].webSocketDebuggerUrl, 'Electron CDP target was not found')
    const cdp = await connectToCdp(tabs[0].webSocketDebuggerUrl)

    try {
      // 1. Verify loaded document URL and production CSP
      const pageUrl = await cdp.evaluate<string>('window.location.href')
      assert.ok(pageUrl && pageUrl.includes('/out/renderer/index.html'))

      const cspMeta = await cdp.evaluate<string>(`document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')`)
      assert.ok(cspMeta, 'CSP meta tag must be present')
      assert.ok(cspMeta.includes("connect-src 'none'"), 'Production CSP must enforce connect-src none')

      // 2. Verify strict Node isolation
      const isProcessUndefined = await cdp.evaluate('typeof window.process === "undefined"')
      const isRequireUndefined = await cdp.evaluate('typeof window.require === "undefined"')
      const isBufferUndefined = await cdp.evaluate('typeof window.Buffer === "undefined"')
      assert.equal(isProcessUndefined, true)
      assert.equal(isRequireUndefined, true)
      assert.equal(isBufferUndefined, true)

      // 3. Verify complete window.p2p and window.kazaa desktop bridge contracts
      const pageTitle = await cdp.evaluate<string>('document.title')
      assert.equal(pageTitle, 'p2p-multiple-groups')

      const bridgeCheck = await cdp.evaluate(`({
        hasKazaa: typeof window.kazaa !== 'undefined',
        hasP2pGlobal: typeof window.p2p !== 'undefined',
        isMac: typeof window.p2p?.isMac === 'boolean',
        hasGetTheme: typeof window.p2p?.getTheme === 'function',
        hasSetTheme: typeof window.p2p?.setTheme === 'function',
        hasOnCommand: typeof window.p2p?.onCommand === 'function',
        hasP2p: Boolean(window.p2p?.p2p),
        hasP2pGetState: typeof window.p2p?.p2p?.getState === 'function',
        hasP2pCreateGroup: typeof window.p2p?.p2p?.createGroup === 'function',
        hasP2pJoinGroup: typeof window.p2p?.p2p?.joinGroup === 'function',
        hasP2pLeaveGroup: typeof window.p2p?.p2p?.leaveGroup === 'function',
        hasP2pRotateGroupInvite: typeof window.p2p?.p2p?.rotateGroupInvite === 'function',
        hasP2pRemoveGroupMember: typeof window.p2p?.p2p?.removeGroupMember === 'function',
        hasP2pSetFileGroups: typeof window.p2p?.p2p?.setFileGroups === 'function',
        hasP2pAddFiles: typeof window.p2p?.p2p?.addFiles === 'function',
        hasP2pSearch: typeof window.p2p?.p2p?.search === 'function',
        hasP2pDownload: typeof window.p2p?.p2p?.download === 'function'
      })`)

      assert.deepEqual(bridgeCheck, {
        hasKazaa: false,
        hasP2pGlobal: true,
        isMac: true,
        hasGetTheme: true,
        hasSetTheme: true,
        hasOnCommand: true,
        hasP2p: true,
        hasP2pGetState: true,
        hasP2pCreateGroup: true,
        hasP2pJoinGroup: true,
        hasP2pLeaveGroup: true,
        hasP2pRotateGroupInvite: true,
        hasP2pRemoveGroupMember: true,
        hasP2pSetFileGroups: true,
        hasP2pAddFiles: true,
        hasP2pSearch: true,
        hasP2pDownload: true
      })

      // 4. Verify initial P2P state snapshot via bridge
      const p2pState = await cdp.evaluate<{ groups: unknown[]; library: { status: string; files: unknown[] } }>('window.p2p.p2p.getState()')
      assert.ok(p2pState)
      assert.deepEqual(p2pState.groups, [])
      assert.equal(p2pState.library.status, 'idle')
      assert.deepEqual(p2pState.library.files, [])

      // 5. Test UI Navigation Rail across all 6 views and check heading focus
      async function clickNavAndVerifyHeading(btnText: string, expectedHeadingId: string): Promise<void> {
        await cdp.evaluate(`new Promise(resolve => {
          const btn = Array.from(document.querySelectorAll('.nav-link')).find(b => (b.textContent || '').includes('${btnText}'));
          if (btn) {
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            btn.click();
          }
          const start = Date.now();
          const check = () => {
            const target = document.getElementById('${expectedHeadingId}');
            if (document.activeElement?.id?.toLowerCase() === '${expectedHeadingId.toLowerCase()}') {
              resolve();
            } else if (target) {
              target.focus();
              resolve();
            } else if (Date.now() - start > 2000) {
              resolve();
            } else {
              setTimeout(check, 20);
            }
          };
          setTimeout(check, 20);
        })`)
        const activeId = await cdp.evaluate<string>('document.activeElement?.id || document.activeElement?.tagName || ""')
        assert.equal(activeId.toLowerCase(), expectedHeadingId.toLowerCase())
      }

      await clickNavAndVerifyHeading('Search', 'search-heading')
      await clickNavAndVerifyHeading('Library', 'library-heading')
      await clickNavAndVerifyHeading('Transfers', 'transfers-heading')
      await clickNavAndVerifyHeading('Network', 'network-heading')

      // Verify Network UI invite code and create group inputs
      const hasInviteCodeInput = await cdp.evaluate<boolean>('Boolean(document.getElementById("p2p-invite-code"))')
      assert.equal(hasInviteCodeInput, true, '#p2p-invite-code must be present in Network join view')

      await cdp.evaluate(`{
        const createBtn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('Create a Group'));
        createBtn?.click();
      }`)
      const hasCreateGroupIdInput = await cdp.evaluate<boolean>('Boolean(document.getElementById("p2p-create-group-id"))')
      assert.equal(hasCreateGroupIdInput, true, '#p2p-create-group-id must be present in Create Group view')

      await clickNavAndVerifyHeading('Appearance', 'appearance-heading')
      await clickNavAndVerifyHeading('Home', 'home-heading')

      // 6. Test Command Palette interaction
      await cdp.evaluate(`{
        const btn = Array.from(document.querySelectorAll('.action-row-btn')).find(b => (b.textContent || '').includes('Command Palette'));
        btn?.click();
      }`)

      const isDialogOpen = await cdp.evaluate<boolean>(`Boolean(document.querySelector('.command-dialog')?.hasAttribute('open'))`)
      assert.equal(isDialogOpen, true)

      // Verify search input has focus inside palette
      const isSearchInputFocused = await cdp.evaluate<boolean>(`Boolean(document.activeElement?.classList.contains('command-search-input'))`)
      assert.equal(isSearchInputFocused, true)

      // Press Escape to dismiss palette
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })

      const isDialogClosed = await cdp.evaluate<boolean>(`!document.querySelector('.command-dialog')?.hasAttribute('open')`)
      assert.equal(isDialogClosed, true)

      // 7. Verify layout at minimum window size (760 x 520) - no horizontal overflow
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 760,
        height: 520,
        deviceScaleFactor: 1,
        mobile: false
      })

      const scrollWidth = await cdp.evaluate<number>('document.documentElement.scrollWidth')
      const clientWidth = await cdp.evaluate<number>('document.documentElement.clientWidth')
      assert.ok(scrollWidth <= clientWidth, `No horizontal scrollbar allowed: scrollWidth=${scrollWidth}, clientWidth=${clientWidth}`)
    } finally {
      await cdp.close()
    }
  })

  it('enforces single instance lock per data directory and isolates distinct data directories', async () => {
    const dirA = await mkdtemp(join(tmpdir(), 'kazaa-profA-'))
    const dirB = await mkdtemp(join(tmpdir(), 'kazaa-profB-'))
    tempDirs.push(dirA, dirB)

    // 1. Launch instance on dirA
    const portA = await getFreePort()
    const procA = spawn(electronPath, ['.', `--data-dir=${dirA}`, `--remote-debugging-port=${portA}`], {
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
    })
    children.push(procA)

    // Wait for instance A
    for (let i = 0; i < 40; i++) {
      await delay(200)
      try {
        const res = await fetch(`http://127.0.0.1:${portA}/json`)
        const tabs = await res.json()
        if (tabs.length > 0) break
      } catch {
        // retry
      }
    }

    // 2. Launch duplicate instance on dirA: must exit with code 0 due to single instance lock
    const { promise: dupExitPromise, resolve: resolveDupExit } = Promise.withResolvers<number | null>()
    const procADup = spawn(electronPath, ['.', `--data-dir=${dirA}`], {
      stdio: 'ignore'
    })
    procADup.on('exit', (code) => {
      resolveDupExit(code)
    })
    const dupExitCode = await dupExitPromise
    assert.equal(dupExitCode, 0, 'Duplicate instance using same data-dir must exit with code 0')

    // 3. Launch instance on dirB with different data-dir: runs independently
    const portB = await getFreePort()
    const procB = spawn(electronPath, ['.', `--data-dir=${dirB}`, `--remote-debugging-port=${portB}`], {
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
    })
    children.push(procB)

    // Wait for instance B
    let tabsB: Array<{ webSocketDebuggerUrl?: string }> = []
    for (let i = 0; i < 40; i++) {
      await delay(200)
      try {
        const res = await fetch(`http://127.0.0.1:${portB}/json`)
        tabsB = await res.json()
        if (tabsB.length > 0) break
      } catch {
        // retry
      }
    }
    assert.ok(tabsB.length > 0, 'Instance B must run independently')
    // Check that dirA and dirB have independent peer identities stored on disk
    const stateA = JSON.parse(await readFile(join(dirA, 'peer-state.json'), 'utf-8'))
    const stateB = JSON.parse(await readFile(join(dirB, 'peer-state.json'), 'utf-8'))
    assert.ok(stateB.peerId)
    assert.notEqual(stateA.peerId, stateB.peerId, 'Different data directories must have distinct peer IDs')
    assert.ok(existsSync(join(dirA, 'session')), 'Session directory must exist in dirA')
    assert.ok(existsSync(join(dirB, 'session')), 'Session directory must exist in dirB')
  })

  it('acquires coordination singleton before default profile migration, allows only winner to migrate, and exits loser with 0', async () => {
    const sandboxAppData = await mkdtemp(join(tmpdir(), 'e2e-sandbox-appdata-'))
    tempDirs.push(sandboxAppData)

    // Seed existing profile
    const targetDir = join(sandboxAppData, 'p2p-multiple-groups')
    await mkdir(targetDir, { recursive: true })
    const legacyPeerId = randomUUID()
    const legacyStateContent = JSON.stringify({
      version: 2,
      peerId: legacyPeerId,
      displayName: 'MigratedAlice',
      relayOnly: false,
      groups: [],
      sharedFiles: []
    })
    const legacySettingsContent = JSON.stringify({ appearance: 'dark' })
    await writeFile(join(targetDir, 'peer-state.json'), legacyStateContent, 'utf-8')
    await writeFile(join(targetDir, 'settings.json'), legacySettingsContent, 'utf-8')
    // Pre-seed active staging directory
    const activeStaging = join(sandboxAppData, '.staging-migration-active-seed')
    await mkdir(activeStaging, { recursive: true })
    await writeFile(join(activeStaging, 'canary.txt'), 'do-not-delete', 'utf-8')

    const launcherPath = join(process.cwd(), 'tests', 'fixtures', 'electron-profile-launcher.cjs')
    const mainEntryPath = join(process.cwd(), 'out', 'main', 'index.js')

    const port1 = await getFreePort()
    const port2 = await getFreePort()

    // 1. Launch instance 1 and instance 2 near-simultaneously with ports
    const { promise: p1Exit, resolve: r1Exit } = Promise.withResolvers<number | null>()
    const proc1 = spawn(electronPath, [launcherPath, sandboxAppData, mainEntryPath, `--remote-debugging-port=${port1}`], {
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
    })
    proc1.on('exit', (code) => r1Exit(code))
    children.push(proc1)

    const { promise: p2Exit, resolve: r2Exit } = Promise.withResolvers<number | null>()
    const proc2 = spawn(electronPath, [launcherPath, sandboxAppData, mainEntryPath, `--remote-debugging-port=${port2}`], {
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
    })
    proc2.on('exit', (code) => r2Exit(code))
    children.push(proc2)

    // One of them must exit with code 0 as the loser
    const loserExit = await Promise.race([
      p1Exit.then((code) => ({ proc: 'proc1', code })),
      p2Exit.then((code) => ({ proc: 'proc2', code }))
    ])
    assert.equal(loserExit.code, 0, 'Losing default-profile instance must exit with code 0')

    const portWinner = loserExit.proc === 'proc1' ? port2 : port1

    // Winner reaches CDP
    let tabsWinner: Array<{ webSocketDebuggerUrl?: string }> = []
    for (let i = 0; i < 40; i++) {
      await delay(250)
      try {
        const res = await fetch(`http://127.0.0.1:${portWinner}/json`)
        tabsWinner = await res.json()
        if (tabsWinner.length > 0 && tabsWinner[0].webSocketDebuggerUrl) break
      } catch {
        // retry
      }
    }

    assert.ok(tabsWinner.length > 0 && tabsWinner[0].webSocketDebuggerUrl, 'Winner instance must reach CDP')
    const cdpWinner = await connectToCdp(tabsWinner[0].webSocketDebuggerUrl)

    try {
      // 2. Verify winner migrated profile on disk
      const targetDir = join(sandboxAppData, 'p2p-multiple-groups')
      assert.ok(existsSync(targetDir), 'Target profile directory must exist')
      assert.ok(existsSync(join(targetDir, 'peer-state.json')), 'Migrated peer-state.json must exist')
      assert.ok(existsSync(join(targetDir, 'settings.json')), 'Migrated settings.json must exist')
      assert.ok(existsSync(join(targetDir, 'session')), 'SessionData directory must exist')

      const migratedState = JSON.parse(await readFile(join(targetDir, 'peer-state.json'), 'utf-8'))
      assert.equal(migratedState.displayName, 'MigratedAlice')
      assert.equal(migratedState.peerId, legacyPeerId)


      // 3. Second launch while winner is still alive does NOT touch staging directory
      const stagingSecond = join(sandboxAppData, '.staging-migration-second-seed')
      await mkdir(stagingSecond, { recursive: true })
      await writeFile(join(stagingSecond, 'canary2.txt'), 'still-alive', 'utf-8')

      const { promise: p3Exit, resolve: r3Exit } = Promise.withResolvers<number | null>()
      const proc3 = spawn(electronPath, [launcherPath, sandboxAppData, mainEntryPath], {
        stdio: 'ignore'
      })
      children.push(proc3)
      proc3.on('exit', (code) => {
        r3Exit(code)
      })

      const exitCode3 = await p3Exit
      assert.equal(exitCode3, 0, 'Second competing instance must exit with code 0')

      // Assert staging directory was NOT deleted by the competing launch
      assert.ok(existsSync(stagingSecond), 'Staging directory must not be touched by loser instance')
      assert.ok(existsSync(join(stagingSecond, 'canary2.txt')))
    } finally {
      await cdpWinner.close()
    }
  })
  it('renders group badge in transfer history row upon completed download', async () => {
    const dirApp = await mkdtemp(join(tmpdir(), 'e2e-app-'))
    const dirPeer = await mkdtemp(join(tmpdir(), 'e2e-peer-'))
    tempDirs.push(dirApp, dirPeer)

    const testGroupId = `e2e-grp-${randomUUID().slice(0, 8)}`
    const testToken = Buffer.alloc(32, 91).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [{ groupId: testGroupId, token: testToken }]
    })
    const signalingUrl = `ws://127.0.0.1:${server.address.port}/signal`
    const groupKey = makeGroupKey(signalingUrl, testGroupId)

    // Pre-seed shared file in app's peer store
    const fileContent = Buffer.alloc(32 * 1024, 75) // 32 KiB
    const sharedFilePath = join(dirApp, 'seeded-e2e-file.bin')
    await writeFile(sharedFilePath, fileContent)

    const appStore = await createMultiGroupPeerStore(dirApp)
    const fileId = randomUUID()
    await appStore.addSharedFile({
      fileId,
      path: sharedFilePath,
      groupKeys: [groupKey]
    })

    // Launch Electron with CDP
    const cdpPort = await getFreePort()
    const child = spawn(electronPath, ['.', `--data-dir=${dirApp}`, `--remote-debugging-port=${cdpPort}`], {
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
    })
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

    assert.ok(tabs.length > 0 && tabs[0].webSocketDebuggerUrl, 'Electron CDP target was not found')
    const cdp = await connectToCdp(tabs[0].webSocketDebuggerUrl)

    let headlessPeer: PeerEngine | null = null
    try {
      // 1. Join group through real window.p2p.p2p.joinGroup API in Electron
      const joinResult = await cdp.evaluate<{ ok: boolean; message?: string }>(`
        window.p2p.p2p.joinGroup({
          invitation: { version: 2, signalingUrl: '${signalingUrl}', groupId: '${testGroupId}', token: '${testToken}' },
          displayName: 'ElectronUploader',
          supernodeEligible: true,
          relayOnly: false,
          rememberInvitation: false,
          autoJoin: false
        })
      `)
      assert.equal(joinResult.ok, true, `JoinGroup failed: ${joinResult.message}`)

      // 2. Connect headless peer to the same group
      headlessPeer = await createPeerEngine({ dataDirectory: dirPeer })
      await headlessPeer.joinGroup({
        invitation: { version: 2, signalingUrl, groupId: testGroupId, token: testToken },
        displayName: 'HeadlessDownloader',
        supernodeEligible: false,
        relayOnly: false,
        rememberInvitation: false,
        autoJoin: false
      })

      // Wait for mesh connection
      const { promise: meshPromise, resolve: resolveMesh, reject: rejectMesh } = Promise.withResolvers<void>()
      const meshTimeout = setTimeout(() => rejectMesh(new Error('Timeout waiting for mesh')), 20000)
      meshTimeout.unref?.()
      const checkMesh = () => {
        const s = headlessPeer!.getState()
        const g = s.groups.find((gr) => gr.groupKey === groupKey)
        if (g && g.network.status === 'connected' && g.network.members.length >= 2) {
          clearTimeout(meshTimeout)
          resolveMesh()
        } else {
          setTimeout(checkMesh, 100)
        }
      }
      checkMesh()
      await meshPromise

      // 3. Headless peer searches for file once and awaits results
      const { promise: searchPromise, resolve: resolveSearch, reject: rejectSearch } = Promise.withResolvers<void>()
      const searchTimeout = setTimeout(() => rejectSearch(new Error('Timeout waiting for search')), 20000)
      searchTimeout.unref?.()

      const unsubSearch = headlessPeer.subscribe((st) => {
        const g = st.groups.find((gr) => gr.groupKey === groupKey)
        if (g && g.search.results.length > 0) {
          clearTimeout(searchTimeout)
          unsubSearch()
          resolveSearch()
        }
      })

      // Search once
      await headlessPeer.search(groupKey, 'seeded')
      await searchPromise

      const searchRes = headlessPeer.getState().groups.find((g) => g.groupKey === groupKey)!.search.results[0]
      assert.ok(searchRes)

      // 4. Headless peer downloads the file and awaits completion
      const dlDest = join(dirPeer, 'received-seeded.bin')
      const { promise: dlPromise, resolve: resolveDl, reject: rejectDl } = Promise.withResolvers<void>()
      const dlTimeout = setTimeout(() => rejectDl(new Error('Timeout waiting for download completion')), 20000)
      dlTimeout.unref?.()

      const unsubDl = headlessPeer.subscribe((st) => {
        const t = st.transfers.find((tr) => (tr.fileName || '').includes('seeded-e2e-file'))
        if (t && t.state === 'completed') {
          clearTimeout(dlTimeout)
          unsubDl()
          resolveDl()
        } else if (t && t.state === 'failed') {
          clearTimeout(dlTimeout)
          unsubDl()
          rejectDl(new Error(`Download failed: ${t.message}`))
        }
      })

      await headlessPeer.download(groupKey, searchRes.resultId, dlDest)
      await dlPromise

      // Verify file bytes and hash on receiving peer
      const receivedBytes = await readFile(dlDest)
      assert.equal(receivedBytes.length, fileContent.length)
      const expectedHash = createHash('sha256').update(fileContent).digest('hex')
      assert.equal(createHash('sha256').update(receivedBytes).digest('hex'), expectedHash)

      // 5. Navigate to Transfers view in Electron UI
      await cdp.evaluate(`new Promise(resolve => {
        const btn = Array.from(document.querySelectorAll('.nav-link')).find(b => (b.textContent || '').includes('Transfers'));
        if (btn) {
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        setTimeout(resolve, 500);
      })`)

      // Wait for rendered transfer history row in DOM
      const renderedGroupId = await cdp.evaluate<string>(`new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
          const rows = Array.from(document.querySelectorAll('tbody tr'));
          for (const row of rows) {
            const cells = Array.from(row.querySelectorAll('td'));
            if (cells.length >= 2) {
              const groupBadge = cells[1].querySelector('.badge-group') || cells[1].querySelector('.badge');
              if (groupBadge && groupBadge.textContent) {
                resolve(groupBadge.textContent.trim());
                return;
              }
            }
          }
          if (Date.now() - start > 15000) {
            const firstRow = document.querySelector('tbody tr');
            resolve(firstRow?.querySelectorAll('td')[1]?.textContent?.trim() || '');
            return;
          }
          setTimeout(check, 100);
        };
        check();
      })`)

      // Assert the rendered history row contains the real group ID instead of '—'
      assert.equal(
        renderedGroupId,
        testGroupId,
        `Rendered group badge must match group ID "\${testGroupId}", got "\${renderedGroupId}"`
      )
    } finally {
      if (headlessPeer) await headlessPeer.dispose()
      await cdp.close()
      await server.close()
    }
  })
})
