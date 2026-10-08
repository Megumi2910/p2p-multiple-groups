import React, { useState } from 'react'
import type {
  ActionResult,
  ConnectOptions,
  P2pNetworkState,
  P2pRecoveryEvent
} from '../../../../shared/p2p.ts'
import { parseNetworkInvitation } from '../../../../shared/p2p.ts'

interface NetworkProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>
  network: P2pNetworkState
  recoveryEvents: P2pRecoveryEvent[]
  onConnect: (options: ConnectOptions) => Promise<ActionResult>
  onDisconnect: () => Promise<ActionResult>
  onSetEligibility: (eligible: boolean) => Promise<ActionResult>
}

export const Network: React.FC<NetworkProps> = ({
  headingRef,
  network,
  recoveryEvents,
  onConnect,
  onDisconnect,
  onSetEligibility
}) => {
  const [displayName, setDisplayName] = useState(network.displayName || '')
  const [invitationText, setInvitationText] = useState('')
  const [eligible, setEligible] = useState(network.supernodeEligible)
  const [relayOnly, setRelayOnly] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const isConnected = network.status === 'connected' || network.status === 'degraded' || network.status === 'recovering'
  const isConnecting = network.status === 'connecting'

  const handleConnectSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setFormError(null)

    const trimmedName = displayName.trim()
    if (!trimmedName) {
      setFormError('Display name is required')
      return
    }

    const invitation = parseNetworkInvitation(invitationText)
    if (!invitation) {
      setFormError('Invalid invitation JSON. Please paste a valid Kazaa network invitation.')
      return
    }

    setIsSubmitting(true)
    // Clear invitation text immediately to avoid echoing secret token in UI
    setInvitationText('')

    const result = await onConnect({
      signalingUrl: invitation.signalingUrl,
      roomId: invitation.roomId,
      token: invitation.token,
      displayName: trimmedName,
      supernodeEligible: eligible,
      relayOnly
    })

    setIsSubmitting(false)
    if (!result.ok) {
      setFormError(`${result.code}: ${result.message}`)
    }
  }

  const handleDisconnectClick = async (): Promise<void> => {
    setIsSubmitting(true)
    await onDisconnect()
    setIsSubmitting(false)
  }

  const handleEligibilityToggle = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const nextVal = e.target.checked
    setEligible(nextVal)
    if (isConnected) {
      await onSetEligibility(nextVal)
    }
  }

  return (
    <section className="view-content fluid-content" aria-labelledby="network-heading">
      <h1 id="network-heading" ref={headingRef} tabIndex={-1} className="view-heading">
        Network
      </h1>

      {network.message && (
        <div className={`status-banner status-${network.status}`} role="status">
          {network.message}
        </div>
      )}

      {!isConnected && !isConnecting ? (
        <div className="network-connect-panel">
          <form className="settings-form" onSubmit={handleConnectSubmit}>
            <div className="form-group">
              <label htmlFor="p2p-display-name" className="form-label">
                Display name
              </label>
              <input
                id="p2p-display-name"
                type="text"
                className="text-input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={40}
                required
                disabled={isSubmitting}
              />
            </div>

            <div className="form-group">
              <label htmlFor="p2p-invitation" className="form-label">
                Network invitation (JSON)
              </label>
              <textarea
                id="p2p-invitation"
                className="text-area-input"
                rows={4}
                value={invitationText}
                onChange={(e) => setInvitationText(e.target.value)}
                placeholder='Paste {"version":1,"signalingUrl":"...","roomId":"...","token":"..."}'
                required
                disabled={isSubmitting}
              />
              <p className="field-hint">
                Paste the invitation provided by the classroom or network operator. The token will not be stored on disk.
              </p>
            </div>

            <div className="checkbox-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={eligible}
                  onChange={handleEligibilityToggle}
                  disabled={isSubmitting}
                />
                Allow this computer to become a supernode
              </label>
              <p className="field-hint">
                Longest-connected eligible peers are chosen to index metadata and route search queries.
              </p>
            </div>

            <div className="checkbox-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={relayOnly}
                  onChange={(e) => setRelayOnly(e.target.checked)}
                  disabled={isSubmitting}
                />
                Force relayed connection (Relay-only / TURN)
              </label>
              <p className="field-hint">
                Forces all peer traffic through the authenticated TURN relay for testing strict NAT environments.
              </p>
            </div>

            {formError && (
              <div className="error-message" role="alert">
                {formError}
              </div>
            )}

            <div className="form-actions">
              <button type="submit" className="action-button primary-button" disabled={isSubmitting}>
                {isSubmitting ? 'Connecting...' : 'Connect to Network'}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <div className="network-active-panel">
          <div className="network-summary-card">
            <div className="summary-row">
              <span className="summary-label">Status:</span>
              <span className={`badge badge-${network.status}`}>{network.status}</span>
            </div>
            <div className="summary-row">
              <span className="summary-label">Your Role:</span>
              <span className={`badge badge-role-${network.role}`}>
                {network.role === 'supernode' ? 'Supernode (Indexing & Routing)' : 'Ordinary Peer'}
              </span>
            </div>
            <div className="summary-row">
              <span className="summary-label">Room:</span>
              <span className="code-text">{network.roomId || 'None'}</span>
            </div>
            {network.role === 'ordinary' && (
              <>
                <div className="summary-row">
                  <span className="summary-label">Primary Supernode:</span>
                  <span className="code-text">{network.primaryPeerId || 'Detecting...'}</span>
                </div>
                <div className="summary-row">
                  <span className="summary-label">Standby Supernode:</span>
                  <span className="code-text">{network.standbyPeerId || 'None'}</span>
                </div>
              </>
            )}

            <div className="checkbox-group" style={{ marginTop: '12px' }}>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={eligible}
                  onChange={handleEligibilityToggle}
                />
                Eligible to become supernode
              </label>
            </div>

            <div className="form-actions" style={{ marginTop: '16px' }}>
              <button
                type="button"
                className="action-button secondary-button"
                onClick={handleDisconnectClick}
                disabled={isSubmitting}
              >
                Disconnect
              </button>
            </div>
          </div>

          <div className="table-section">
            <h2 className="section-subheading">Network Members ({network.members.length})</h2>
            {network.members.length === 0 ? (
              <p className="empty-hint">No peers connected to room.</p>
            ) : (
              <div className="table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Role</th>
                      <th>Order</th>
                      <th>Eligible</th>
                      <th>Peer ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {network.members.map((m) => (
                      <tr key={m.peerId} className={m.peerId === network.peerId ? 'self-row' : ''}>
                        <td>
                          {m.displayName} {m.peerId === network.peerId && '(You)'}
                        </td>
                        <td>
                          <span className={`badge badge-role-${m.role}`}>{m.role}</span>
                        </td>
                        <td>#{m.joinOrder}</td>
                        <td>{m.supernodeEligible ? 'Yes' : 'No'}</td>
                        <td className="code-cell">{m.peerId.slice(0, 8)}...</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="table-section">
            <h2 className="section-subheading">Direct / Relay Links ({network.links.length})</h2>
            {network.links.length === 0 ? (
              <p className="empty-hint">No active peer links.</p>
            ) : (
              <div className="table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Target Peer</th>
                      <th>Link State</th>
                      <th>Transport Path</th>
                    </tr>
                  </thead>
                  <tbody>
                    {network.links.map((link) => (
                      <tr key={link.peerId}>
                        <td className="code-cell">{link.peerId.slice(0, 8)}...</td>
                        <td>
                          <span className={`badge badge-${link.state}`}>{link.state}</span>
                        </td>
                        <td>
                          <span className={`badge badge-path-${link.path}`}>{link.path}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="table-section">
            <h2 className="section-subheading">Recovery & Self-Healing Events</h2>
            {recoveryEvents.length === 0 ? (
              <p className="empty-hint">No recovery events recorded.</p>
            ) : (
              <div className="table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Event</th>
                      <th>Duration</th>
                      <th>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recoveryEvents.slice(0, 20).map((ev) => (
                      <tr key={ev.id}>
                        <td>{new Date(ev.at).toLocaleTimeString()}</td>
                        <td>
                          <span className="badge">{ev.type}</span>
                        </td>
                        <td>{ev.durationMs !== null ? `${ev.durationMs}ms` : '—'}</td>
                        <td className="message-cell">{ev.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
