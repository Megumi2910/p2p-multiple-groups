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
  return window.p2p
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

    if (!b) {
      setInitError('Shell bridge unavailable. Ensure preload script loaded properly.')
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
      .catch((error) => {
        console.error('[renderer] Failed to load initial theme:', error)
        if (isSubscribed) {
          setThemeErrorMessage('Failed to load appearance preferences')
          setIsThemeLoading(false)
        }
      })

    return () => {
      isSubscribed = false
    }
  }, [])

  const openPalette = useCallback((): void => {
    if (!isPaletteOpen) {
      lastActiveElementRef.current = document.activeElement as HTMLElement | null
    }
    setOpenRequest((c) => c + 1)
    setIsPaletteOpen(true)
  }, [isPaletteOpen])

  const navigateTo = useCallback((view: View): void => {
    setCurrentView(view)
  }, [])

  useEffect(() => {
    workspaceHeadingRef.current?.focus()
  }, [currentView])

  // Subscribe to native menu commands
  useEffect(() => {
    const b = getBridge()
    if (!b) return

    const unsubscribe = b.onCommand((command: ShellCommand) => {
      switch (command) {
        case 'open-command-palette':
          openPalette()
          break
        case 'open-appearance':
          setIsPaletteOpen(false)
          navigateTo('appearance')
          break
      }
    })

    return () => {
      unsubscribe()
    }
  }, [openPalette, navigateTo])

  // Keyboard shortcut listener for Command Palette (Cmd+K / Ctrl+K)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const modifier = isMac ? event.metaKey : event.ctrlKey
      if (modifier && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        openPalette()
      }
      if (modifier && event.key === ',') {
        event.preventDefault()
        setIsPaletteOpen(false)
        navigateTo('appearance')
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isMac, openPalette, navigateTo])

  const persistTheme = async (theme: ThemePreference): Promise<void> => {
    const b = getBridge()
    if (!b || isSavingThemeRef.current) return

    isSavingThemeRef.current = true
    setIsThemeSaving(true)
    setThemeErrorMessage(null)

    try {
      const savedTheme = await b.setTheme(theme)
      setCurrentTheme(savedTheme)
    } catch (error) {
      console.error('[renderer] Failed to save theme:', error)
      setThemeErrorMessage('Failed to save appearance settings. Please try again.')
      throw error
    } finally {
      isSavingThemeRef.current = false
      setIsThemeSaving(false)
    }
  }

  const handlePaletteClose = (): void => {
    setIsPaletteOpen(false)
    requestAnimationFrame(() => {
      if (lastActiveElementRef.current && lastActiveElementRef.current.isConnected && typeof lastActiveElementRef.current.focus === 'function') {
        lastActiveElementRef.current.focus()
      } else {
        workspaceHeadingRef.current?.focus()
      }
    })
  }

  const executeCommand = async (id: CommandId): Promise<void> => {
    switch (id) {
      case 'navigate-home':
        navigateTo('home')
        break
      case 'navigate-search':
        navigateTo('search')
        break
      case 'navigate-library':
        navigateTo('library')
        break
      case 'navigate-transfers':
        navigateTo('transfers')
        break
      case 'navigate-network':
        navigateTo('network')
        break
      case 'open-appearance':
        navigateTo('appearance')
        break
      case 'theme-system':
        await persistTheme('system')
        break
      case 'theme-light':
        await persistTheme('light')
        break
      case 'theme-dark':
        await persistTheme('dark')
        break
    }
  }

  if (initError) {
    return (
      <div className="fatal-error-screen" role="alert">
        <h1 className="fatal-error-title">Startup Error</h1>
        <p className="fatal-error-message">{initError}</p>
      </div>
    )
  }

  const isNetworkConnected = peer.state.groups.some((g) => g.network.status === 'connected')

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
                <span className="action-row-label">Search Files</span>
              </button>

              <button
                type="button"
                className="action-row-btn"
                onClick={() => navigateTo('library')}
              >
                <span className="action-row-label">Library</span>
              </button>

              <button
                type="button"
                className="action-row-btn"
                onClick={() => navigateTo('transfers')}
              >
                <span className="action-row-label">Transfers</span>
                {activeTransfersCount > 0 && (
                  <span className="badge badge-source-count">{activeTransfersCount} active</span>
                )}
              </button>

              <button
                type="button"
                className="action-row-btn"
                onClick={() => navigateTo('network')}
              >
                <span className="action-row-label">Network & Groups</span>
                <span className={`badge ${isNetworkConnected ? 'badge-connected' : 'badge-connecting'}`}>
                  {peer.state.groups.length > 0 ? `${peer.state.groups.length} Groups` : 'Offline'}
                </span>
              </button>

              <button
                type="button"
                className="action-row-btn"
                onClick={openPalette}
                aria-label={`Command Palette (${modifierLabel}+K)`}
              >
                <span className="action-row-label">Command Palette</span>
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
            search={peer.state.groups.find((g) => g.groupKey === peer.selectedGroupKey)?.search}
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
            onSearchAgain={(filename, groupKey) => {
              navigateTo('search')
              if (groupKey) {
                peer.setSelectedGroupKey(groupKey)
                void peer.search(groupKey, filename)
              } else if (peer.selectedGroupKey) {
                void peer.search(peer.selectedGroupKey, filename)
              }
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
            defaultSignalingUrl={peer.state.defaultSignalingUrl}
            onCreateGroup={peer.createGroup}
            onJoinGroup={peer.joinGroup}
            onLeaveGroup={peer.leaveGroup}
            onRotateGroupInvite={peer.rotateGroupInvite}
            onRemoveGroupMember={peer.removeGroupMember}
            onSetGroupAutoJoin={peer.setGroupAutoJoin}
            onSetGroupEligibility={peer.setGroupEligibility}
            onForgetGroup={peer.forgetGroup}
            onDisconnectAll={peer.disconnectAll}
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
