import { createReadStream, type Stats } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type {
  P2pFileMetadata,
  P2pLibraryFile,
  P2pLibraryFileStatus,
  P2pLibraryState
} from '../../shared/p2p.ts'
import {
  MAX_CATALOG_BATCH_ENTRIES,
  MAX_CONTROL_MESSAGE_SIZE,
  isValidFileMetadata
} from '../../shared/p2p-wire.ts'
import type { PersistedSharedFile } from './peer-store.ts'

export const MAX_LIBRARY_FILES = 1000
export const MAX_FILE_SIZE = 1024 * 1024 * 1024 // 1 GiB
const MAX_CONCURRENT_HASHING = 2

export interface LocalFileEntry {
  fileId: string
  path: string
  name: string
  size: number | null
  sha256: string | null
  status: P2pLibraryFileStatus
  message: string | null
  statFingerprint: {
    size: number
    mtimeMs: number
    ino?: number
    dev?: number
  } | null
  generation: number
}

export function sanitizeBasename(rawName: string): string | null {
  const trimmed = rawName.trim()
  if (trimmed.length === 0 || trimmed === '.' || trimmed === '..') {
    return null
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return null
  }
  // Check for control characters
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
    return null
  }
  const utf8Bytes = Buffer.from(trimmed, 'utf-8')
  if (utf8Bytes.length > 255) {
    return null
  }
  return trimmed
}

export class LibraryManager {
  private readonly files = new Map<string, LocalFileEntry>() // fileId -> LocalFileEntry
  private readonly pathToId = new Map<string, string>() // canonicalPath -> fileId
  private scanningCount = 0
  private currentGeneration = 1
  private acknowledgedGeneration: number | null = null
  private readonly listeners = new Set<() => void>()

  private hashQueue: Array<() => Promise<void>> = []
  private activeHashers = 0

  constructor() {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // ignore listener errors
      }
    }
  }

  getGeneration(): number {
    return this.currentGeneration
  }

  getAcknowledgedGeneration(): number | null {
    return this.acknowledgedGeneration
  }

  setAcknowledgedGeneration(gen: number): void {
    if (this.acknowledgedGeneration === gen) return
    this.acknowledgedGeneration = gen
    this.notify()
  }

  getState(): P2pLibraryState {
    const list: P2pLibraryFile[] = Array.from(this.files.values()).map((f) => ({
      fileId: f.fileId,
      name: f.name,
      size: f.size,
      sha256: f.sha256,
      status: f.status,
      message: f.message
    }))

    return {
      status: this.scanningCount > 0 ? 'scanning' : 'idle',
      files: list,
      advertisedGeneration: this.currentGeneration,
      acknowledgedGeneration: this.acknowledgedGeneration
    }
  }

  getSharedMetadata(): P2pFileMetadata[] {
    const result: P2pFileMetadata[] = []
    for (const f of this.files.values()) {
      if (f.status === 'shared' && f.size !== null && f.sha256 !== null) {
        const meta: P2pFileMetadata = {
          fileId: f.fileId,
          name: f.name,
          size: f.size,
          sha256: f.sha256
        }
        if (isValidFileMetadata(meta)) {
          result.push(meta)
        }
      }
    }
    return result
  }

  createBatches(): P2pFileMetadata[][] {
    const all = this.getSharedMetadata()
    if (all.length === 0) return []

    const batches: P2pFileMetadata[][] = []
    let currentBatch: P2pFileMetadata[] = []
    let currentSize = 100 // baseline JSON envelope size

    for (const entry of all) {
      const entryEstimatedSize = JSON.stringify(entry).length + 2
      if (
        currentBatch.length >= MAX_CATALOG_BATCH_ENTRIES ||
        currentSize + entryEstimatedSize > MAX_CONTROL_MESSAGE_SIZE - 512
      ) {
        batches.push(currentBatch)
        currentBatch = [entry]
        currentSize = 100 + entryEstimatedSize
      } else {
        currentBatch.push(entry)
        currentSize += entryEstimatedSize
      }
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch)
    }

    return batches
  }

  async loadStoredFiles(stored: readonly PersistedSharedFile[]): Promise<void> {
    for (const s of stored) {
      if (!this.files.has(s.fileId)) {
        const name = basename(s.path)
        const entry: LocalFileEntry = {
          fileId: s.fileId,
          path: s.path,
          name: sanitizeBasename(name) || name,
          size: null,
          sha256: null,
          status: 'hashing',
          message: 'Queued for verification...',
          statFingerprint: null,
          generation: 1
        }
        this.files.set(s.fileId, entry)
        this.pathToId.set(s.path, s.fileId)
        void this.scheduleFileScan(entry)
      }
    }
  }

  async addFiles(paths: readonly string[]): Promise<Array<{ fileId: string; path: string }>> {
    const added: Array<{ fileId: string; path: string }> = []

    for (const rawPath of paths) {
      if (this.files.size >= MAX_LIBRARY_FILES) {
        break
      }

      let canonical: string
      try {
        canonical = await realpath(rawPath)
      } catch {
        // Path does not exist or cannot be resolved
        continue
      }

      if (this.pathToId.has(canonical)) {
        // Duplicate path rejected
        continue
      }

      const rawBase = basename(canonical)
      const sanitized = sanitizeBasename(rawBase)
      if (!sanitized) {
        continue
      }

      const fileId = randomUUID()
      const entry: LocalFileEntry = {
        fileId,
        path: canonical,
        name: sanitized,
        size: null,
        sha256: null,
        status: 'hashing',
        message: 'Queued for hashing...',
        statFingerprint: null,
        generation: ++this.currentGeneration
      }

      this.files.set(fileId, entry)
      this.pathToId.set(canonical, fileId)
      added.push({ fileId, path: canonical })

      void this.scheduleFileScan(entry)
    }

    this.notify()
    return added
  }

  removeFile(fileId: string): boolean {
    const entry = this.files.get(fileId)
    if (!entry) return false

    this.files.delete(fileId)
    this.pathToId.delete(entry.path)
    this.currentGeneration++
    this.acknowledgedGeneration = null
    this.notify()
    return true
  }

  async rescan(): Promise<void> {
    this.currentGeneration++
    this.acknowledgedGeneration = null

    for (const entry of this.files.values()) {
      entry.status = 'hashing'
      entry.message = 'Re-verifying file...'
      entry.generation = this.currentGeneration
      void this.scheduleFileScan(entry)
    }
    this.notify()
  }

  private scheduleFileScan(entry: LocalFileEntry): Promise<void> {
    this.scanningCount++
    this.notify()

    const task = async (): Promise<void> => {
      try {
        await this.scanEntry(entry)
      } finally {
        this.scanningCount = Math.max(0, this.scanningCount - 1)
        this.activeHashers = Math.max(0, this.activeHashers - 1)
        this.notify()
        this.drainQueue()
      }
    }

    if (this.activeHashers < MAX_CONCURRENT_HASHING) {
      this.activeHashers++
      return task()
    } else {
      this.hashQueue.push(task)
      return Promise.resolve()
    }
  }

  private drainQueue(): void {
    while (this.activeHashers < MAX_CONCURRENT_HASHING && this.hashQueue.length > 0) {
      this.activeHashers++
      const next = this.hashQueue.shift()!
      void next()
    }
  }

  private async scanEntry(entry: LocalFileEntry): Promise<void> {
    const taskGeneration = entry.generation

    let statBefore: Stats
    try {
      statBefore = await stat(entry.path)
    } catch {
      if (entry.generation !== taskGeneration) return
      entry.status = 'unavailable'
      entry.message = 'File not found or unreadable on disk'
      entry.size = null
      entry.sha256 = null
      entry.statFingerprint = null
      return
    }

    if (!statBefore.isFile()) {
      if (entry.generation !== taskGeneration) return
      entry.status = 'error'
      entry.message = 'Not a regular file'
      entry.size = null
      entry.sha256 = null
      entry.statFingerprint = null
      return
    }

    if (statBefore.size > MAX_FILE_SIZE) {
      if (entry.generation !== taskGeneration) return
      entry.status = 'error'
      entry.message = `File exceeds maximum allowed size of 1 GiB (${statBefore.size} bytes)`
      entry.size = null
      entry.sha256 = null
      entry.statFingerprint = null
      return
    }

    // Stream hash
    let digest: string
    try {
      digest = await this.computeFileHash(entry.path)
    } catch (readErr) {
      if (entry.generation !== taskGeneration) return
      entry.status = 'error'
      entry.message = `Read error during hashing: ${readErr instanceof Error ? readErr.message : String(readErr)}`
      entry.size = null
      entry.sha256 = null
      entry.statFingerprint = null
      return
    }

    // Check stat after hash
    let statAfter: Stats
    try {
      statAfter = await stat(entry.path)
    } catch {
      if (entry.generation !== taskGeneration) return
      entry.status = 'unavailable'
      entry.message = 'File vanished during hashing'
      entry.size = null
      entry.sha256 = null
      entry.statFingerprint = null
      return
    }

    if (
      statBefore.size !== statAfter.size ||
      statBefore.mtimeMs !== statAfter.mtimeMs
    ) {
      if (entry.generation !== taskGeneration) return
      entry.status = 'error'
      entry.message = 'File was modified during hashing'
      entry.size = null
      entry.sha256 = null
      entry.statFingerprint = null
      return
    }

    if (entry.generation !== taskGeneration) {
      // Outdated scan, generation advanced
      return
    }

    entry.size = statAfter.size
    entry.sha256 = digest
    entry.status = 'shared'
    entry.message = null
    entry.statFingerprint = {
      size: statAfter.size,
      mtimeMs: statAfter.mtimeMs,
      ino: statAfter.ino,
      dev: statAfter.dev
    }
  }

  private computeFileHash(filePath: string): Promise<string> {
    const { promise, resolve, reject } = Promise.withResolvers<string>()
    const hasher = createHash('sha256')
    const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 })

    stream.on('data', (chunk) => hasher.update(chunk))
    stream.on('end', () => resolve(hasher.digest('hex')))
    stream.on('error', (err) => reject(err))

    return promise
  }

  async getAuthorizedFile(fileId: string): Promise<{ path: string; size: number; sha256: string }> {
    const entry = this.files.get(fileId)
    if (!entry || entry.status !== 'shared' || entry.size === null || entry.sha256 === null) {
      throw new Error('NOT_FOUND')
    }

    // Live re-verification of stat against indexed fingerprint
    let currentStat: Stats
    try {
      currentStat = await stat(entry.path)
    } catch {
      throw new Error('NOT_FOUND')
    }

    if (
      !currentStat.isFile() ||
      currentStat.size !== entry.size ||
      (entry.statFingerprint && currentStat.mtimeMs !== entry.statFingerprint.mtimeMs)
    ) {
      entry.status = 'error'
      entry.message = 'File changed on disk since indexed'
      this.notify()
      throw new Error('FILE_CHANGED')
    }

    return {
      path: entry.path,
      size: entry.size,
      sha256: entry.sha256
    }
  }
}
