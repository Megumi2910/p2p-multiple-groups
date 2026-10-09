import React, { useState } from 'react'
import type {
  ActionResult,
  GroupKey,
  MultiGroupLibraryFile,
  MultiGroupP2pState,
  P2pGroupState,
  P2pLibraryState
} from '../../../../shared/p2p.ts'

interface LibraryProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>
  library: {
    status: 'idle' | 'scanning'
    files: MultiGroupLibraryFile[]
    advertisedGeneration?: number | null
    acknowledgedGeneration?: number | null
  }
  groups?: P2pGroupState[]
  selectedGroupKey?: string | null
  onAddFiles: (groupKey?: GroupKey | null) => Promise<ActionResult>
  onRescan: () => Promise<ActionResult>
  onRemoveFile: (fileId: string) => Promise<ActionResult>
  onSetFileGroups?: (fileId: string, groupKeys: GroupKey[]) => Promise<ActionResult>
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
  groups = [],
  selectedGroupKey = null,
  onAddFiles,
  onRescan,
  onRemoveFile,
  onSetFileGroups
}) => {
  const [isBusy, setIsBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [editingFileId, setEditingFileId] = useState<string | null>(null)
  const [targetGroupKey, setTargetGroupKey] = useState<string>(selectedGroupKey || groups[0]?.groupKey || '')

  const handleAddClick = async (): Promise<void> => {
    setIsBusy(true)
    setActionError(null)
    const res = await onAddFiles(targetGroupKey || null)
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

  const handleGrantToggle = async (file: MultiGroupLibraryFile, groupKey: string, granted: boolean): Promise<void> => {
    if (!onSetFileGroups) return
    setIsBusy(true)
    setActionError(null)
    const currentKeys = file.groupKeys || []
    const updated = granted
      ? Array.from(new Set([...currentKeys, groupKey]))
      : currentKeys.filter((k) => k !== groupKey)
    const res = await onSetFileGroups(file.fileId, updated)
    setIsBusy(false)
    if (!res.ok) {
      setActionError(`${res.code}: ${res.message}`)
    }
  }

  const isIndexed =
    library.acknowledgedGeneration !== null &&
    library.acknowledgedGeneration === library.advertisedGeneration

  const editingFile = library.files.find((f) => f.fileId === editingFileId)

  return (
    <section className="view-content fluid-content" aria-labelledby="library-heading">
      <div className="view-header-row">
        <h1 id="library-heading" ref={headingRef} tabIndex={-1} className="view-heading">
          Shared Library
        </h1>
        <div className="view-actions" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {groups.length > 0 && (
            <select
              className="text-input"
              style={{ width: 'auto', padding: '6px 12px' }}
              value={targetGroupKey}
              onChange={(e) => setTargetGroupKey(e.target.value)}
              disabled={isBusy}
              title="Target group for adding new files"
            >
              <option value="">No initial group</option>
              {groups.map((g) => (
                <option key={g.groupKey} value={g.groupKey}>
                  Add to: {g.groupId}
                </option>
              ))}
            </select>
          )}

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
        <strong>Explicit Grants:</strong> Each shared file is only accessible to groups you explicitly grant. Removing an entry stops sharing and will never delete your original file.
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

      {/* Grant Editor Modal */}
      {editingFile && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            border: '1px solid var(--color-border)',
            borderRadius: '8px',
            padding: '16px',
            backgroundColor: 'var(--color-bg-panel, #222)',
            marginBottom: '16px'
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h3 style={{ margin: 0, fontSize: '15px' }}>
              Edit Group Grants for: <strong>{editingFile.name}</strong>
            </h3>
            <button
              type="button"
              className="action-button secondary-button"
              style={{ padding: '2px 8px' }}
              onClick={() => setEditingFileId(null)}
            >
              Close
            </button>
          </div>
          {groups.length === 0 ? (
            <p className="empty-hint">No joined groups available. Join a group first to grant access to this file.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {groups.map((g) => {
                const isGranted = Boolean(editingFile.groupKeys?.includes(g.groupKey))
                return (
                  <label key={g.groupKey} className="checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="checkbox"
                      checked={isGranted}
                      disabled={isBusy}
                      onChange={(e) => void handleGrantToggle(editingFile, g.groupKey, e.target.checked)}
                    />
                    <span>
                      <strong>{g.groupId}</strong> ({g.network.status})
                    </span>
                  </label>
                )
              })}
            </div>
          )}
        </div>
      )}

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
                <th>Shared In Groups</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {library.files.map((file) => {
                const grantedKeys = file.groupKeys || []
                return (
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
                      {grantedKeys.length === 0 ? (
                        <span className="subtle-text" style={{ fontSize: '12px' }}>
                          Unshared (No groups)
                        </span>
                      ) : (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                          {grantedKeys.map((gk) => {
                            const grp = groups.find((g) => g.groupKey === gk)
                            return (
                              <span
                                key={gk}
                                className="badge badge-connected"
                                style={{ fontSize: '11px', padding: '1px 6px' }}
                                title={gk}
                              >
                                {grp?.groupId || gk.split('#')[0] || 'Group'}
                              </span>
                            )
                          })}
                        </div>
                      )}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                          type="button"
                          className="action-button secondary-button"
                          style={{ padding: '2px 8px', fontSize: '12px' }}
                          onClick={() => setEditingFileId(editingFileId === file.fileId ? null : file.fileId)}
                          disabled={isBusy}
                          title="Configure which groups have access to this file"
                        >
                          Grants
                        </button>
                        <button
                          type="button"
                          className="inline-action-btn danger-btn"
                          onClick={() => void handleRemoveClick(file.fileId)}
                          disabled={isBusy}
                          title="Stop sharing this file across all groups"
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
