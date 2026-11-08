import React, { useState } from 'react'
import type {
  ActionResult,
  CreateGroupOptions,
  GroupKey,
  JoinGroupOptions,
  P2pGroupState
} from '../../../../shared/p2p.ts'
import { parseGroupInvitation } from '../../../../shared/p2p.ts'

interface NetworkProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>
  groups?: P2pGroupState[]
  selectedGroupKey?: string | null
  onSelectGroup?: (groupKey: string) => void
  identity?: { peerId: string; displayName: string }
  defaultSignalingUrl?: string
  onCreateGroup?: (options: CreateGroupOptions) => Promise<ActionResult>
  onJoinGroup?: (options: JoinGroupOptions) => Promise<ActionResult>
  onLeaveGroup?: (groupKey: string) => Promise<ActionResult>
  onRotateGroupInvite?: (groupKey: string) => Promise<ActionResult>
  onRemoveGroupMember?: (groupKey: string, targetPeerId: string) => Promise<ActionResult>
  onSetGroupAutoJoin?: (groupKey: string, autoJoin: boolean) => Promise<ActionResult>
  onSetGroupEligibility?: (groupKey: string, eligible: boolean) => Promise<ActionResult>
  onForgetGroup?: (groupKey: string) => Promise<ActionResult>
  onDisconnectAll?: () => Promise<ActionResult>
}

export const Network: React.FC<NetworkProps> = ({
  headingRef,
  groups = [],
  selectedGroupKey = null,
  onSelectGroup,
  identity,
  defaultSignalingUrl = 'ws://127.0.0.1:8787/signal',
  onCreateGroup,
  onJoinGroup,
  onLeaveGroup,
  onRotateGroupInvite,
  onRemoveGroupMember,
  onSetGroupAutoJoin,
  onSetGroupEligibility,
  onForgetGroup,
  onDisconnectAll
}) => {
  const [panelMode, setPanelMode] = useState<'join' | 'create'>('join')

  // Shared form inputs
  const [displayName, setDisplayName] = useState(identity?.displayName || '')
  const [signalingUrl, setSignalingUrl] = useState(defaultSignalingUrl)
  const [eligible, setEligible] = useState(true)
  const [autoJoin, setAutoJoin] = useState(true)
  const [rememberInvitation, setRememberInvitation] = useState(true)
  const [relayOnly, setRelayOnly] = useState(false)

  // Join form inputs
  const [inviteCodeInput, setInviteCodeInput] = useState('')

  // Create form inputs
  const [createGroupId, setCreateGroupId] = useState('')

  const [isSubmitting, setIsSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [copiedCode, setCopiedCode] = useState(false)

  React.useEffect(() => {
    if (identity?.displayName && !displayName) {
      setDisplayName(identity.displayName)
    }
  }, [identity?.displayName])

  React.useEffect(() => {
    if (defaultSignalingUrl) {
      setSignalingUrl(defaultSignalingUrl)
    }
  }, [defaultSignalingUrl])
  const handleJoinSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setFormError(null)
    setActionMessage(null)

    const trimmedName = displayName.trim()
    if (!trimmedName) {
      setFormError('Display name is required')
      return
    }

    const trimmedCode = inviteCodeInput.trim()
    if (!trimmedCode) {
      setFormError('Invite code is required')
      return
    }

    setIsSubmitting(true)

    let result: ActionResult
    if (onJoinGroup) {
      if (trimmedCode.startsWith('{')) {
        const parsed = parseGroupInvitation(trimmedCode, signalingUrl)
        if (!parsed) {
          setIsSubmitting(false)
          setFormError('Invalid invitation JSON. Please paste a valid JSON invitation or short invite code.')
          return
        }
        result = await onJoinGroup({
          invitation: parsed,
          displayName: trimmedName,
          supernodeEligible: eligible,
          autoJoin,
          relayOnly,
          rememberInvitation
        })
      } else {
        result = await onJoinGroup({
          inviteCode: trimmedCode,
          signalingUrl: signalingUrl.trim() || defaultSignalingUrl,
          displayName: trimmedName,
          supernodeEligible: eligible,
          autoJoin,
          relayOnly,
          rememberInvitation
        })
      }
    } else {
      result = { ok: false, code: 'IO_ERROR', message: 'Join handler unavailable' }
    }

    setIsSubmitting(false)
    if (!result.ok) {
      setFormError(`${result.code}: ${result.message}`)
    } else {
      setActionMessage('Successfully joined group!')
      setInviteCodeInput('')
    }
  }

  const handleCreateSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setFormError(null)
    setActionMessage(null)

    const trimmedName = displayName.trim()
    if (!trimmedName) {
      setFormError('Display name is required')
      return
    }

    const trimmedGroupId = createGroupId.trim()
    if (!trimmedGroupId) {
      setFormError('Group ID is required')
      return
    }

    setIsSubmitting(true)

    let result: ActionResult
    if (onCreateGroup) {
      result = await onCreateGroup({
        groupId: trimmedGroupId,
        signalingUrl: signalingUrl.trim() || defaultSignalingUrl,
        displayName: trimmedName,
        supernodeEligible: eligible,
        autoJoin,
        relayOnly,
        rememberInvitation
      })
    } else {
      result = { ok: false, code: 'IO_ERROR', message: 'Create group handler unavailable' }
    }

    setIsSubmitting(false)
    if (!result.ok) {
      setFormError(`${result.code}: ${result.message}`)
    } else {
      setActionMessage(`Successfully created group "${trimmedGroupId}"! You are the Group Owner.`)
      setCreateGroupId('')
    }
  }

  const handleLeaveClick = async (groupKey: string): Promise<void> => {
    if (!onLeaveGroup) return
    setIsSubmitting(true)
    setFormError(null)
    setActionMessage(null)
    const res = await onLeaveGroup(groupKey)
    setIsSubmitting(false)
    if (!res.ok) {
      setFormError(`${res.code}: ${res.message}`)
    }
  }

  const handleForgetClick = async (groupKey: string): Promise<void> => {
    if (!onForgetGroup) return
    setIsSubmitting(true)
    setFormError(null)
    setActionMessage(null)
    const res = await onForgetGroup(groupKey)
    setIsSubmitting(false)
    if (!res.ok) {
      setFormError(`${res.code}: ${res.message}`)
    }
  }

  const handleRotateInvite = async (groupKey: string): Promise<void> => {
    if (!onRotateGroupInvite) return
    setIsSubmitting(true)
    setFormError(null)
    setActionMessage(null)
    const res = await onRotateGroupInvite(groupKey)
    setIsSubmitting(false)
    if (!res.ok) {
      setFormError(`${res.code}: ${res.message}`)
    } else {
      setActionMessage('Invite code rotated successfully. Existing members received the updated code.')
    }
  }

  const handleRemoveMember = async (groupKey: string, targetPeerId: string): Promise<void> => {
    if (!onRemoveGroupMember) return
    setIsSubmitting(true)
    setFormError(null)
    setActionMessage(null)
    const res = await onRemoveGroupMember(groupKey, targetPeerId)
    setIsSubmitting(false)
    if (!res.ok) {
      setFormError(`${res.code}: ${res.message}`)
    } else {
      setActionMessage('Member removed from group.')
    }
  }

  const handleCopyInviteCode = (code: string): void => {
    try {
      void navigator.clipboard.writeText(code)
      setCopiedCode(true)
      setTimeout(() => setCopiedCode(false), 2000)
    } catch {
      // fallback
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
          <p className="empty-hint">You have not joined any P2P groups yet. Join a group or create one below to start sharing and searching files.</p>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Group ID</th>
                  <th>Role / Ownership</th>
                  <th>Status</th>
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
                        {g.isOwner ? (
                          <span className="badge" style={{ backgroundColor: 'var(--color-primary, #3182ce)', color: '#fff' }}>Owner</span>
                        ) : (
                          <span className={`badge badge-role-${g.network.role}`}>{g.network.role}</span>
                        )}
                      </td>
                      <td>
                        <span className={`badge badge-${g.network.status}`}>{g.network.status}</span>
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
              <span className="summary-label">Owner:</span>
              <span style={{ fontWeight: selectedGroup.isOwner ? 'bold' : 'normal' }}>
                {selectedGroup.isOwner ? 'You (Group Owner)' : (selectedGroup.ownerPeerId || 'Server-Managed')}
              </span>
            </div>
            <div className="summary-row">
              <span className="summary-label">Invite Code:</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <code className="code-text" style={{ wordBreak: 'break-all' }}>
                  {selectedGroup.inviteCode || 'N/A'}
                </code>
                {selectedGroup.inviteCode && (
                  <button
                    type="button"
                    className="action-button secondary-button"
                    style={{ padding: '2px 8px', fontSize: '11px' }}
                    onClick={() => handleCopyInviteCode(selectedGroup.inviteCode!)}
                  >
                    {copiedCode ? 'Copied!' : 'Copy Code'}
                  </button>
                )}
                {selectedGroup.isOwner && (
                  <button
                    type="button"
                    className="action-button secondary-button"
                    style={{ padding: '2px 8px', fontSize: '11px' }}
                    onClick={() => handleRotateInvite(selectedGroup.groupKey)}
                    disabled={isSubmitting}
                    title="Generate a new invite code. Existing members will automatically update."
                  >
                    Rotate Invite Code
                  </button>
                )}
              </div>
            </div>
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

            {/* Group Members List with Owner Actions */}
            <div style={{ marginTop: '16px' }}>
              <span className="summary-label" style={{ display: 'block', marginBottom: '8px' }}>
                Group Members ({selectedGroup.network.members.length}):
              </span>
              <div className="table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Display Name</th>
                      <th>Peer ID</th>
                      <th>Role</th>
                      {selectedGroup.isOwner && <th>Admin</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {selectedGroup.network.members.map((m) => {
                      const isMemberOwner = m.peerId === selectedGroup.ownerPeerId
                      const isSelf = m.peerId === identity?.peerId
                      return (
                        <tr key={m.peerId}>
                          <td>
                            <strong>{m.displayName}</strong>
                            {isMemberOwner && <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--color-primary)' }}>(Owner)</span>}
                            {isSelf && <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--color-muted)' }}>(You)</span>}
                          </td>
                          <td className="code-text" style={{ fontSize: '11px' }}>{m.peerId}</td>
                          <td>
                            <span className={`badge badge-role-${m.role}`}>{m.role}</span>
                          </td>
                          {selectedGroup.isOwner && (
                            <td>
                              {!isSelf && (
                                <button
                                  type="button"
                                  className="action-button secondary-button"
                                  style={{ padding: '1px 6px', fontSize: '11px', color: 'var(--color-danger, #e53e3e)' }}
                                  onClick={() => handleRemoveMember(selectedGroup.groupKey, m.peerId)}
                                  disabled={isSubmitting}
                                >
                                  Remove
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Group Join / Create Panel */}
      <div className="network-connect-panel">
        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
          <button
            type="button"
            className={`action-button ${panelMode === 'join' ? 'primary-button' : 'secondary-button'}`}
            onClick={() => {
              setPanelMode('join')
              setFormError(null)
            }}
          >
            Join with Invite Code
          </button>
          <button
            type="button"
            className={`action-button ${panelMode === 'create' ? 'primary-button' : 'secondary-button'}`}
            onClick={() => {
              setPanelMode('create')
              setFormError(null)
            }}
          >
            Create a Group (Become Owner)
          </button>
        </div>

        {panelMode === 'join' ? (
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
              <label htmlFor="p2p-invite-code" className="form-label">
                Invite Code
              </label>
              <input
                id="p2p-invite-code"
                type="text"
                className="text-input"
                value={inviteCodeInput}
                onChange={(e) => setInviteCodeInput(e.target.value)}
                placeholder="Enter invite code or paste JSON invitation"
                required
                disabled={isSubmitting}
              />
              <p className="field-hint">
                Paste the short invite code shared by the group owner (or a full JSON invitation).
              </p>
            </div>

            <div className="form-group">
              <label htmlFor="p2p-signaling-url" className="form-label">
                Signaling Server URL (Optional)
              </label>
              <input
                id="p2p-signaling-url"
                type="text"
                className="text-input"
                value={signalingUrl}
                onChange={(e) => setSignalingUrl(e.target.value)}
                disabled={isSubmitting}
              />
              <p className="field-hint">
                Defaults to the configured server. Override only if connecting to a remote endpoint.
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
        ) : (
          <form className="settings-form" onSubmit={handleCreateSubmit}>
            <div className="form-group">
              <label htmlFor="p2p-create-display-name" className="form-label">
                Your Display Name
              </label>
              <input
                id="p2p-create-display-name"
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
              <label htmlFor="p2p-create-group-id" className="form-label">
                Group ID
              </label>
              <input
                id="p2p-create-group-id"
                type="text"
                className="text-input"
                value={createGroupId}
                onChange={(e) => setCreateGroupId(e.target.value)}
                placeholder="e.g. project-x, study-group-1"
                maxLength={32}
                pattern="^[A-Za-z0-9_-]{1,32}$"
                required
                disabled={isSubmitting}
              />
              <p className="field-hint">
                Choose a unique alphanumeric identifier (1-32 chars of letters, numbers, hyphens, underscores).
              </p>
            </div>

            <div className="form-group">
              <label htmlFor="p2p-create-signaling-url" className="form-label">
                Signaling Server URL (Optional)
              </label>
              <input
                id="p2p-create-signaling-url"
                type="text"
                className="text-input"
                value={signalingUrl}
                onChange={(e) => setSignalingUrl(e.target.value)}
                disabled={isSubmitting}
              />
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
                Remember ownership secret securely on this device
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
                {isSubmitting ? 'Creating...' : 'Create Group'}
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  )
}
