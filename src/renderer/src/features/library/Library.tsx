import React, { useState } from 'react'
import type { ActionResult, P2pLibraryState } from '../../../../shared/p2p.ts'

interface LibraryProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>
  library: P2pLibraryState
  onAddFiles: () => Promise<ActionResult>
  onRescan: () => Promise<ActionResult>
  onRemoveFile: (fileId: string) => Promise<ActionResult>
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i] || 'B'}`
}

export const Library: React.FC<LibraryProps> = ({
  headingRef,
  library,
  onAddFiles,
  onRescan,
  onRemoveFile
}) => {
  const [isBusy, setIsBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const handleAddClick = async (): Promise<void> => {
    setIsBusy(true)
    setActionError(null)
    const res = await onAddFiles()
    setIsBusy(false)
    if (!res.ok) {
      setActionError(`${res.code}: ${res.message}`)
    }
  }

  const handleRescanClick = async (): Promise<void> => {
    setIsBusy(true)
    setActionError(null)
    const res = await onRescan()
    setIsBusy(false)
    if (!res.ok) {
      setActionError(`${res.code}: ${res.message}`)
    }
  }

  const handleRemoveClick = async (fileId: string): Promise<void> => {
    setIsBusy(true)
    setActionError(null)
    const res = await onRemoveFile(fileId)
    setIsBusy(false)
    if (!res.ok) {
      setActionError(`${res.code}: ${res.message}`)
    }
  }

  const isIndexed =
    library.acknowledgedGeneration !== null &&
    library.acknowledgedGeneration === library.advertisedGeneration

  return (
    <section className="view-content fluid-content" aria-labelledby="library-heading">
      <div className="view-header-row">
        <h1 id="library-heading" ref={headingRef} tabIndex={-1} className="view-heading">
          Shared Library
        </h1>
        <div className="view-actions">
          <button
            type="button"
            className="action-button primary-button"
            onClick={handleAddClick}
            disabled={isBusy}
          >
            Add files
          </button>
          <button
            type="button"
            className="action-button secondary-button"
            onClick={handleRescanClick}
            disabled={isBusy || library.status === 'scanning'}
          >
            {library.status === 'scanning' ? 'Verifying...' : 'Rescan library'}
          </button>
        </div>
      </div>

      <div className="info-banner" role="note">
        <strong>Selected files only:</strong> Only files you explicitly choose are shared with the network. Removing an entry stops sharing and will never delete your original file.
      </div>

      {actionError && (
        <div className="error-message" role="alert">
          {actionError}
        </div>
      )}

      <div className="library-index-status">
        <span>Catalogue status: </span>
        <span className={`badge ${isIndexed ? 'badge-connected' : 'badge-connecting'}`}>
          {isIndexed ? 'Indexed & Acknowledged' : 'Indexing in progress...'}
        </span>
        <span className="subtle-text" style={{ marginLeft: '8px' }}>
          (Gen #{library.advertisedGeneration || 0})
        </span>
      </div>

      {library.files.length === 0 ? (
        <div className="empty-state-panel">
          <p className="empty-title">No files shared yet</p>
          <p className="empty-hint">
            Click "Add files" above to select files from your computer to share with peers.
          </p>
        </div>
      ) : (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Filename</th>
                <th>Size</th>
                <th>SHA-256</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {library.files.map((file) => (
                <tr key={file.fileId}>
                  <td className="filename-cell" title={file.name}>
                    {file.name}
                    {file.message && <div className="cell-subtext error-text">{file.message}</div>}
                  </td>
                  <td>{formatBytes(file.size)}</td>
                  <td className="code-cell">{file.sha256 ? file.sha256.slice(0, 12) + '...' : '—'}</td>
                  <td>
                    <span className={`badge badge-file-${file.status}`}>{file.status}</span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="inline-action-btn danger-btn"
                      onClick={() => void handleRemoveClick(file.fileId)}
                      disabled={isBusy}
                      title="Stop sharing this file"
                    >
                      Stop sharing
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
