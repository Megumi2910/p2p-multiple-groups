import React, { useState } from 'react'
import type {
  ActionResult,
  GroupKey,
  MultiGroupSearchResult,
  P2pGroupState,
  P2pSearchState
} from '../../../../shared/p2p.ts'

interface SearchProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>
  groups?: P2pGroupState[]
  selectedGroupKey?: string | null
  onSelectGroup?: (groupKey: string) => void
  onSearch: (groupKey: GroupKey, query: string) => Promise<ActionResult>
  onDownload: (groupKey: GroupKey, resultId: string) => Promise<ActionResult>
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
  sources: MultiGroupSearchResult[]
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
    if (!activeGroup) {
      setErrorMessage('Please join or select a group before searching')
      return
    }

    setErrorMessage(null)
    setIsSearching(true)
    const res = await onSearch(activeGroup.groupKey, trimmed)
    setIsSearching(false)
    if (!res.ok) {
      setErrorMessage(`${res.code}: ${res.message}`)
    }
  }

  const handleDownloadClick = async (resultId: string): Promise<void> => {
    if (!activeGroup) return
    setDownloadingId(resultId)
    setErrorMessage(null)
    const res = await onDownload(activeGroup.groupKey, resultId)
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
        <div className="status-banner status-warning" role="alert" style={{ marginBottom: '16px' }}>
          You have not joined any groups. Connect to a group in the Network tab to search files across peers.
        </div>
      ) : !isConnected ? (
        <div className="status-banner status-warning" role="alert" style={{ marginBottom: '16px' }}>
          Group &quot;{activeGroup?.groupId}&quot; is not currently connected. Searches will execute when connection restores.
        </div>
      ) : null}

      {/* Group Selector Dropdown */}
      {groups.length > 1 && (
        <div className="form-group" style={{ maxWidth: '400px', marginBottom: '16px' }}>
          <label htmlFor="search-group-select" className="form-label">
            Search in Group
          </label>
          <select
            id="search-group-select"
            className="text-input"
            value={activeGroup?.groupKey || ''}
            onChange={(e) => handleGroupChange(e.target.value)}
          >
            {groups.map((g) => (
              <option key={g.groupKey} value={g.groupKey}>
                {g.groupId} ({g.network.status}, {g.network.members.length} members)
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Search Input Bar */}
      <form className="search-form" onSubmit={handleSearchSubmit}>
        <div className="search-input-wrapper">
          <input
            id="search-query-input"
            type="search"
            className="search-input"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            placeholder="Search filenames across connected peers..."
            disabled={isSearching}
            aria-label="Search filenames"
          />
          <button
            type="submit"
            className="action-button primary-button search-button"
            disabled={isSearching || !queryInput.trim() || !isConnected}
          >
            {isSearching ? 'Searching...' : 'Search'}
          </button>
        </div>
      </form>

      {/* Status Indicators */}
      {currentSearch.status === 'searching' && (
        <div className="search-status-bar" role="status">
          <span className="spinner" aria-hidden="true" />
          <span>Searching network...</span>
        </div>
      )}

      {currentSearch.status === 'error' && currentSearch.message && (
        <div className="error-message" role="alert" style={{ marginTop: '12px' }}>
          {currentSearch.message}
        </div>
      )}

      {errorMessage && (
        <div className="error-message" role="alert" style={{ marginTop: '12px' }}>
          {errorMessage}
        </div>
      )}

      {/* Results Table */}
      <div className="search-results-section">
        <div className="view-header-row" style={{ marginBottom: '8px' }}>
          <h2 className="section-subheading" style={{ margin: 0 }}>
            Results ({groupedList.length} distinct files, {currentSearch.results.length} sources)
          </h2>
        </div>

        {groupedList.length === 0 ? (
          <p className="empty-hint">
            {currentSearch.status === 'searching'
              ? 'Querying supernodes...'
              : currentSearch.query
                ? 'No matching files found. Try a different search term.'
                : 'Enter a search term above to find files shared by group members.'}
          </p>
        ) : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Filename</th>
                  <th>Size</th>
                  <th>Sources</th>
                  <th>Peer Selection</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {groupedList.map((item) => {
                  const selIdx = sourceSelections[item.groupKey] ?? 0
                  const activeSource = item.sources[selIdx] || item.sources[0]
                  const isDownloading = downloadingId === activeSource.resultId

                  return (
                    <tr key={item.groupKey}>
                      <td className="filename-cell">
                        <strong>{item.primaryName}</strong>
                        <div className="code-text" style={{ fontSize: '11px', color: 'var(--color-muted)' }}>
                          {item.sha256.slice(0, 16)}...
                        </div>
                      </td>
                      <td>{formatBytes(item.size)}</td>
                      <td>
                        <span className="badge badge-source-count">
                          {item.sources.length} source{item.sources.length === 1 ? '' : 's'}
                        </span>
                      </td>
                      <td>
                        {item.sources.length > 1 ? (
                          <select
                            className="source-select"
                            value={selIdx}
                            onChange={(e) =>
                              setSourceSelections((prev) => ({
                                ...prev,
                                [item.groupKey]: parseInt(e.target.value, 10)
                              }))
                            }
                            aria-label={`Select peer for ${item.primaryName}`}
                          >
                            {item.sources.map((src, idx) => (
                              <option key={src.resultId} value={idx}>
                                {src.ownerName} ({src.ownerPeerId.slice(0, 8)})
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span>{activeSource.ownerName}</span>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="action-button primary-button"
                          style={{ padding: '4px 12px', fontSize: '12px' }}
                          onClick={() => handleDownloadClick(activeSource.resultId)}
                          disabled={isDownloading || !isConnected}
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
