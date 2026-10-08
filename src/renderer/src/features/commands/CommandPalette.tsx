import React, { useEffect, useRef, useState } from 'react'
import {
  filterCommands,
  type CommandDescriptor,
  type CommandId
} from './commands.ts'

interface CommandPaletteProps {
  isOpen: boolean
  openRequest: number
  onClose: () => void
  onExecute: (id: CommandId) => Promise<void>
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  openRequest,
  onClose,
  onExecute
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const activeOptionRef = useRef<HTMLLIElement>(null)
  const prevOpenRef = useRef(false)
  const prevRequestRef = useRef(openRequest)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [isBusy, setIsBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const filteredCommands: CommandDescriptor[] = filterCommands(query)

  // Sync dialog modal visibility with isOpen prop and openRequest counter
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (isOpen) {
      if (!dialog.open) {
        dialog.showModal()
        setQuery('')
        setSelectedIndex(0)
        setErrorMessage(null)
        setIsBusy(false)
        requestAnimationFrame(() => {
          inputRef.current?.focus()
        })
      } else if (openRequest !== prevRequestRef.current) {
        // Re-request while already open: only focus the search input, do not reset query/busy
        inputRef.current?.focus()
      }
    } else if (dialog.open) {
      dialog.close()
    }
    prevOpenRef.current = isOpen
    prevRequestRef.current = openRequest
  }, [isOpen, openRequest])
  // Keep selected index in range when filter results change
  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Scroll active option into view
  useEffect(() => {
    activeOptionRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleExecute = async (cmdId: CommandId): Promise<void> => {
    if (isBusy) return
    setIsBusy(true)
    setErrorMessage(null)

    try {
      await onExecute(cmdId)
      setIsBusy(false)
      onClose()
    } catch {
      setIsBusy(false)
      setErrorMessage('Could not execute command. Your previous setting is unchanged.')
      inputRef.current?.focus()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (isBusy) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (filteredCommands.length > 0) {
        setSelectedIndex((prev) => (prev + 1) % filteredCommands.length)
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (filteredCommands.length > 0) {
        setSelectedIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length)
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filteredCommands.length > 0) {
        const target = filteredCommands[selectedIndex]
        if (target) {
          void handleExecute(target.id)
        }
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>): void => {
    if (isBusy) return
    const dialog = dialogRef.current
    if (!dialog) return
    const rect = dialog.getBoundingClientRect()
    const isInside =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom
    if (!isInside) {
      onClose()
    }
  }

  const handleCancel = (e: React.SyntheticEvent<HTMLDialogElement, Event>): void => {
    e.preventDefault()
    if (!isBusy) {
      onClose()
    }
  }

  const activeCommand = filteredCommands[selectedIndex]
  const activeDescendantId = activeCommand ? `cmd-option-${activeCommand.id}` : undefined

  return (
    <dialog
      ref={dialogRef}
      className="command-dialog"
      aria-label="Command palette"
      aria-busy={isBusy}
      onClick={handleBackdropClick}
      onCancel={handleCancel}
    >
      <div className="command-dialog-body">
        <div className="command-search-bar">
          <input
            ref={inputRef}
            type="text"
            className="command-search-input"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={isOpen}
            aria-controls="command-listbox"
            aria-activedescendant={activeDescendantId}
            aria-label="Search commands"
            placeholder="Type a command or search…"
            value={query}
            disabled={isBusy}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>

        {errorMessage && (
          <div className="palette-alert" role="alert">
            {errorMessage}
          </div>
        )}

        <ul id="command-listbox" role="listbox" className="command-listbox" aria-label="Commands">
          {filteredCommands.length === 0 ? (
            <div className="command-empty" role="status">
              No commands found.
            </div>
          ) : (
            filteredCommands.map((cmd, idx) => {
              const isActive = idx === selectedIndex
              return (
                <li
                  key={cmd.id}
                  id={`cmd-option-${cmd.id}`}
                  ref={isActive ? activeOptionRef : null}
                  role="option"
                  aria-selected={isActive}
                  className={`command-option ${isActive ? 'active' : ''}`}
                  onClick={() => {
                    if (!isBusy) {
                      void handleExecute(cmd.id)
                    }
                  }}
                >
                  <span>{cmd.label}</span>
                </li>
              )
            })
          )}
        </ul>
      </div>
    </dialog>
  )
}
