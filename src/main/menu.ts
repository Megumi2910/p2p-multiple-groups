import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import type { ShellCommand } from '../shared/contracts.ts'

let commandHandler: ((command: ShellCommand) => void) | null = null

function dispatchCommand(command: ShellCommand): void {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) {
      win.restore()
    }
    win.focus()
    commandHandler?.(command)
  }
}

export function setMenuWindowActive(hasWindow: boolean): void {
  const menu = Menu.getApplicationMenu()
  if (menu) {
    const paletteItem = menu.getMenuItemById('open-command-palette')
    if (paletteItem) {
      paletteItem.enabled = hasWindow
    }
    const appearanceItem = menu.getMenuItemById('open-appearance')
    if (appearanceItem) {
      appearanceItem.enabled = hasWindow
    }
  }
}

export function installMenu(onCommand: (command: ShellCommand) => void): void {
  commandHandler = onCommand

  app.setAboutPanelOptions({
    applicationName: 'p2p-multiple-groups',
    applicationVersion: app.getVersion()
  })

  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }

  template.push({
    label: 'File',
    submenu: [isMac ? { role: 'close' } : { role: 'quit' }]
  })

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' }
    ]
  })

  template.push({
    label: 'View',
    submenu: [
      {
        id: 'open-command-palette',
        label: 'Command Palette…',
        accelerator: 'CommandOrControl+K',
        click: () => dispatchCommand('open-command-palette')
      },
      {
        id: 'open-appearance',
        label: 'Appearance…',
        accelerator: 'CommandOrControl+,',
        click: () => dispatchCommand('open-appearance')
      }
    ]
  })

  if (!isMac) {
    template.push({
      label: 'Help',
      submenu: [{ role: 'about' }]
    })
  }

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}
