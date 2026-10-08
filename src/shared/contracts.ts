import type { KazaaP2pApi } from './p2p.ts'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ShellCommand = 'open-command-palette' | 'open-appearance'

export interface KazaaApi {
  readonly isMac: boolean
  getTheme(): Promise<ThemePreference>
  setTheme(theme: ThemePreference): Promise<ThemePreference>
  onCommand(listener: (command: ShellCommand) => void): () => void
  readonly p2p: KazaaP2pApi
}

export const IPC_CHANNELS = {
  THEME_GET: 'kazaa:theme:get',
  THEME_SET: 'kazaa:theme:set',
  COMMAND: 'kazaa:command',
  P2P_GET_STATE: 'kazaa:p2p:get-state',
  P2P_STATE: 'kazaa:p2p:state',
  P2P_CONNECT: 'kazaa:p2p:connect',
  P2P_DISCONNECT: 'kazaa:p2p:disconnect',
  P2P_ELIGIBILITY: 'kazaa:p2p:eligibility',
  P2P_ADD_FILES: 'kazaa:p2p:add-files',
  P2P_RESCAN_LIBRARY: 'kazaa:p2p:rescan-library',
  P2P_REMOVE_FILE: 'kazaa:p2p:remove-file',
  P2P_SEARCH: 'kazaa:p2p:search',
  P2P_DOWNLOAD: 'kazaa:p2p:download',
  P2P_CANCEL_TRANSFER: 'kazaa:p2p:cancel-transfer'
} as const
export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}
