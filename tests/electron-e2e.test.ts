import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import electron from 'electron'
import WebSocket from 'ws'

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
        hasKazaa: Boolean(window.kazaa),
        hasP2pGlobal: Boolean(window.p2p),
        isMac: typeof window.p2p?.isMac === 'boolean',
        hasGetTheme: typeof window.p2p?.getTheme === 'function',
        hasSetTheme: typeof window.p2p?.setTheme === 'function',
        hasOnCommand: typeof window.p2p?.onCommand === 'function',
        hasP2p: Boolean(window.p2p?.p2p),
        hasP2pGetState: typeof window.p2p?.p2p?.getState === 'function',
        hasP2pJoinGroup: typeof window.p2p?.p2p?.joinGroup === 'function',
        hasP2pLeaveGroup: typeof window.p2p?.p2p?.leaveGroup === 'function',
        hasP2pSetFileGroups: typeof window.p2p?.p2p?.setFileGroups === 'function',
        hasP2pConnect: typeof window.kazaa?.p2p?.connect === 'function',
        hasP2pDisconnect: typeof window.kazaa?.p2p?.disconnect === 'function',
        hasP2pAddFiles: typeof window.p2p?.p2p?.addFiles === 'function',
        hasP2pSearch: typeof window.p2p?.p2p?.search === 'function',
        hasP2pDownload: typeof window.p2p?.p2p?.download === 'function'
      })`)

      assert.deepEqual(bridgeCheck, {
        hasKazaa: true,
        hasP2pGlobal: true,
        isMac: true,
        hasGetTheme: true,
        hasSetTheme: true,
        hasOnCommand: true,
        hasP2p: true,
        hasP2pGetState: true,
        hasP2pJoinGroup: true,
        hasP2pLeaveGroup: true,
        hasP2pSetFileGroups: true,
        hasP2pConnect: true,
        hasP2pDisconnect: true,
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
          if (!btn) {
            resolve();
            return;
          }
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          const start = Date.now();
          const check = () => {
            if (document.activeElement?.id?.toLowerCase() === '${expectedHeadingId.toLowerCase()}') {
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
      await clickNavAndVerifyHeading('Appearance', 'appearance-heading')
      await clickNavAndVerifyHeading('Home', 'home-heading')

      // 6. Test Command Palette interaction
      // Click "Open commands" button
      await cdp.evaluate(`{
        const btn = Array.from(document.querySelectorAll('.action-row-btn')).find(b => b.textContent.includes('Open commands'));
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
  })
})
