import React, { useState } from 'react'
import type {
  ActionResult,
  MultiGroupTransfer,
  P2pGroupState
} from '../../../../shared/p2p.ts'

interface TransfersProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>
  transfers: MultiGroupTransfer[]
  groups?: P2pGroupState[]
  onResumeTransfer?: (transferId: string) => Promise<ActionResult>
  onStopTransfer?: (transferId: string) => Promise<ActionResult>
  onCancelTransfer: (transferId: string) => Promise<ActionResult>
  onSearchAgain?: (filename: string, groupKey: string) => void
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i] || 'B'}`
}

function formatTimestamp(ts?: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const now = new Date()
  const isSameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (isSameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  }
  return d.toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

function formatDuration(startedAt?: number, updatedAt?: number): string | null {
  if (!startedAt || !updatedAt || updatedAt < startedAt) return null
  const secs = Math.max(0, Math.round((updatedAt - startedAt) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`
}

function formatPath(path: MultiGroupTransfer['path']): string {
  switch (path) {
    case 'direct':
      return 'Direct'
    case 'relay':
      return 'Relayed (TURN)'
    default:
      return 'Detecting route...'
  }
}

export const Transfers: React.FC<TransfersProps> = ({
  headingRef,
  transfers,
  groups = [],
  onResumeTransfer,
  onStopTransfer,
  onCancelTransfer,
  onSearchAgain
}) => {
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyTransferId, setBusyTransferId] = useState<string | null>(null)

  const handleResumeClick = async (transferId: string): Promise<void> => {
    if (!onResumeTransfer) return
    setActionError(null)
    setBusyTransferId(transferId)
    const res = await onResumeTransfer(transferId)
    setBusyTransferId(null)
    if (!res.ok) {
      setActionError(`${res.code}: ${res.message}`)
    }
  }

  const handleStopClick = async (transferId: string): Promise<void> => {
    if (!onStopTransfer) return
    setActionError(null)
    setBusyTransferId(transferId)
    const res = await onStopTransfer(transferId)
    setBusyTransferId(null)
    if (!res.ok) {
      setActionError(`${res.code}: ${res.message}`)
    }
  }

  const handleCancelClick = async (transferId: string): Promise<void> => {
    setActionError(null)
    setBusyTransferId(transferId)
    const res = await onCancelTransfer(transferId)
    setBusyTransferId(null)
    if (!res.ok) {
      setActionError(`${res.code}: ${res.message}`)
    }
  }

  const activeTransfers = transfers.filter(
    (t) => t.state === 'transferring' || t.state === 'connecting' || t.state === 'verifying'
  )
  const completedTransfers = transfers.filter(
    (t) => t.state === 'completed' || t.state === 'failed' || t.state === 'cancelled'
  )

  const groupMap = new Map<string, string>()
  for (const g of groups) {
    groupMap.set(g.groupKey, g.groupId)
  }

  return (
    <section className="view-content fluid-content" aria-labelledby="transfers-heading">
      <h1 id="transfers-heading" ref={headingRef} tabIndex={-1} className="view-heading">
        File Transfers
      </h1>

      {actionError && (
        <div className="error-message" role="alert" style={{ marginBottom: '16px' }}>
          {actionError}
        </div>
      )}

      {/* Active Transfers */}
      <div className="transfers-section" style={{ marginBottom: '32px' }}>
        <div className="view-header-row" style={{ marginBottom: '8px' }}>
          <h2 className="section-subheading" style={{ margin: 0 }}>
            Active Transfers ({activeTransfers.length})
          </h2>
        </div>

        {activeTransfers.length === 0 ? (
          <p className="empty-hint">No file transfers are currently in progress.</p>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Filename</th>
                  <th>Group</th>
                  <th>Direction</th>
                  <th>Peer</th>
                  <th>Progress</th>
                  <th>Status</th>
                  <th>Path</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {activeTransfers.map((t) => {
                  const percent = t.size > 0 ? Math.min(100, Math.round((t.transferredBytes / t.size) * 100)) : 0
                  const isUploading = t.direction === 'upload'
                  const groupDisplay = (t.groupKey && groupMap.get(t.groupKey)) || t.groupId || 'Default'

                  return (
                    <tr key={t.id}>
                      <td className="filename-cell">
                        <strong>{t.fileName}</strong>
                      </td>
                      <td>
                        <span className="badge badge-group" style={{ fontSize: '11px' }}>{groupDisplay}</span>
                      </td>
                      <td>
                        <span className={`badge badge-direction-${t.direction}`}>{t.direction}</span>
                      </td>
                      <td>{t.peerName}</td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <span style={{ fontSize: '12px' }}>
                            {formatBytes(t.transferredBytes)} / {formatBytes(t.size)} ({percent}%)
                          </span>
                          <div
                            className="progress-bar-container"
                            role="progressbar"
                            aria-valuenow={percent}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-label={`Transfer progress for ${t.fileName}`}
                          >
                            <div
                              className="progress-bar-fill"
                              style={{ width: `${percent}%` }}
                            />
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className={`badge badge-${t.state}`}>{t.state}</span>
                        {t.message && <div style={{ fontSize: '11px', color: 'var(--muted)' }}>{t.message}</div>}
                      </td>
                      <td>
                        <span style={{ fontSize: '12px' }}>{formatPath(t.path)}</span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                          {!isUploading && onStopTransfer && (t.state === 'connecting' || t.state === 'transferring') && (
                            <button
                              type="button"
                              className="action-button secondary-button"
                              style={{ padding: '2px 8px', fontSize: '12px' }}
                              onClick={() => void handleStopClick(t.id)}
                              disabled={busyTransferId === t.id}
                              title="Stop download and keep partial file so you can Resume later"
                            >
                              {busyTransferId === t.id ? 'Stopping...' : 'Stop'}
                            </button>
                          )}
                          <button
                            type="button"
                            className="action-button secondary-button"
                            style={{ padding: '2px 8px', fontSize: '12px' }}
                            onClick={() => void handleCancelClick(t.id)}
                            disabled={busyTransferId === t.id}
                            title="Cancel transfer and discard partial data"
                          >
                            Cancel
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
      </div>

      {/* Completed Transfers */}
      <div className="transfers-section">
        <div className="view-header-row" style={{ marginBottom: '8px' }}>
          <h2 className="section-subheading" style={{ margin: 0 }}>
            Recent History ({completedTransfers.length})
          </h2>
        </div>

        {completedTransfers.length === 0 ? (
          <p className="empty-hint">Completed uploads and downloads will appear here.</p>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Filename</th>
                  <th>Group</th>
                  <th>Direction</th>
                  <th>Peer</th>
                  <th>Size</th>
                  <th>Time</th>
                  <th>Result</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {completedTransfers.map((t) => {
                  const groupDisplay = (t.groupKey && groupMap.get(t.groupKey)) || t.groupId || 'Default'
                  const ts = t.updatedAt ?? t.startedAt
                  const duration = formatDuration(t.startedAt, t.updatedAt)
                  const isStopped = t.state === 'failed' && Boolean(t.canResume) && t.message === 'Stopped by user'
                  const hasDownloadActions =
                    t.direction === 'download' &&
                    (t.state === 'failed' || (t.state === 'cancelled' && Boolean(onSearchAgain)))
                  return (
                    <tr key={t.id}>
                      <td className="filename-cell">
                        <strong>{t.fileName}</strong>
                      </td>
                      <td>
                        <span className="badge badge-group" style={{ fontSize: '11px' }}>{groupDisplay}</span>
                      </td>
                      <td>
                        <span className={`badge badge-direction-${t.direction}`}>{t.direction}</span>
                      </td>
                      <td>{t.peerName}</td>
                      <td>
                        {t.state === 'failed' && t.canResume && t.size > 0 ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                            <span>{formatBytes(t.transferredBytes)} / {formatBytes(t.size)}</span>
                            <span style={{ fontSize: '11px', color: 'var(--muted)' }}>
                              {Math.round((t.transferredBytes / t.size) * 100)}% saved
                            </span>
                          </div>
                        ) : (
                          formatBytes(t.size)
                        )}
                      </td>
                      <td title={ts ? new Date(ts).toLocaleString() : undefined}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', whiteSpace: 'nowrap' }}>
                          <span style={{ fontSize: '12px' }}>{formatTimestamp(ts)}</span>
                          {duration && (
                            <span style={{ fontSize: '11px', color: 'var(--muted)' }}>
                              {duration}
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <span className={`badge badge-${t.state}`}>
                          {isStopped ? 'Stopped' : t.state === 'failed' && t.canResume ? 'Interrupted' : t.state}
                        </span>
                        {t.message && (
                          <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
                            {t.message}
                          </div>
                        )}
                      </td>
                      <td>
                        {hasDownloadActions ? (
                          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                            {t.state === 'failed' && t.canResume && onResumeTransfer && t.direction === 'download' && (
                              <button
                                type="button"
                                className="action-button primary-button"
                                style={{ padding: '2px 8px', fontSize: '12px' }}
                                onClick={() => void handleResumeClick(t.id)}
                                disabled={busyTransferId === t.id}
                              >
                                {busyTransferId === t.id ? 'Resuming...' : 'Resume'}
                              </button>
                            )}
                            {t.state === 'failed' && t.canResume && t.direction === 'download' && (
                              <button
                                type="button"
                                className="action-button secondary-button"
                                style={{ padding: '2px 8px', fontSize: '12px' }}
                                onClick={() => void handleCancelClick(t.id)}
                                disabled={busyTransferId === t.id}
                              >
                                Cancel
                              </button>
                            )}
                            {(t.state === 'failed' || t.state === 'cancelled') && onSearchAgain && t.direction === 'download' && (
                              <button
                                type="button"
                                className="action-button secondary-button"
                                style={{ padding: '2px 8px', fontSize: '12px' }}
                                onClick={() => onSearchAgain(t.fileName, t.groupKey)}
                              >
                                Search Again
                              </button>
                            )}
                          </div>
                        ) : (
                          <span style={{ fontSize: '12px', color: 'var(--muted)' }}>—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}
