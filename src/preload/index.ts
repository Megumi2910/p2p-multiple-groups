import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC_CHANNELS,
  type P2pApi,
  type ShellCommand,
  type ThemePreference
} from '../shared/contracts.ts'
import type {
  ActionResult,
  CreateGroupOptions,
  GroupKey,
  JoinGroupOptions,
  MultiGroupP2pState,
  P2pMultipleGroupsP2pApi
} from '../shared/p2p.ts'

const p2pApi: P2pMultipleGroupsP2pApi = {
  getState(): Promise<MultiGroupP2pState> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_GET_STATE)
  },

  onState(listener: (state: MultiGroupP2pState) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, state: MultiGroupP2pState): void => {
      listener(state)
    }
    ipcRenderer.on(IPC_CHANNELS.P2P_V2_STATE, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.P2P_V2_STATE, wrapped)
    }
  },

  createGroup(options: CreateGroupOptions): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_CREATE_GROUP, options)
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

  rotateGroupInvite(groupKey: GroupKey): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_ROTATE_GROUP_INVITE, groupKey)
  },

  removeGroupMember(groupKey: GroupKey, targetPeerId: string): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_REMOVE_GROUP_MEMBER, groupKey, targetPeerId)
  },

  setGroupAutoJoin(groupKey: GroupKey, autoJoin: boolean): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_SET_GROUP_AUTO_JOIN, groupKey, autoJoin)
  },

  setGroupEligibility(groupKey: GroupKey, eligible: boolean): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_SET_GROUP_ELIGIBILITY, groupKey, eligible)
  },

  forgetGroup(groupKey: GroupKey): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_FORGET_GROUP, groupKey)
  },

  disconnectAll(): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_DISCONNECT_ALL)
  },

  addFiles(groupKey: GroupKey | null): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_ADD_FILES, groupKey)
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

  search(groupKey: GroupKey, query: string): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_SEARCH, groupKey, query)
  },

  download(groupKey: GroupKey, resultId: string): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_DOWNLOAD, groupKey, resultId)
  },

  cancelTransfer(transferId: string): Promise<ActionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.P2P_V2_CANCEL_TRANSFER, transferId)
  }
}

const api: P2pApi = {
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

contextBridge.exposeInMainWorld('p2p', api)
