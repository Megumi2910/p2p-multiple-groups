import React from 'react'
import type {
  ActionResult,
  MultiGroupTransfer,
  P2pGroupState
} from '../../../../shared/p2p.ts'

interface TransfersProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>
  transfers: MultiGroupTransfer[]
  groups?: P2pGroupState[]
  onCancelTransfer: (transferId: string) => Promise<ActionResult>
  onSearchAgain?: (filename: string, groupKey: string) => void
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i] || 'B'}`
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
  onCancelTransfer,
  onSearchAgain
}) => {
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
                        {t.message && <div style={{ fontSize: '11px', color: 'var(--color-muted)' }}>{t.message}</div>}
                      </td>
                      <td>
                        <span style={{ fontSize: '12px' }}>{formatPath(t.path)}</span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="action-button secondary-button"
                          style={{ padding: '2px 8px', fontSize: '12px' }}
                          onClick={() => onCancelTransfer(t.id)}
                        >
                          Cancel
                        </button>
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
                  <th>Result</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {completedTransfers.map((t) => {
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
                      <td>{formatBytes(t.size)}</td>
                      <td>
                        <span className={`badge badge-${t.state}`}>{t.state}</span>
                        {t.message && (
                          <div style={{ fontSize: '11px', color: 'var(--color-muted)' }}>
                            {t.message}
                          </div>
                        )}
                      </td>
                      <td>
                        {t.state === 'failed' && onSearchAgain && t.direction === 'download' && (
                          <button
                            type="button"
                            className="action-button secondary-button"
                            style={{ padding: '2px 8px', fontSize: '12px' }}
                            onClick={() => onSearchAgain(t.fileName, t.groupKey)}
                          >
                            Search Again
                          </button>
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
