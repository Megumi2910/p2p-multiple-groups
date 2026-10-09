import { randomUUID } from 'node:crypto'
import type { P2pFileMetadata, P2pSearchResult } from '../../shared/p2p.ts'
import {
  MAX_SEARCH_RESULTS_ENTRIES,
  type OverlayCatalogBatchMessage,
  type OverlayCatalogBeginMessage,
  type OverlayCatalogEndMessage,
  type WireSearchResultEntry
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

interface CachedQuery {
  originPeerId: string
  queryId: string
  timestamp: number
}

export function normalizeQuery(query: string): string[] {
  const normalized = query.normalize('NFKC').toLowerCase().trim()
  return normalized.split(/\s+/).filter((t) => t.length > 0)
}

export function matchesQuery(fileName: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false
  const normalizedName = fileName.normalize('NFKC').toLowerCase()
  return tokens.every((token) => normalizedName.includes(token))
}

export class SupernodeIndexManager {
  private readonly ownerCatalogues = new Map<string, OwnerCatalogue>() // peerId -> OwnerCatalogue
  private readonly staging = new Map<string, StagedCatalogue>() // peerId -> StagedCatalogue
  private readonly queryCache = new Map<string, CachedQuery>() // "originPeerId:queryId" -> CachedQuery

  constructor() {}

  handleCatalogBegin(
    ownerPeerId: string,
    ownerSessionId: string,
    msg: OverlayCatalogBeginMessage,
    ownerMembershipId?: string
  ): boolean {
    const existing = this.staging.get(ownerPeerId)
    if (existing) {
      clearTimeout(existing.timer)
      this.staging.delete(ownerPeerId)
    }

    if (msg.count === 0) {
      // Withdrawing all files
      this.ownerCatalogues.set(ownerPeerId, {
        peerId: ownerPeerId,
        sessionId: ownerSessionId,
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
    arg2: string | OverlayCatalogBatchMessage,
    arg3?: OverlayCatalogBatchMessage
  ): void {
    const msg = (typeof arg2 === 'string' ? arg3 : arg2) as OverlayCatalogBatchMessage
    if (!msg) return
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
    msg: OverlayCatalogEndMessage,
    ownerMembershipId?: string
  ): boolean {
    const staged = this.staging.get(ownerPeerId)
    if (!staged || staged.generation !== msg.generation) {
      return false
    }

    clearTimeout(staged.timer)
    this.staging.delete(ownerPeerId)

    if (staged.entries.length !== staged.count) {
      // Partial / mismatched batch count rejected
      return false
    }

    const senderMembershipId =
      msg && typeof msg === 'object' && 'senderMembershipId' in msg && typeof (msg as Record<string, unknown>).senderMembershipId === 'string'
        ? ((msg as Record<string, unknown>).senderMembershipId as string)
        : ownerSessionId

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
    entries: WireSearchResultEntry[]
    isNewQuery: boolean
  } {
    const cacheKey = `${originPeerId}:${queryId}`
    const now = Date.now()

    // Clean expired query cache
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

    const matchedEntries: WireSearchResultEntry[] = []

    for (const catalogue of this.ownerCatalogues.values()) {
      for (const file of catalogue.entries) {
        if (matchesQuery(file.name, tokens)) {
          matchedEntries.push({
            ownerPeerId: catalogue.peerId,
            ownerSessionId: catalogue.sessionId,
            ownerMembershipId: catalogue.membershipId || catalogue.sessionId,
            file
          } as unknown as WireSearchResultEntry)
          if (matchedEntries.length >= MAX_SEARCH_RESULTS) {
            return { entries: matchedEntries, isNewQuery: true }
          }
        }
      }
    }

    return { entries: matchedEntries, isNewQuery: true }
  }

  splitResultBatches(allEntries: WireSearchResultEntry[]): WireSearchResultEntry[][] {
    if (allEntries.length === 0) return []
    const batches: WireSearchResultEntry[][] = []

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
  private readonly resultsMap = new Map<string, P2pSearchResult>() // resultId -> P2pSearchResult
  private readonly seenFiles = new Set<string>() // "ownerSessionId:fileId"
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
    entries: readonly WireSearchResultEntry[],
    ownerNames: (peerId: string) => string
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
        const ownerMembershipId =
          'ownerMembershipId' in entry && typeof (entry as Record<string, unknown>).ownerMembershipId === 'string'
            ? ((entry as Record<string, unknown>).ownerMembershipId as string)
            : entry.ownerSessionId
        this.resultsMap.set(resultId, {
          resultId,
          ownerPeerId: entry.ownerPeerId,
          ownerSessionId: entry.ownerSessionId,
          ownerMembershipId,
          ownerName: ownerNames(entry.ownerPeerId) || `Peer-${entry.ownerPeerId.slice(0, 6)}`,
          file: entry.file
        } as unknown as P2pSearchResult)
        addedAny = true
      }
    }

    return addedAny
  }

  getResults(): P2pSearchResult[] {
    return Array.from(this.resultsMap.values())
  }

  resolveResult(resultId: string): (P2pSearchResult & { ownerMembershipId?: string }) | undefined {
    return this.resultsMap.get(resultId) as (P2pSearchResult & { ownerMembershipId?: string }) | undefined
  }

  pruneExpiredOwners(validIncarnations: Map<string, { sessionId: string; membershipId: string }>): boolean {
    let pruned = false
    for (const [resultId, result] of this.resultsMap.entries()) {
      const valid = validIncarnations.get(result.ownerPeerId)
      const resMembership = 'ownerMembershipId' in result ? (result as any).ownerMembershipId : result.ownerSessionId
      if (!valid || valid.sessionId !== result.ownerSessionId || (valid.membershipId && resMembership && valid.membershipId !== resMembership)) {
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
