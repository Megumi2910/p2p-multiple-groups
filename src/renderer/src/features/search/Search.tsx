import React, { useState } from 'react'
import type {
  ActionResult,
  GroupKey,
  MultiGroupSearchResult,
  P2pGroupState,
  P2pSearchResult,
  P2pSearchState
} from '../../../../shared/p2p.ts'

interface SearchProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>
  groups?: P2pGroupState[]
  selectedGroupKey?: string | null
  onSelectGroup?: (groupKey: string) => void
  onSearch: (arg1: string, arg2?: string) => Promise<ActionResult>
  onDownload: (arg1: string, arg2?: string) => Promise<ActionResult>
  // Backward compatibility
  search?: P2pSearchState
  isNetworkConnected?: boolean
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i] || 'B'}`
}

interface GroupedResult {
  groupKey: string
  sha256: string
  size: number
  primaryName: string
  sources: (P2pSearchResult | MultiGroupSearchResult)[]
  selectedSourceIndex: number
}

export const Search: React.FC<SearchProps> = ({
  headingRef,
  groups = [],
  selectedGroupKey = null,
  onSelectGroup,
  onSearch,
  onDownload,
  search: legacySearch,
  isNetworkConnected: legacyIsConnected
}) => {
  const activeGroup = groups.find((g) => g.groupKey === selectedGroupKey) || groups[0]
  const currentSearch = activeGroup?.search || legacySearch || { queryId: null, query: '', status: 'idle', results: [], message: null }
  const isConnected = activeGroup ? activeGroup.network.status === 'connected' : Boolean(legacyIsConnected)

  const [queryInput, setQueryInput] = useState(currentSearch.query || '')
  const [isSearching, setIsSearching] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [sourceSelections, setSourceSelections] = useState<Record<string, number>>({})

  const handleGroupChange = (newGroupKey: string) => {
    onSelectGroup?.(newGroupKey)
    const grp = groups.find((g) => g.groupKey === newGroupKey)
    if (grp) {
      setQueryInput(grp.search.query || '')
    }
  }

  const handleSearchSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const trimmed = queryInput.trim()
    if (!trimmed) return

    setErrorMessage(null)
    setIsSearching(true)
    let res: ActionResult
    if (activeGroup) {
      res = await onSearch(activeGroup.groupKey, trimmed)
    } else {
      res = await onSearch(trimmed)
    }
    setIsSearching(false)
    if (!res.ok) {
      setErrorMessage(`${res.code}: ${res.message}`)
    }
  }

  const handleDownloadClick = async (resultId: string): Promise<void> => {
    setDownloadingId(resultId)
    setErrorMessage(null)
    let res: ActionResult
    if (activeGroup) {
      res = await onDownload(activeGroup.groupKey, resultId)
    } else {
      res = await onDownload(resultId)
    }
    setDownloadingId(null)
    if (!res.ok) {
      setErrorMessage(`${res.code}: ${res.message}`)
    }
  }

  // Group search results by (sha256, size)
  const groupedMap = new Map<string, GroupedResult>()
  for (const item of currentSearch.results) {
    const key = `${item.file.sha256}:${item.file.size}`
    let group = groupedMap.get(key)
    if (!group) {
      group = {
        groupKey: key,
        sha256: item.file.sha256,
        size: item.file.size,
        primaryName: item.file.name,
        sources: [],
        selectedSourceIndex: 0
      }
      groupedMap.set(key, group)
    }
    group.sources.push(item)
  }

  const groupedList = Array.from(groupedMap.values())

  return (
    <section className="view-content fluid-content" aria-labelledby="search-heading">
      <h1 id="search-heading" ref={headingRef} tabIndex={-1} className="view-heading">
        Search Files
      </h1>

      {groups.length === 0 ? (
        <div className="status-banner status-degraded" role="alert">
          You are not currently in any P2P groups. Join a group in the Network tab to search files.
        </div>
      ) : !isConnected ? (
        <div className="status-banner status-degraded" role="alert">
          Group {activeGroup?.groupId} is currently disconnected. Reconnect in the Network tab before searching.
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '16px' }}>
        {groups.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <label htmlFor="search-group-select" className="form-label" style={{ margin: 0, whiteSpace: 'nowrap' }}>
              Search in:
            </label>
            <select
              id="search-group-select"
              className="text-input"
              style={{ width: 'auto', padding: '6px 12px' }}
              value={activeGroup?.groupKey || ''}
              onChange={(e) => handleGroupChange(e.target.value)}
              disabled={isSearching}
            >
              {groups.map((g) => (
                <option key={g.groupKey} value={g.groupKey}>
                  {g.groupId} ({g.network.status})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <form className="search-form-row" onSubmit={handleSearchSubmit}>
        <input
          type="text"
          className="text-input search-input"
          placeholder="Search by filename (e.g. anthem, rock, album)..."
          value={queryInput}
          onChange={(e) => setQueryInput(e.target.value)}
          disabled={!isConnected || isSearching}
          maxLength={120}
          aria-label="Search query"
        />
        <button
          type="submit"
          className="action-button primary-button"
          disabled={!isConnected || isSearching || !queryInput.trim()}
        >
          {isSearching || currentSearch.status === 'searching' ? 'Searching...' : 'Search'}
        </button>
      </form>

      {errorMessage && (
        <div className="error-message" role="alert">
          {errorMessage}
        </div>
      )}

      {currentSearch.message && (
        <div className={`status-banner status-${currentSearch.status}`} role="status">
          {currentSearch.message}
        </div>
      )}

      <div className="search-results-section" style={{ marginTop: '20px' }}>
        <h2 className="section-subheading">
          Results ({groupedList.length} unique file{groupedList.length === 1 ? '' : 's'})
          {activeGroup && <span style={{ marginLeft: '8px', fontSize: '13px', color: 'var(--color-text-subtle)' }}>in group: {activeGroup.groupId}</span>}
        </h2>

        {groupedList.length === 0 ? (
          <p className="empty-hint">
            {currentSearch.status === 'complete' && currentSearch.query
              ? `No files found matching "${currentSearch.query}" in this group.`
              : 'Enter a search term above to find files across peers in the selected group.'}
          </p>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Filename</th>
                  <th>Size</th>
                  <th>Group</th>
                  <th>Peer</th>
                  <th>SHA-256</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {groupedList.map((group) => {
                  const selectedIdx = sourceSelections[group.groupKey] ?? 0
                  const activeSource = group.sources[selectedIdx] || group.sources[0]
                  const isDownloading = downloadingId === activeSource.resultId

                  return (
                    <tr key={group.groupKey}>
                      <td className="filename-cell" title={group.primaryName}>
                        {group.primaryName}
                      </td>
                      <td>{formatBytes(group.size)}</td>
                      <td>
                        <span className="badge badge-connected" style={{ fontSize: '11px', padding: '1px 6px' }}>
                          {activeGroup?.groupId || 'Group'}
                        </span>
                      </td>
                      <td>
                        {group.sources.length === 1 ? (
                          activeSource.ownerName
                        ) : (
                          <select
                            className="text-input"
                            style={{ padding: '2px 4px', fontSize: '12px' }}
                            value={selectedIdx}
                            onChange={(e) => {
                              const newIdx = Number(e.target.value)
                              setSourceSelections((prev) => ({ ...prev, [group.groupKey]: newIdx }))
                            }}
                          >
                            {group.sources.map((s, idx) => (
                              <option key={s.resultId} value={idx}>
                                {s.ownerName}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="code-cell">{group.sha256.slice(0, 12)}...</td>
                      <td>
                        <button
                          type="button"
                          className="action-button primary-button"
                          style={{ padding: '3px 10px', fontSize: '12px' }}
                          onClick={() => void handleDownloadClick(activeSource.resultId)}
                          disabled={isDownloading}
                        >
                          {isDownloading ? 'Saving...' : 'Download'}
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
    </section>
  )
}
