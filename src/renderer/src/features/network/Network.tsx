import React, { useState } from 'react'
import type {
  ActionResult,
  ConnectOptions,
  GroupKey,
  JoinGroupOptions,
  P2pGroupState,
  P2pNetworkState,
  P2pRecoveryEvent
} from '../../../../shared/p2p.ts'
import { parseGroupInvitation } from '../../../../shared/p2p.ts'

interface NetworkProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>
  groups?: P2pGroupState[]
  selectedGroupKey?: string | null
  onSelectGroup?: (groupKey: string) => void
  identity?: { peerId: string; displayName: string }
  onJoinGroup?: (options: JoinGroupOptions) => Promise<ActionResult>
  onLeaveGroup?: (groupKey: string) => Promise<ActionResult>
  onSetGroupAutoJoin?: (groupKey: string, autoJoin: boolean) => Promise<ActionResult>
  onSetGroupEligibility?: (groupKey: string, eligible: boolean) => Promise<ActionResult>
  onForgetGroup?: (groupKey: string) => Promise<ActionResult>
  onDisconnectAll?: () => Promise<ActionResult>
  // Backward compatibility legacy props
  network?: P2pNetworkState
  recoveryEvents?: P2pRecoveryEvent[]
  onConnect?: (options: ConnectOptions) => Promise<ActionResult>
  onDisconnect?: () => Promise<ActionResult>
  onSetEligibility?: (eligible: boolean) => Promise<ActionResult>
}

export const Network: React.FC<NetworkProps> = ({
  headingRef,
  groups = [],
  selectedGroupKey = null,
  onSelectGroup,
  identity,
  onJoinGroup,
  onLeaveGroup,
  onSetGroupAutoJoin,
  onSetGroupEligibility,
  onForgetGroup,
  onDisconnectAll,
  network,
  recoveryEvents = [],
  onConnect,
  onDisconnect,
  onSetEligibility
}) => {
  const [displayName, setDisplayName] = useState(identity?.displayName || network?.displayName || '')
  const [invitationText, setInvitationText] = useState('')
  const [eligible, setEligible] = useState(true)
  const [autoJoin, setAutoJoin] = useState(true)
  const [rememberInvitation, setRememberInvitation] = useState(true)
  const [relayOnly, setRelayOnly] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)

  const handleJoinSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setFormError(null)
    setActionMessage(null)

    const trimmedName = displayName.trim()
    if (!trimmedName) {
      setFormError('Display name is required')
      return
    }

    const invitation = parseGroupInvitation(invitationText)
    if (!invitation) {
      setFormError('Invalid invitation JSON. Please paste a valid network invitation.')
      return
    }

    setIsSubmitting(true)
    setInvitationText('')

    let result: ActionResult
    if (onJoinGroup) {
      result = await onJoinGroup({
        invitation,
        displayName: trimmedName,
        supernodeEligible: eligible,
        autoJoin,
        relayOnly,
        rememberInvitation
      })
    } else if (onConnect) {
      result = await onConnect({
        signalingUrl: invitation.signalingUrl,
        roomId: invitation.groupId,
        token: invitation.token,
        displayName: trimmedName,
        supernodeEligible: eligible,
        relayOnly
      })
    } else {
      result = { ok: false, code: 'IO_ERROR', message: 'Join handler unavailable' }
    }

    setIsSubmitting(false)
    if (!result.ok) {
      setFormError(`${result.code}: ${result.message}`)
    } else {
      setActionMessage('Successfully joined group!')
    }
  }

  const handleLeaveClick = async (groupKey: string): Promise<void> => {
    if (!onLeaveGroup) return
    setIsSubmitting(true)
    const res = await onLeaveGroup(groupKey)
    setIsSubmitting(false)
    if (!res.ok) {
      setFormError(`${res.code}: ${res.message}`)
    }
  }

  const handleForgetClick = async (groupKey: string): Promise<void> => {
    if (!onForgetGroup) return
    setIsSubmitting(true)
    const res = await onForgetGroup(groupKey)
    setIsSubmitting(false)
    if (!res.ok) {
      setFormError(`${res.code}: ${res.message}`)
    }
  }

  const selectedGroup = groups.find((g) => g.groupKey === selectedGroupKey) || groups[0]

  return (
    <section className="view-content fluid-content" aria-labelledby="network-heading">
      <h1 id="network-heading" ref={headingRef} tabIndex={-1} className="view-heading">
        Network & Groups
      </h1>

      {actionMessage && (
        <div className="status-banner status-connected" role="status">
          {actionMessage}
        </div>
      )}

      {/* Active Groups List */}
      <div className="transfers-section" style={{ marginBottom: '24px' }}>
        <div className="view-header-row" style={{ marginBottom: '12px' }}>
          <h2 className="section-subheading" style={{ margin: 0 }}>
            Joined Groups ({groups.length})
          </h2>
          {groups.length > 0 && onDisconnectAll && (
            <button
              type="button"
              className="action-button secondary-button"
              onClick={() => onDisconnectAll()}
              disabled={isSubmitting}
            >
              Disconnect All
            </button>
          )}
        </div>

        {groups.length === 0 ? (
          <p className="empty-hint">You have not joined any P2P groups yet. Join a group below to start sharing and searching files.</p>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Group ID</th>
                  <th>Status</th>
                  <th>Role</th>
                  <th>Members</th>
                  <th>Auto-Join</th>
                  <th>Supernode</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const isSelected = g.groupKey === (selectedGroupKey || groups[0]?.groupKey)
                  return (
                    <tr
                      key={g.groupKey}
                      style={{
                        backgroundColor: isSelected ? 'var(--color-bg-selected, rgba(66, 153, 225, 0.1))' : undefined,
                        cursor: 'pointer'
                      }}
                      onClick={() => onSelectGroup?.(g.groupKey)}
                    >
                      <td className="filename-cell">
                        <strong>{g.groupId}</strong>
                        {isSelected && <span style={{ marginLeft: '8px', fontSize: '11px', color: 'var(--color-primary)' }}>(active)</span>}
                      </td>
                      <td>
                        <span className={`badge badge-${g.network.status}`}>{g.network.status}</span>
                      </td>
                      <td>
                        <span className={`badge badge-role-${g.network.role}`}>{g.network.role}</span>
                      </td>
                      <td>{g.network.members.length}</td>
                      <td>
                        <input
                          type="checkbox"
                          checked={g.autoJoin}
                          onChange={(e) => onSetGroupAutoJoin?.(g.groupKey, e.target.checked)}
                          onClick={(e) => e.stopPropagation()}
                          title="Automatically rejoin this group on launch"
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={g.network.supernodeEligible}
                          onChange={(e) => onSetGroupEligibility?.(g.groupKey, e.target.checked)}
                          onClick={(e) => e.stopPropagation()}
                          title="Allow this peer to be elected supernode for this group"
                        />
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button
                            type="button"
                            className="action-button secondary-button"
                            style={{ padding: '2px 8px', fontSize: '12px' }}
                            onClick={(e) => {
                              e.stopPropagation()
                              handleLeaveClick(g.groupKey)
                            }}
                            disabled={isSubmitting}
                          >
                            Leave
                          </button>
                          <button
                            type="button"
                            className="action-button secondary-button"
                            style={{ padding: '2px 8px', fontSize: '12px' }}
                            onClick={(e) => {
                              e.stopPropagation()
                              handleForgetClick(g.groupKey)
                            }}
                            disabled={isSubmitting}
                          >
                            Forget
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

      {/* Selected Group Inspection */}
      {selectedGroup && (
        <div className="network-active-panel" style={{ marginBottom: '24px' }}>
          <h2 className="section-subheading">Active Group Details: {selectedGroup.groupId}</h2>
          <div className="network-summary-card">
            <div className="summary-row">
              <span className="summary-label">Status:</span>
              <span className={`badge badge-${selectedGroup.network.status}`}>{selectedGroup.network.status}</span>
            </div>
            <div className="summary-row">
              <span className="summary-label">Your Role:</span>
              <span className={`badge badge-role-${selectedGroup.network.role}`}>
                {selectedGroup.network.role === 'supernode' ? 'Supernode (Indexing & Routing)' : 'Ordinary Peer'}
              </span>
            </div>
            {selectedGroup.network.role === 'ordinary' && (
              <>
                <div className="summary-row">
                  <span className="summary-label">Primary Supernode:</span>
                  <span className="code-text">{selectedGroup.network.primaryPeerId || 'Detecting...'}</span>
                </div>
                <div className="summary-row">
                  <span className="summary-label">Standby Supernode:</span>
                  <span className="code-text">{selectedGroup.network.standbyPeerId || 'None'}</span>
                </div>
              </>
            )}
            <div className="summary-row">
              <span className="summary-label">Active Links:</span>
              <span>{selectedGroup.network.links.filter((l) => l.state === 'open').length} open WebRTC link(s)</span>
            </div>
          </div>
        </div>
      )}

      {/* Join New Group Panel */}
      <div className="network-connect-panel">
        <h2 className="section-subheading">Join a Group</h2>
        <form className="settings-form" onSubmit={handleJoinSubmit}>
          <div className="form-group">
            <label htmlFor="p2p-display-name" className="form-label">
              Your Display Name
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
              Group Invitation (JSON)
            </label>
            <textarea
              id="p2p-invitation"
              className="text-area-input"
              rows={4}
              value={invitationText}
              onChange={(e) => setInvitationText(e.target.value)}
              placeholder='Paste {"version":2,"signalingUrl":"...","groupId":"...","token":"..."}'
              required
              disabled={isSubmitting}
            />
            <p className="field-hint">
              Paste a group invitation generated by create-invite or provided by your network operator.
            </p>
          </div>

          <div className="checkbox-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={eligible}
                onChange={(e) => setEligible(e.target.checked)}
                disabled={isSubmitting}
              />
              Allow this computer to become a supernode in this group
            </label>
          </div>

          <div className="checkbox-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={autoJoin}
                onChange={(e) => setAutoJoin(e.target.checked)}
                disabled={isSubmitting}
              />
              Automatically join this group on startup
            </label>
          </div>

          <div className="checkbox-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={rememberInvitation}
                onChange={(e) => setRememberInvitation(e.target.checked)}
                disabled={isSubmitting}
              />
              Remember invitation token securely on this device
            </label>
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
          </div>

          {formError && (
            <div className="error-message" role="alert">
              {formError}
            </div>
          )}

          <div className="form-actions">
            <button type="submit" className="action-button primary-button" disabled={isSubmitting}>
              {isSubmitting ? 'Joining...' : 'Join Group'}
            </button>
          </div>
        </form>
      </div>
    </section>
  )
}
