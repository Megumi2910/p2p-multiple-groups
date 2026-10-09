import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC_CHANNELS,
  type KazaaApi,
  type P2pApi,
  type ShellCommand,
  type ThemePreference
} from '../shared/contracts.ts'
import type {
  ActionResult,
  ConnectOptions,
  GroupKey,
  JoinGroupOptions,
  KazaaP2pApi,
  MultiGroupP2pState,
  P2pMultipleGroupsP2pApi,
  P2pState
} from '../shared/p2p.ts'

const p2pApi: P2pMultipleGroupsP2pApi & KazaaP2pApi = {
  getState(): Promise<any> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_GET_STATE)
  },

  onState(listener: (state: any) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, state: any): void => {
      listener(state)
    }
    ipcRenderer.on(IPC_CHANNELS.P2P_V2_STATE, wrapped)
    ipcRenderer.on(IPC_CHANNELS.P2P_STATE, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.P2P_V2_STATE, wrapped)
      ipcRenderer.removeListener(IPC_CHANNELS.P2P_STATE, wrapped)
    }
  },

  joinGroup(options: JoinGroupOptions): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_JOIN_GROUP, options)
  },

  resumeGroup(groupKey: GroupKey): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_RESUME_GROUP, groupKey)
  },

  leaveGroup(groupKey: GroupKey): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_LEAVE_GROUP, groupKey)
  },

  setGroupAutoJoin(groupKey: GroupKey, autoJoin: boolean): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_SET_GROUP_AUTO_JOIN, groupKey, autoJoin)
  },

  forgetGroup(groupKey: GroupKey): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_FORGET_GROUP, groupKey)
  },

  disconnectAll(): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_DISCONNECT_ALL)
  },

  setSupernodeEligible(arg1: unknown, arg2?: unknown): Promise<ActionResult> {
    if (typeof arg1 === 'string' && typeof arg2 === 'boolean') {
      return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_SET_GROUP_ELIGIBILITY, arg1, arg2)
    }
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_ELIGIBILITY, Boolean(arg1))
  },

  addFiles(groupKey?: GroupKey | null): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_ADD_FILES, groupKey || null)
  },

  rescanLibrary(): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_RESCAN_LIBRARY)
  },

  removeFile(fileId: string): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_REMOVE_FILE, fileId)
  },

  setFileGroups(fileId: string, groupKeys: GroupKey[]): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_SET_FILE_GROUPS, fileId, groupKeys)
  },

  search(arg1: string, arg2?: string): Promise<ActionResult> {
    if (arg2 !== undefined) {
      return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_SEARCH, arg1, arg2)
    }
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_SEARCH, arg1)
  },

  download(arg1: string, arg2?: string): Promise<ActionResult> {
    if (arg2 !== undefined) {
      return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_DOWNLOAD, arg1, arg2)
    }
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_DOWNLOAD, arg1)
  },

  cancelTransfer(transferId: string): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_CANCEL_TRANSFER, transferId)
  },

  // Legacy compatibility methods
  connect(options: ConnectOptions): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_CONNECT, options)
  },

  disconnect(): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_DISCONNECT)
  }
}

const api: P2pApi & KazaaApi = {
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

// Expose primary window.p2p and compatibility facade window.kazaa
contextBridge.exposeInMainWorld('p2p', api)
contextBridge.exposeInMainWorld('kazaa', api)
