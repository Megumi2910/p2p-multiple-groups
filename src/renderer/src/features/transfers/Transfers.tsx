import React from 'react'
import type { ActionResult, P2pTransfer } from '../../../../shared/p2p.ts'

interface TransfersProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>
  transfers: P2pTransfer[]
  onCancelTransfer: (transferId: string) => Promise<ActionResult>
  onSearchAgain: (filename: string) => void
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i] || 'B'}`
}

function formatPath(path: P2pTransfer['path']): string {
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
  onCancelTransfer,
  onSearchAgain
}) => {
  const activeTransfers = transfers.filter(
    (t) => t.state === 'transferring' || t.state === 'connecting' || t.state === 'verifying'
  )
  const completedTransfers = transfers.filter(
    (t) => t.state === 'completed' || t.state === 'failed' || t.state === 'cancelled'
  )

  return (
    <section className="view-content fluid-content" aria-labelledby="transfers-heading">
      <h1 id="transfers-heading" ref={headingRef} tabIndex={-1} className="view-heading">
        Transfers
      </h1>

      <div className="transfers-section">
        <h2 className="section-subheading">Active Transfers ({activeTransfers.length})</h2>
        {activeTransfers.length === 0 ? (
          <p className="empty-hint">No transfers currently in progress.</p>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Direction</th>
                  <th>Filename</th>
                  <th>Peer</th>
                  <th>Progress</th>
                  <th>Path</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {activeTransfers.map((t) => {
                  const percent = t.size > 0 ? Math.round((t.transferredBytes / t.size) * 100) : 100

                  return (
                    <tr key={t.id}>
                      <td>
                        <span className={`badge badge-dir-${t.direction}`}>{t.direction}</span>
                      </td>
                      <td className="filename-cell" title={t.fileName}>
                        {t.fileName}
                      </td>
                      <td>{t.peerName}</td>
                      <td className="progress-cell">
                        <div
                          className="progress-bar-container"
                          role="progressbar"
                          aria-valuenow={percent}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-label={`${t.fileName} transfer progress`}
                        >
                          <div className="progress-bar-fill" style={{ width: `${percent}%` }} />
                        </div>
                        <div className="progress-numbers">
                          <span>
                            {formatBytes(t.transferredBytes)} / {formatBytes(t.size)}
                          </span>
                          <span>{percent}%</span>
                        </div>
                      </td>
                      <td>
                        <span className={`badge badge-path-${t.path}`}>{formatPath(t.path)}</span>
                      </td>
                      <td>
                        <span className={`badge badge-state-${t.state}`}>{t.state}</span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="inline-action-btn danger-btn"
                          onClick={() => void onCancelTransfer(t.id)}
                          aria-label={`Cancel ${t.fileName}`}
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

      <div className="transfers-section" style={{ marginTop: '28px' }}>
        <h2 className="section-subheading">Recent Transfers ({completedTransfers.length})</h2>
        {completedTransfers.length === 0 ? (
          <p className="empty-hint">No recent transfer history.</p>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Direction</th>
                  <th>Filename</th>
                  <th>Size</th>
                  <th>Status</th>
                  <th>Details</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {completedTransfers.slice(0, 50).map((t) => (
                  <tr key={t.id}>
                    <td>
                      <span className={`badge badge-dir-${t.direction}`}>{t.direction}</span>
                    </td>
                    <td className="filename-cell" title={t.fileName}>
                      {t.fileName}
                    </td>
                    <td>{formatBytes(t.size)}</td>
                    <td>
                      <span className={`badge badge-state-${t.state}`}>{t.state}</span>
                    </td>
                    <td className="message-cell">{t.message || '—'}</td>
                    <td>
                      {t.state === 'failed' && t.direction === 'download' && (
                        <button
                          type="button"
                          className="inline-action-btn secondary-btn"
                          onClick={() => onSearchAgain(t.fileName)}
                        >
                          Search again
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}
