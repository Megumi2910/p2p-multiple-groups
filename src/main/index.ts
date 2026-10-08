import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, type IpcMainInvokeEvent } from 'electron'
import { isAbsolute, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createThemeStore, type ThemeStore } from './theme-store.ts'
import { installMenu, setMenuWindowActive } from './menu.ts'
import {
  IPC_CHANNELS,
  isThemePreference,
  type ShellCommand,
  type ThemePreference
} from '../shared/contracts.ts'
import {
  validateConnectOptions,
  type ActionResult,
  type P2pErrorCode,
  type P2pState
} from '../shared/p2p.ts'
import { createPeerEngine, type PeerEngine } from './p2p/engine.ts'
import { sanitizeDestinationFileName } from './p2p/transfers.ts'
app.setName('Kazaa')

let mainWindow: BrowserWindow | null = null
let themeStore: ThemeStore | null = null
let peerEngine: PeerEngine | null = null
let isIpcRegistered = false

let pendingStateSnapshot: P2pState | null = null
let stateThrottleTimer: NodeJS.Timeout | null = null

function dispatchStateToWindow(state: P2pState): void {
  pendingStateSnapshot = state
  if (!stateThrottleTimer) {
    stateThrottleTimer = setTimeout(() => {
      stateThrottleTimer = null
      if (pendingStateSnapshot && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.P2P_STATE, pendingStateSnapshot)
        pendingStateSnapshot = null
      }
    }, 200)
  }
}

function mapToActionResult(error: unknown): ActionResult {
  const msg = error instanceof Error ? error.message : String(error)
  const knownCodes: P2pErrorCode[] = [
    'INVALID_INPUT',
    'AUTH_FAILED',
    'DISCONNECTED',
    'NO_SUPERNODE',
    'UNREACHABLE',
    'NOT_FOUND',
    'FILE_CHANGED',
    'DESTINATION_EXISTS',
    'IO_ERROR',
    'BUSY',
    'PROTOCOL_ERROR'
  ]

  for (const code of knownCodes) {
    if (msg.includes(code)) {
      return { ok: false, code, message: msg }
    }
  }

  return { ok: false, code: 'IO_ERROR', message: 'Operation could not be completed.' }
}

const isDev = !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL)
const expectedDevOrigin = 'http://127.0.0.1:5173'
const productionHtmlPath = fileURLToPath(new URL('../renderer/index.html', import.meta.url))
const productionHtmlUrl = pathToFileURL(productionHtmlPath).href

function validateSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('Untrusted sender')
  }
  if (event.sender !== mainWindow.webContents) {
    throw new Error('Untrusted sender')
  }
  const frame = event.senderFrame
  if (!frame || frame.parent !== null) {
    throw new Error('Untrusted sender')
  }

  if (isDev) {
    try {
      const parsed = new URL(frame.url)
      if (parsed.origin !== expectedDevOrigin || parsed.pathname !== '/') {
        throw new Error('Untrusted sender')
      }
    } catch {
      throw new Error('Untrusted sender')
    }
  } else {
    if (frame.url !== productionHtmlUrl) {
      throw new Error('Untrusted sender')
    }
  }
}

function registerIpcHandlers(): void {
  if (isIpcRegistered) return
  isIpcRegistered = true

  ipcMain.handle(IPC_CHANNELS.THEME_GET, (event) => {
    validateSender(event)
    if (!themeStore) {
      throw new Error('Theme store uninitialized')
    }
    return themeStore.get()
  })

  ipcMain.handle(IPC_CHANNELS.THEME_SET, async (event, theme: unknown) => {
    validateSender(event)
    if (!isThemePreference(theme)) {
      throw new TypeError('Invalid theme preference')
    }
    if (!themeStore) {
      throw new Error('Theme store uninitialized')
    }

    try {
      const savedTheme = await themeStore.set(theme)
      nativeTheme.themeSource = savedTheme
      return savedTheme
    } catch (error) {
      console.error('[main] Failed to persist theme settings:', error)
      throw new Error('Unable to save appearance')
    }
  })

  ipcMain.handle(IPC_CHANNELS.P2P_GET_STATE, async (event) => {
    validateSender(event)
    if (!peerEngine) throw new Error('Peer engine uninitialized')
    return peerEngine.getState()
  })

  ipcMain.handle(IPC_CHANNELS.P2P_CONNECT, async (event, options: unknown) => {
    validateSender(event)
    if (!peerEngine) throw new Error('Peer engine uninitialized')
    const check = validateConnectOptions(options)
    if (!check.valid) {
      return { ok: false, code: 'INVALID_INPUT', message: check.error }
    }
    try {
      await peerEngine.connect(check.value)
      return { ok: true }
    } catch (err) {
      return mapToActionResult(err)
    }
  })

  ipcMain.handle(IPC_CHANNELS.P2P_DISCONNECT, async (event) => {
    validateSender(event)
    if (!peerEngine) throw new Error('Peer engine uninitialized')
    try {
      await peerEngine.disconnect()
      return { ok: true }
    } catch (err) {
      return mapToActionResult(err)
    }
  })

  ipcMain.handle(IPC_CHANNELS.P2P_ELIGIBILITY, async (event, eligible: unknown) => {
    validateSender(event)
    if (!peerEngine) throw new Error('Peer engine uninitialized')
    try {
      await peerEngine.setSupernodeEligible(Boolean(eligible))
      return { ok: true }
    } catch (err) {
      return mapToActionResult(err)
    }
  })

  ipcMain.handle(IPC_CHANNELS.P2P_ADD_FILES, async (event) => {
    validateSender(event)
    if (!peerEngine) throw new Error('Peer engine uninitialized')
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { ok: false, code: 'IO_ERROR', message: 'Main window unavailable' }
    }
    const dialogResult = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections']
    })
    if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
      return { ok: true }
    }
    try {
      await peerEngine.addFiles(dialogResult.filePaths)
      return { ok: true }
    } catch (err) {
      return mapToActionResult(err)
    }
  })

  ipcMain.handle(IPC_CHANNELS.P2P_RESCAN_LIBRARY, async (event) => {
    validateSender(event)
    if (!peerEngine) throw new Error('Peer engine uninitialized')
    try {
      await peerEngine.rescanLibrary()
      return { ok: true }
    } catch (err) {
      return mapToActionResult(err)
    }
  })

  ipcMain.handle(IPC_CHANNELS.P2P_REMOVE_FILE, async (event, fileId: unknown) => {
    validateSender(event)
    if (!peerEngine) throw new Error('Peer engine uninitialized')
    if (typeof fileId !== 'string') {
      return { ok: false, code: 'INVALID_INPUT', message: 'Invalid file ID' }
    }
    try {
      await peerEngine.removeFile(fileId)
      return { ok: true }
    } catch (err) {
      return mapToActionResult(err)
    }
  })

  ipcMain.handle(IPC_CHANNELS.P2P_SEARCH, async (event, query: unknown) => {
    validateSender(event)
    if (!peerEngine) throw new Error('Peer engine uninitialized')
    if (typeof query !== 'string') {
      return { ok: false, code: 'INVALID_INPUT', message: 'Query must be a string' }
    }
    try {
      await peerEngine.search(query)
      return { ok: true }
    } catch (err) {
      return mapToActionResult(err)
    }
  })

  ipcMain.handle(IPC_CHANNELS.P2P_DOWNLOAD, async (event, resultId: unknown) => {
    validateSender(event)
    if (!peerEngine) throw new Error('Peer engine uninitialized')
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { ok: false, code: 'IO_ERROR', message: 'Main window unavailable' }
    }
    if (typeof resultId !== 'string') {
      return { ok: false, code: 'INVALID_INPUT', message: 'Invalid result ID' }
    }
    const resolved = peerEngine.resolveSearchResult(resultId)
    if (!resolved) {
      return { ok: false, code: 'NOT_FOUND', message: 'Search result not found or expired' }
    }
    const defaultName = sanitizeDestinationFileName(resolved.file.name)
    const saveResult = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName
    })
    if (saveResult.canceled || !saveResult.filePath) {
      return { ok: true }
    }
    try {
      await peerEngine.download(resultId, saveResult.filePath)
      return { ok: true }
    } catch (err) {
      return mapToActionResult(err)
    }
  })

  ipcMain.handle(IPC_CHANNELS.P2P_CANCEL_TRANSFER, async (event, transferId: unknown) => {
    validateSender(event)
    if (!peerEngine) throw new Error('Peer engine uninitialized')
    if (typeof transferId !== 'string') {
      return { ok: false, code: 'INVALID_INPUT', message: 'Invalid transfer ID' }
    }
    try {
      await peerEngine.cancelTransfer(transferId)
      return { ok: true }
    } catch (err) {
      return mapToActionResult(err)
    }
  })
}

async function createWindow(): Promise<BrowserWindow> {
  const isDark = nativeTheme.shouldUseDarkColors
  const canvasBg = isDark ? '#171B24' : '#F3F5FA'

  const preloadPath = fileURLToPath(new URL('../preload/index.cjs', import.meta.url))

  const win = new BrowserWindow({
    title: 'Kazaa',
    width: 1100,
    height: 740,
    minWidth: 760,
    minHeight: 520,
    show: false,
    frame: true,
    autoHideMenuBar: false,
    backgroundColor: canvasBg,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false
    }
  })

  mainWindow = win
  setMenuWindowActive(true)

  win.on('ready-to-show', () => {
    win.show()
  })

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null
    }
    setMenuWindowActive(BrowserWindow.getAllWindows().some((w) => !w.isDestroyed()))
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  win.webContents.on('will-navigate', (event, navigationUrl) => {
    const isAllowed = isDev
      ? navigationUrl === `${expectedDevOrigin}/`
      : navigationUrl === productionHtmlUrl
    if (!isAllowed) {
      event.preventDefault()
    }
  })

  win.webContents.on('will-frame-navigate', (event) => {
    event.preventDefault()
  })

  if (isDev) {
    const devUrl = process.env.ELECTRON_RENDERER_URL!
    try {
      const parsed = new URL(devUrl)
      if (parsed.origin !== expectedDevOrigin || parsed.pathname !== '/') {
        throw new Error(`Invalid ELECTRON_RENDERER_URL: ${devUrl}. Expected origin: ${expectedDevOrigin}`)
      }
    } catch (err) {
      throw new Error(`Invalid ELECTRON_RENDERER_URL: ${devUrl}`, { cause: err })
    }
    await win.loadURL(devUrl)
  } else {
    await win.loadFile(productionHtmlPath)
  }

  return win
}

async function init(): Promise<void> {
  try {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })
    session.defaultSession.setPermissionCheckHandler(() => false)

    const settingsPath = join(app.getPath('userData'), 'settings.json')
    themeStore = await createThemeStore(settingsPath)
    nativeTheme.themeSource = themeStore.get()

    registerIpcHandlers()
    const userDataDir = app.getPath('userData')
    peerEngine = await createPeerEngine({ dataDirectory: userDataDir })
    peerEngine.subscribe((state) => {
      dispatchStateToWindow(state)
    })


    installMenu((command: ShellCommand) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.COMMAND, command)
      }
    })

    await createWindow()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('Kazaa failed to start', message)
    app.exit(1)
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

let isShuttingDown = false
let isShutdownComplete = false

app.on('before-quit', (event) => {
  if (isShutdownComplete) return
  event.preventDefault()
  if (isShuttingDown) return
  isShuttingDown = true

  const performTeardown = async () => {
    try {
      if (peerEngine) {
        const { promise, resolve } = Promise.withResolvers<void>()
        const timer = setTimeout(resolve, 5000)
        await Promise.race([peerEngine.dispose(), promise])
        clearTimeout(timer)
      }
    } catch (err) {
      console.error('[main] Error during shutdown:', err)
    } finally {
      isShutdownComplete = true
      app.quit()
    }
  }

  void performTeardown()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch((err) => {
      dialog.showErrorBox('Kazaa failed to start', err instanceof Error ? err.message : String(err))
      app.exit(1)
    })
  }
})
function setupDataDirectory(): void {
  const dataDirArgs = process.argv.filter((arg) => arg.startsWith('--data-dir=') || arg === '--data-dir')
  if (dataDirArgs.length > 1) {
    console.error('Duplicate --data-dir arguments are not allowed.')
    app.exit(1)
    return
  } else if (dataDirArgs.length === 1) {
    const raw = dataDirArgs[0]
    if (raw === '--data-dir') {
      console.error('--data-dir requires an absolute path: --data-dir=<absolute-path>')
      app.exit(1)
      return
    }
    const val = raw.slice('--data-dir='.length).trim()
    if (!val || !isAbsolute(val)) {
      console.error('--data-dir must specify a non-empty absolute path')
      app.exit(1)
      return
    }
    mkdirSync(val, { recursive: true })
    app.setPath('userData', val)
    app.setPath('sessionData', join(val, 'session'))
  }

  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
    process.exit(0)
  }

  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

setupDataDirectory()


app.whenReady().then(init)
