import { randomUUID } from 'node:crypto'
import type { P2pFileMetadata, MultiGroupSearchResult, GroupKey } from '../../shared/p2p.ts'
import {
  MAX_SEARCH_RESULTS_ENTRIES,
  type OverlayCatalogBatchMessageV2,
  type OverlayCatalogBeginMessageV2,
  type OverlayCatalogEndMessageV2,
  type WireSearchResultEntryV2
} from '../../shared/p2p-wire.ts'

export const MAX_CACHED_QUERIES = 256
export const MAX_SEARCH_RESULTS = 200
export const QUERY_CACHE_TTL_MS = 30000 // 30s
export const CATALOG_STAGING_TTL_MS = 5000 // 5s

export interface OwnerCatalogue {
  peerId: string
  sessionId: string
  membershipId?: string
  generation: number
  entries: P2pFileMetadata[]
}

interface StagedCatalogue {
  generation: number
  count: number
  entries: P2pFileMetadata[]
  timer: NodeJS.Timeout
}

function normalizeQuery(raw: string): string[] {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
}

function matchesQuery(fileName: string, queryTokens: string[]): boolean {
  if (queryTokens.length === 0) return false
  const lowerName = fileName.normalize('NFKC').toLowerCase()
  return queryTokens.every((token) => lowerName.includes(token))
}

export class SupernodeIndexManager {
  private readonly ownerCatalogues = new Map<string, OwnerCatalogue>() // peerId -> OwnerCatalogue
  private readonly staging = new Map<string, StagedCatalogue>() // peerId -> StagedCatalogue
  private readonly queryCache = new Map<string, { originPeerId: string; queryId: string; timestamp: number }>()

  handleCatalogBegin(
    ownerPeerId: string,
    ownerSessionId: string,
    msg: OverlayCatalogBeginMessageV2,
    ownerMembershipId?: string
  ): boolean {
    const existingStaged = this.staging.get(ownerPeerId)
    if (existingStaged) {
      clearTimeout(existingStaged.timer)
      this.staging.delete(ownerPeerId)
    }

    if (msg.count === 0) {
      this.ownerCatalogues.set(ownerPeerId, {
        peerId: ownerPeerId,
        sessionId: ownerSessionId,
        membershipId: ownerMembershipId || msg.senderMembershipId || ownerSessionId,
        generation: msg.generation,
        entries: []
      })
      return true
    }

    const timer = setTimeout(() => {
      this.staging.delete(ownerPeerId)
    }, CATALOG_STAGING_TTL_MS)

    this.staging.set(ownerPeerId, {
      generation: msg.generation,
      count: msg.count,
      entries: [],
      timer
    })

    return false
  }

  handleCatalogBatch(
    ownerPeerId: string,
    _ownerSessionId: string,
    msg: OverlayCatalogBatchMessageV2
  ): void {
    const staged = this.staging.get(ownerPeerId)
    if (!staged || staged.generation !== msg.generation) {
      return
    }
    for (const entry of msg.entries) {
      if (staged.entries.length < staged.count) {
        staged.entries.push(entry)
      }
    }
  }

  handleCatalogEnd(
    ownerPeerId: string,
    ownerSessionId: string,
    msg: OverlayCatalogEndMessageV2,
    ownerMembershipId?: string
  ): boolean {
    const staged = this.staging.get(ownerPeerId)
    if (!staged || staged.generation !== msg.generation) {
      return false
    }

    clearTimeout(staged.timer)
    this.staging.delete(ownerPeerId)

    if (staged.entries.length !== staged.count) {
      return false
    }

    const senderMembershipId = ownerMembershipId || msg.senderMembershipId || ownerSessionId

    this.ownerCatalogues.set(ownerPeerId, {
      peerId: ownerPeerId,
      sessionId: ownerSessionId,
      membershipId: senderMembershipId,
      generation: msg.generation,
      entries: staged.entries
    })

    return true
  }

  updateLocalCatalogue(
    localPeerId: string,
    localSessionId: string,
    generation: number,
    entries: P2pFileMetadata[],
    membershipId?: string
  ): void {
    this.ownerCatalogues.set(localPeerId, {
      peerId: localPeerId,
      sessionId: localSessionId,
      membershipId: membershipId || localSessionId,
      generation,
      entries: [...entries]
    })
  }

  removeOwner(peerId: string): void {
    const staged = this.staging.get(peerId)
    if (staged) {
      clearTimeout(staged.timer)
      this.staging.delete(peerId)
    }
    this.ownerCatalogues.delete(peerId)
  }

  search(
    query: string,
    originPeerId: string,
    queryId: string
  ): {
    entries: WireSearchResultEntryV2[]
    isNewQuery: boolean
  } {
    const cacheKey = `${originPeerId}:${queryId}`
    const now = Date.now()

    for (const [key, item] of this.queryCache.entries()) {
      if (now - item.timestamp > QUERY_CACHE_TTL_MS) {
        this.queryCache.delete(key)
      }
    }

    if (this.queryCache.has(cacheKey)) {
      return { entries: [], isNewQuery: false }
    }

    if (this.queryCache.size >= MAX_CACHED_QUERIES) {
      const oldestKey = this.queryCache.keys().next().value
      if (oldestKey) this.queryCache.delete(oldestKey)
    }

    this.queryCache.set(cacheKey, {
      originPeerId,
      queryId,
      timestamp: now
    })

    const tokens = normalizeQuery(query)
    if (tokens.length === 0) {
      return { entries: [], isNewQuery: true }
    }

    const matchedEntries: WireSearchResultEntryV2[] = []

    for (const catalogue of this.ownerCatalogues.values()) {
      for (const file of catalogue.entries) {
        if (matchesQuery(file.name, tokens)) {
          matchedEntries.push({
            ownerPeerId: catalogue.peerId,
            ownerSessionId: catalogue.sessionId,
            ownerMembershipId: catalogue.membershipId || catalogue.sessionId,
            file
          })
          if (matchedEntries.length >= MAX_SEARCH_RESULTS) {
            return { entries: matchedEntries, isNewQuery: true }
          }
        }
      }
    }

    return { entries: matchedEntries, isNewQuery: true }
  }

  splitResultBatches(allEntries: WireSearchResultEntryV2[]): WireSearchResultEntryV2[][] {
    if (allEntries.length === 0) return []
    const batches: WireSearchResultEntryV2[][] = []

    for (let i = 0; i < allEntries.length; i += MAX_SEARCH_RESULTS_ENTRIES) {
      batches.push(allEntries.slice(i, i + MAX_SEARCH_RESULTS_ENTRIES))
    }

    return batches
  }

  clear(): void {
    for (const staged of this.staging.values()) {
      clearTimeout(staged.timer)
    }
    this.staging.clear()
    this.ownerCatalogues.clear()
    this.queryCache.clear()
  }
}

export class SearchResultsTracker {
  private readonly resultsMap = new Map<string, MultiGroupSearchResult>()
  private readonly seenFiles = new Set<string>()
  private activeQueryId: string | null = null
  private activeQueryText = ''

  startNewSearch(queryId: string, queryText: string): void {
    this.activeQueryId = queryId
    this.activeQueryText = queryText
    this.resultsMap.clear()
    this.seenFiles.clear()
  }

  addBatch(
    queryId: string,
    entries: readonly WireSearchResultEntryV2[],
    ownerNames: (peerId: string) => string,
    groupKey: GroupKey = ''
  ): boolean {
    if (this.activeQueryId !== queryId) {
      return false
    }

    let addedAny = false
    for (const entry of entries) {
      if (this.resultsMap.size >= MAX_SEARCH_RESULTS) {
        break
      }
      const dedupKey = `${entry.ownerSessionId}:${entry.file.fileId}`
      if (!this.seenFiles.has(dedupKey)) {
        this.seenFiles.add(dedupKey)
        const resultId = randomUUID()
        const ownerMembershipId = entry.ownerMembershipId || ''
        this.resultsMap.set(resultId, {
          resultId,
          groupKey,
          ownerPeerId: entry.ownerPeerId,
          ownerSessionId: entry.ownerSessionId,
          ownerMembershipId,
          ownerName: ownerNames(entry.ownerPeerId) || `Peer-${entry.ownerPeerId.slice(0, 6)}`,
          file: entry.file
        })
        addedAny = true
      }
    }

    return addedAny
  }

  getResults(): MultiGroupSearchResult[] {
    return Array.from(this.resultsMap.values())
  }

  resolveResult(resultId: string): MultiGroupSearchResult | undefined {
    return this.resultsMap.get(resultId)
  }

  pruneExpiredOwners(validIncarnations: Map<string, { sessionId: string; membershipId: string }>): boolean {
    let pruned = false
    for (const [resultId, result] of this.resultsMap.entries()) {
      const valid = validIncarnations.get(result.ownerPeerId)
      if (
        !valid ||
        valid.sessionId !== result.ownerSessionId ||
        (valid.membershipId && result.ownerMembershipId && valid.membershipId !== result.ownerMembershipId)
      ) {
        this.resultsMap.delete(resultId)
        this.seenFiles.delete(`${result.ownerSessionId}:${result.file.fileId}`)
        pruned = true
      }
    }
    return pruned
  }

  clear(): void {
    this.activeQueryId = null
    this.activeQueryText = ''
    this.resultsMap.clear()
    this.seenFiles.clear()
  }
}
