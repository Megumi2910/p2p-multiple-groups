import React from 'react'
import type {
  ActionResult,
  MultiGroupTransfer,
  P2pGroupState,
  P2pTransfer
} from '../../../../shared/p2p.ts'

interface TransfersProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>
  transfers: (P2pTransfer | MultiGroupTransfer)[]
  groups?: P2pGroupState[]
  onCancelTransfer: (transferId: string) => Promise<ActionResult>
  onSearchAgain?: (filename: string) => void
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

  const resolveGroupName = (t: P2pTransfer | MultiGroupTransfer): string | null => {
    if ('groupId' in t && t.groupId) return t.groupId
    if ('groupKey' in t && t.groupKey) {
      const g = groups.find((gr) => gr.groupKey === t.groupKey)
      return g?.groupId || t.groupKey.split('#')[0] || null
    }
    return null
  }

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
                  <th>Group</th>
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
                  const groupName = resolveGroupName(t)

                  return (
                    <tr key={t.id}>
                      <td>
                        <span className={`badge badge-dir-${t.direction}`}>{t.direction}</span>
                      </td>
                      <td className="filename-cell" title={t.fileName}>
                        {t.fileName}
                      </td>
                      <td>
                        {groupName ? (
                          <span className="badge badge-connected" style={{ fontSize: '11px', padding: '1px 6px' }}>
                            {groupName}
                          </span>
                        ) : (
                          <span className="subtle-text">—</span>
                        )}
                      </td>
                      <td>{t.peerName}</td>
                      <td className="progress-cell">
                        <div
                          className="progress-bar-container"
                          role="progressbar"
                          aria-valuenow={percent}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-label={`Transfer progress for ${t.fileName}`}
                        >
                          <div className="progress-bar-fill" style={{ width: `${percent}%` }} />
                        </div>
                        <span className="progress-text">
                          {formatBytes(t.transferredBytes)} / {formatBytes(t.size)} ({percent}%)
                        </span>
                      </td>
                      <td>{formatPath(t.path)}</td>
                      <td>
                        <span className={`badge badge-transfer-${t.state}`}>{t.state}</span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="inline-action-btn danger-btn"
                          onClick={() => void onCancelTransfer(t.id)}
                          aria-label={`Cancel transfer for ${t.fileName}`}
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
        <h2 className="section-subheading">Transfer History ({completedTransfers.length})</h2>
        {completedTransfers.length === 0 ? (
          <p className="empty-hint">Completed and cancelled transfers will appear here.</p>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Direction</th>
                  <th>Filename</th>
                  <th>Group</th>
                  <th>Peer</th>
                  <th>Size</th>
                  <th>Status</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {completedTransfers.map((t) => {
                  const groupName = resolveGroupName(t)

                  return (
                    <tr key={t.id}>
                      <td>
                        <span className={`badge badge-dir-${t.direction}`}>{t.direction}</span>
                      </td>
                      <td className="filename-cell" title={t.fileName}>
                        {t.fileName}
                      </td>
                      <td>
                        {groupName ? (
                          <span className="badge badge-connected" style={{ fontSize: '11px', padding: '1px 6px' }}>
                            {groupName}
                          </span>
                        ) : (
                          <span className="subtle-text">—</span>
                        )}
                      </td>
                      <td>{t.peerName}</td>
                      <td>{formatBytes(t.size)}</td>
                      <td>
                        <span className={`badge badge-transfer-${t.state}`}>{t.state}</span>
                      </td>
                      <td className="cell-subtext" title={t.message || undefined}>
                        {t.message || '—'}
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
