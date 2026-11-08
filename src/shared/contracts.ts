import type { P2pMultipleGroupsP2pApi } from './p2p.ts'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ShellCommand = 'open-command-palette' | 'open-appearance'

export interface P2pApi {
  readonly isMac: boolean
  getTheme(): Promise<ThemePreference>
  setTheme(theme: ThemePreference): Promise<ThemePreference>
  onCommand(listener: (command: ShellCommand) => void): () => void
  readonly p2p: P2pMultipleGroupsP2pApi
}

export const IPC_CHANNELS = {
  THEME_GET: 'p2p:theme:get',
  THEME_SET: 'p2p:theme:set',
  COMMAND: 'p2p:command',
  P2P_V2_GET_STATE: 'p2p:getState',
  P2P_V2_STATE: 'p2p:state',
  P2P_V2_CREATE_GROUP: 'p2p:createGroup',
  P2P_V2_JOIN_GROUP: 'p2p:joinGroup',
  P2P_V2_RESUME_GROUP: 'p2p:resumeGroup',
  P2P_V2_LEAVE_GROUP: 'p2p:leaveGroup',
  P2P_V2_ROTATE_GROUP_INVITE: 'p2p:rotateGroupInvite',
  P2P_V2_REMOVE_GROUP_MEMBER: 'p2p:removeGroupMember',
  P2P_V2_SET_GROUP_AUTO_JOIN: 'p2p:setGroupAutoJoin',
  P2P_V2_SET_GROUP_ELIGIBILITY: 'p2p:setGroupEligibility',
  P2P_V2_FORGET_GROUP: 'p2p:forgetGroup',
  P2P_V2_DISCONNECT_ALL: 'p2p:disconnectAll',
  P2P_V2_ADD_FILES: 'p2p:addFiles',
  P2P_V2_RESCAN_LIBRARY: 'p2p:rescanLibrary',
  P2P_V2_REMOVE_FILE: 'p2p:removeFile',
  P2P_V2_SET_FILE_GROUPS: 'p2p:setFileGroups',
  P2P_V2_SEARCH: 'p2p:search',
  P2P_V2_DOWNLOAD: 'p2p:download',
  P2P_V2_CANCEL_TRANSFER: 'p2p:cancelTransfer'
} as const

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}
