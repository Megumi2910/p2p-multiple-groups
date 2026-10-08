import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC_CHANNELS,
  type KazaaApi,
  type ShellCommand,
  type ThemePreference
} from '../shared/contracts.ts'
import type {
  ActionResult,
  ConnectOptions,
  KazaaP2pApi,
  P2pState
} from '../shared/p2p.ts'

const p2pApi: KazaaP2pApi = {
  getState(): Promise<P2pState> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_GET_STATE)
  },
  onState(listener: (state: P2pState) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, state: P2pState): void => {
      listener(state)
    }
    ipcRenderer.on(IPC_CHANNELS.P2P_STATE, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.P2P_STATE, wrapped)
    }
  },
  connect(options: ConnectOptions): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_CONNECT, options)
  },
  disconnect(): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_DISCONNECT)
  },
  setSupernodeEligible(eligible: boolean): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_ELIGIBILITY, eligible)
  },
  addFiles(): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_ADD_FILES)
  },
  rescanLibrary(): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_RESCAN_LIBRARY)
  },
  removeFile(fileId: string): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_REMOVE_FILE, fileId)
  },
  search(query: string): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_SEARCH, query)
  },
  download(resultId: string): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_DOWNLOAD, resultId)
  },
  cancelTransfer(transferId: string): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_CANCEL_TRANSFER, transferId)
  }
}

const api: KazaaApi = {
  isMac: process.platform === 'darwin',
  getTheme(): Promise<ThemePreference> {
    return ipcRenderer.invoke(IPC_CHANNELS.THEME_GET)
  },
  setTheme(theme: ThemePreference): Promise<ThemePreference> {
    return ipcRenderer.invoke(IPC_CHANNELS.THEME_SET, theme)
  },
  onCommand(listener: (command: ShellCommand) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, command: ShellCommand): void => {
      listener(command)
    }
    ipcRenderer.on(IPC_CHANNELS.COMMAND, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.COMMAND, wrapped)
    }
  },
  p2p: p2pApi
}

contextBridge.exposeInMainWorld('kazaa', api)
