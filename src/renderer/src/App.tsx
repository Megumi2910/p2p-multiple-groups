import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ShellCommand, ThemePreference } from '../../shared/contracts.ts'
import { CommandPalette } from './features/commands/CommandPalette.tsx'
import type { CommandId } from './features/commands/commands.ts'
import { Appearance } from './features/appearance/Appearance.tsx'
import { Network } from './features/network/Network.tsx'
import { Library } from './features/library/Library.tsx'
import { Search } from './features/search/Search.tsx'
import { Transfers } from './features/transfers/Transfers.tsx'
import { usePeerState } from './features/network/usePeerState.ts'

type View = 'home' | 'search' | 'library' | 'transfers' | 'network' | 'appearance'

function getBridge() {
  return window.p2p || window.kazaa
}

export default function App(): React.ReactElement {
  const [currentView, setCurrentView] = useState<View>('home')
  const [currentTheme, setCurrentTheme] = useState<ThemePreference>('system')
  const [isThemeLoading, setIsThemeLoading] = useState(true)
  const [isThemeSaving, setIsThemeSaving] = useState(false)
  const [themeErrorMessage, setThemeErrorMessage] = useState<string | null>(null)
  const [isPaletteOpen, setIsPaletteOpen] = useState(false)
  const [openRequest, setOpenRequest] = useState(0)
  const [initError, setInitError] = useState<string | null>(null)

  const workspaceHeadingRef = useRef<HTMLHeadingElement>(null)
  const lastActiveElementRef = useRef<HTMLElement | null>(null)
  const isSavingThemeRef = useRef(false)

  const bridge = getBridge()
  const isMac = Boolean(bridge?.isMac)
  const modifierLabel = isMac ? 'Cmd' : 'Ctrl'

  // P2P engine state & actions via custom hook
  const peer = usePeerState()

  // Initialize theme from main process
  useEffect(() => {
    let isSubscribed = true
    const b = getBridge()

    if (!b || typeof b.getTheme !== 'function') {
      setInitError('p2p-multiple-groups initialization failed. Please relaunch the application.')
      setIsThemeLoading(false)
      return
    }

    b.getTheme()
      .then((theme) => {
        if (isSubscribed) {
          setCurrentTheme(theme)
          setIsThemeLoading(false)
        }
      })
      .catch((err) => {
        console.error('[App] Failed to read initial theme:', err)
        if (isSubscribed) {
          setInitError('p2p-multiple-groups initialization failed. Please relaunch the application.')
          setIsThemeLoading(false)
        }
      })

    return () => {
      isSubscribed = false
    }
  }, [])

  const openPalette = useCallback((): void => {
    if (document.activeElement instanceof HTMLElement) {
      lastActiveElementRef.current = document.activeElement
    }
    setOpenRequest((prev) => prev + 1)
    setIsPaletteOpen(true)
  }, [])

  const navigateTo = useCallback((view: View): void => {
    setCurrentView(view)
  }, [])

  useEffect(() => {
    workspaceHeadingRef.current?.focus()
  }, [currentView])

  // Subscribe to native menu commands
  useEffect(() => {
    const b = getBridge()
    if (!b || typeof b.onCommand !== 'function') {
      return
    }

    const unsubscribe = b.onCommand((command: ShellCommand) => {
      if (command === 'open-command-palette') {
        openPalette()
      } else if (command === 'open-appearance') {
        if (!isSavingThemeRef.current) {
          setIsPaletteOpen(false)
          navigateTo('appearance')
        }
      }
    })

    return () => {
      unsubscribe()
    }
  }, [openPalette, navigateTo])

  const persistTheme = async (theme: ThemePreference): Promise<void> => {
    const b = getBridge()
    if (!b) {
      throw new Error('Bridge unavailable')
    }
    isSavingThemeRef.current = true
    setIsThemeSaving(true)
    setThemeErrorMessage(null)

    try {
      const savedTheme = await b.setTheme(theme)
      setCurrentTheme(savedTheme)
      setIsThemeSaving(false)
      isSavingThemeRef.current = false
    } catch (err) {
      setIsThemeSaving(false)
      isSavingThemeRef.current = false
      setThemeErrorMessage('Could not save appearance. Your previous setting is unchanged.')
      throw err
    }
  }

  const handlePaletteClose = (): void => {
    setIsPaletteOpen(false)
    requestAnimationFrame(() => {
      if (lastActiveElementRef.current && lastActiveElementRef.current.isConnected) {
        lastActiveElementRef.current.focus()
      }
    })
  }

  const executeCommand = async (id: CommandId): Promise<void> => {
    switch (id) {
      case 'navigate-home':
        navigateTo('home')
        return
      case 'navigate-search':
        navigateTo('search')
        return
      case 'navigate-library':
        navigateTo('library')
        return
      case 'navigate-transfers':
        navigateTo('transfers')
        return
      case 'navigate-network':
        navigateTo('network')
        return
      case 'open-appearance':
        navigateTo('appearance')
        return
      case 'theme-system':
        await persistTheme('system')
        return
      case 'theme-light':
        await persistTheme('light')
        return
      case 'theme-dark':
        await persistTheme('dark')
        return
    }
  }

  if (initError) {
    return (
      <div className="launch-error-container" role="alert">
        <h1 className="launch-error-title">Initialization Error</h1>
        <p className="launch-error-msg">{initError}</p>
      </div>
    )
  }

  const isNetworkConnected =
    peer.state.groups.some((g) => g.network.status === 'connected') ||
    peer.state.network.status === 'connected' ||
    peer.state.network.status === 'degraded' ||
    peer.state.network.status === 'recovering'

  const activeTransfersCount = peer.state.transfers.filter(
    (t) => t.state === 'transferring' || t.state === 'connecting' || t.state === 'verifying'
  ).length

  return (
    <div className="app-container">
      {/* Navigation rail */}
      <nav className="nav-rail" aria-label="Main Navigation">
        <span className="brand-label">p2p</span>
        <button
          type="button"
          className="nav-link"
          aria-current={currentView === 'home' ? 'page' : undefined}
          onClick={() => navigateTo('home')}
        >
          <span>Home</span>
        </button>
        <button
          type="button"
          className="nav-link"
          aria-current={currentView === 'search' ? 'page' : undefined}
          onClick={() => navigateTo('search')}
        >
          <span>Search</span>
        </button>
        <button
          type="button"
          className="nav-link"
          aria-current={currentView === 'library' ? 'page' : undefined}
          onClick={() => navigateTo('library')}
        >
          <span>Library</span>
        </button>
        <button
          type="button"
          className="nav-link"
          aria-current={currentView === 'transfers' ? 'page' : undefined}
          onClick={() => navigateTo('transfers')}
        >
          <span>Transfers</span>
          {activeTransfersCount > 0 && <span className="badge badge-source-count">{activeTransfersCount}</span>}
        </button>
        <button
          type="button"
          className="nav-link"
          aria-current={currentView === 'network' ? 'page' : undefined}
          onClick={() => navigateTo('network')}
        >
          <span>Network</span>
          <span className={`badge ${isNetworkConnected ? 'badge-connected' : 'badge-connecting'}`} style={{ marginLeft: 'auto' }}>
            {peer.state.groups.length > 0 ? `${peer.state.groups.length} Groups` : 'Offline'}
          </span>
        </button>
        <button
          type="button"
          className="nav-link"
          aria-current={currentView === 'appearance' ? 'page' : undefined}
          onClick={() => navigateTo('appearance')}
        >
          <span>Appearance</span>
        </button>
      </nav>

      {/* Main Workspace */}
      <main className="workspace" id="workspace-main">
        {currentView === 'home' && (
          <div className="view-content">
            <h1 id="home-heading" ref={workspaceHeadingRef} tabIndex={-1} className="view-title">
              p2p-multiple-groups
            </h1>

            <div className="action-rows">
              <button
                type="button"
                className="action-row-btn"
                onClick={() => navigateTo('search')}
              >
                <span className="action-row-label">Search files</span>
                <span className="shortcut-badge">Browse</span>
              </button>

              <button
                type="button"
                className="action-row-btn"
                onClick={() => navigateTo('library')}
              >
                <span className="action-row-label">Share files</span>
                <span className="shortcut-badge">Library</span>
              </button>

              <button
                type="button"
                className="action-row-btn"
                onClick={() => navigateTo('network')}
              >
                <span className="action-row-label">Manage groups</span>
                <span className="shortcut-badge">{isNetworkConnected ? `${peer.state.groups.length} Active` : 'Offline'}</span>
              </button>

              <button
                type="button"
                className="action-row-btn"
                onClick={openPalette}
                aria-label={`Open commands (${modifierLabel}+K)`}
              >
                <span className="action-row-label">Open commands</span>
                <span className="shortcut-badge">{modifierLabel}+K</span>
              </button>

              <button
                type="button"
                className="action-row-btn"
                onClick={() => navigateTo('appearance')}
                aria-label={`Appearance (${modifierLabel}+,)`}
              >
                <span className="action-row-label">Appearance</span>
                <span className="shortcut-badge">{modifierLabel}+,</span>
              </button>
            </div>
          </div>
        )}

        {currentView === 'search' && (
          <Search
            headingRef={workspaceHeadingRef}
            groups={peer.state.groups}
            selectedGroupKey={peer.selectedGroupKey}
            onSelectGroup={peer.setSelectedGroupKey}
            search={peer.state.search}
            isNetworkConnected={isNetworkConnected}
            onSearch={peer.search}
            onDownload={peer.download}
          />
        )}

        {currentView === 'library' && (
          <Library
            headingRef={workspaceHeadingRef}
            library={peer.state.library}
            groups={peer.state.groups}
            selectedGroupKey={peer.selectedGroupKey}
            onAddFiles={peer.addFiles}
            onRescan={peer.rescanLibrary}
            onRemoveFile={peer.removeFile}
            onSetFileGroups={peer.setFileGroups}
          />
        )}

        {currentView === 'transfers' && (
          <Transfers
            headingRef={workspaceHeadingRef}
            transfers={peer.state.transfers}
            groups={peer.state.groups}
            onCancelTransfer={peer.cancelTransfer}
            onSearchAgain={(filename) => {
              navigateTo('search')
              void peer.search(filename)
            }}
          />
        )}

        {currentView === 'network' && (
          <Network
            headingRef={workspaceHeadingRef}
            groups={peer.state.groups}
            selectedGroupKey={peer.selectedGroupKey}
            onSelectGroup={peer.setSelectedGroupKey}
            identity={peer.state.identity}
            onJoinGroup={peer.joinGroup}
            onLeaveGroup={peer.leaveGroup}
            onSetGroupAutoJoin={peer.setGroupAutoJoin}
            onSetGroupEligibility={peer.setSupernodeEligible}
            onForgetGroup={peer.forgetGroup}
            onDisconnectAll={peer.disconnectAll}
            network={peer.state.network}
            recoveryEvents={peer.state.recoveryEvents}
            onConnect={peer.connect}
            onDisconnect={peer.disconnect}
            onSetEligibility={peer.setSupernodeEligible}
          />
        )}

        {currentView === 'appearance' && (
          <Appearance
            currentTheme={currentTheme}
            isLoading={isThemeLoading}
            isSaving={isThemeSaving}
            errorMessage={themeErrorMessage}
            headingRef={workspaceHeadingRef}
            onThemeSelect={(selectedTheme) => {
              void persistTheme(selectedTheme).catch(() => {})
            }}
          />
        )}
      </main>

      {/* Command Palette */}
      <CommandPalette
        isOpen={isPaletteOpen}
        openRequest={openRequest}
        onClose={handlePaletteClose}
        onExecute={executeCommand}
      />
    </div>
  )
}
