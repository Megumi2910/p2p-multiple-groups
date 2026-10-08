import React, { useState } from 'react'
import type {
  ActionResult,
  P2pSearchResult,
  P2pSearchState
} from '../../../../shared/p2p.ts'

interface SearchProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>
  search: P2pSearchState
  isNetworkConnected: boolean
  onSearch: (query: string) => Promise<ActionResult>
  onDownload: (resultId: string) => Promise<ActionResult>
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
  sources: P2pSearchResult[]
  selectedSourceIndex: number
}

export const Search: React.FC<SearchProps> = ({
  headingRef,
  search,
  isNetworkConnected,
  onSearch,
  onDownload
}) => {
  const [queryInput, setQueryInput] = useState(search.query || '')
  const [isSearching, setIsSearching] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [sourceSelections, setSourceSelections] = useState<Record<string, number>>({})

  const handleSearchSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const trimmed = queryInput.trim()
    if (!trimmed) return

    setErrorMessage(null)
    setIsSearching(true)
    const res = await onSearch(trimmed)
    setIsSearching(false)
    if (!res.ok) {
      setErrorMessage(`${res.code}: ${res.message}`)
    }
  }

  const handleDownloadClick = async (resultId: string): Promise<void> => {
    setDownloadingId(resultId)
    setErrorMessage(null)
    const res = await onDownload(resultId)
    setDownloadingId(null)
    if (!res.ok) {
      setErrorMessage(`${res.code}: ${res.message}`)
    }
  }

  // Group search results by (sha256, size)
  const groupedMap = new Map<string, GroupedResult>()
  for (const item of search.results) {
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

      {!isNetworkConnected && (
        <div className="status-banner status-degraded" role="alert">
          You are currently disconnected from the peer network. Connect in the Network view before searching for files.
        </div>
      )}

      <form className="search-form-row" onSubmit={handleSearchSubmit}>
        <input
          type="text"
          className="text-input search-input"
          placeholder="Search by filename (e.g. rock, pdf, album)..."
          value={queryInput}
          onChange={(e) => setQueryInput(e.target.value)}
          disabled={!isNetworkConnected || isSearching}
          maxLength={120}
          aria-label="Search query"
        />
        <button
          type="submit"
          className="action-button primary-button"
          disabled={!isNetworkConnected || isSearching || !queryInput.trim()}
        >
          {isSearching || search.status === 'searching' ? 'Searching...' : 'Search'}
        </button>
      </form>

      {errorMessage && (
        <div className="error-message" role="alert">
          {errorMessage}
        </div>
      )}

      {search.status === 'searching' && (
        <div className="searching-panel" role="status">
          <span className="spinner-indicator" aria-hidden="true" />
          <span>Searching network through supernode index...</span>
        </div>
      )}

      {search.status === 'partial' && (
        <div className="status-banner status-degraded" role="status">
          Notice: Results may be incomplete due to an unreachable supernode route.
        </div>
      )}

      {search.status === 'complete' && groupedList.length === 0 && (
        <div className="empty-state-panel">
          <p className="empty-title">No files found</p>
          <p className="empty-hint">Try adjusting your search terms or verify that peers are online.</p>
        </div>
      )}

      {groupedList.length > 0 && (
        <div className="search-results-section">
          <div className="results-header-info">
            <span>Found {groupedList.length} unique file(s) across network</span>
            <span className="subtle-text">(Results capped at 200 items maximum)</span>
          </div>

          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Filename</th>
                  <th>Size</th>
                  <th>Sources</th>
                  <th>Source Peer</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {groupedList.map((group) => {
                  const selectedIdx = sourceSelections[group.groupKey] || 0
                  const chosenSource = group.sources[selectedIdx] || group.sources[0]

                  return (
                    <tr key={group.groupKey}>
                      <td className="filename-cell" title={group.primaryName}>
                        {group.primaryName}
                      </td>
                      <td>{formatBytes(group.size)}</td>
                      <td>
                        <span className="badge badge-source-count">
                          {group.sources.length} {group.sources.length === 1 ? 'source' : 'sources'}
                        </span>
                      </td>
                      <td>
                        {group.sources.length === 1 ? (
                          <span>{chosenSource.ownerName}</span>
                        ) : (
                          <select
                            className="source-select"
                            value={selectedIdx}
                            onChange={(e) => {
                              const newIdx = parseInt(e.target.value, 10)
                              setSourceSelections((prev) => ({ ...prev, [group.groupKey]: newIdx }))
                            }}
                            aria-label={`Select source for ${group.primaryName}`}
                          >
                            {group.sources.map((src, i) => (
                              <option key={src.ownerSessionId} value={i}>
                                {src.ownerName} ({src.ownerPeerId.slice(0, 6)}...)
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="action-button secondary-button inline-download-btn"
                          onClick={() => void handleDownloadClick(chosenSource.resultId)}
                          disabled={downloadingId === chosenSource.resultId}
                        >
                          {downloadingId === chosenSource.resultId ? 'Starting...' : 'Download'}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}
