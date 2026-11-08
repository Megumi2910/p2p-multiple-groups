import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync
} from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { validatePersistedStateV2 } from './p2p/peer-store.ts'

export interface PrepareProfileOptions {
  appDataDirectory: string
  explicitDataDirectory?: string
}

export interface PrepareProfileResult {
  dataDirectory: string
  notices: string[]
}

const STAGING_PREFIX = '.staging-migration-'

export function prepareProfileDirectory(options: PrepareProfileOptions): PrepareProfileResult {
  if (options.explicitDataDirectory) {
    const dir = options.explicitDataDirectory
    mkdirSync(dir, { recursive: true })
    return {
      dataDirectory: dir,
      notices: []
    }
  }

  const appData = options.appDataDirectory
  const targetDir = join(appData, 'p2p-multiple-groups')

  // Clean up any stale incomplete staging directories from prior failed attempts
  try {
    if (existsSync(appData)) {
      const entries = readdirSync(appData)
      for (const entry of entries) {
        if (entry.startsWith(STAGING_PREFIX)) {
          rmSync(join(appData, entry), { recursive: true, force: true })
        }
      }
    }
  } catch {
    // ignore staging cleanup error
  }

  if (existsSync(targetDir)) {
    const targetStatePath = join(targetDir, 'peer-state.json')
    if (existsSync(targetStatePath)) {
      const raw = readFileSync(targetStatePath, 'utf-8')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new Error(`Corrupt peer profile at ${targetStatePath}: malformed JSON`)
      }
      validatePersistedStateV2(parsed, targetStatePath)
      return {
        dataDirectory: targetDir,
        notices: []
      }
    }
  }

  mkdirSync(targetDir, { recursive: true })
  return {
    dataDirectory: targetDir,
    notices: []
  }
}

export function getCanonicalTargetIdentity(targetPath: string): string {
  const absolutePath = resolve(targetPath)

  let current = absolutePath
  const missingSegments: string[] = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    missingSegments.unshift(basename(current))
    current = parent
  }

  let canonicalBase: string
  try {
    canonicalBase = realpathSync.native(current)
  } catch {
    canonicalBase = current
  }

  let canonicalPath = missingSegments.length > 0 ? join(canonicalBase, ...missingSegments) : canonicalBase

  if (process.platform === 'win32') {
    canonicalPath = canonicalPath.toLowerCase()
  }

  return canonicalPath
}

export function getCoordinationLockDirectory(appDataDirectory: string, targetPath: string): string {
  const identity = getCanonicalTargetIdentity(targetPath)
  const hash = createHash('sha256').update(identity, 'utf-8').digest('hex')
  return join(appDataDirectory, '.p2p-multiple-groups-instance-locks', hash)
}

export function prepareProfileDirectoryWithLock(
  options: PrepareProfileOptions,
  acquireLock: (lockDirectory: string) => boolean
): PrepareProfileResult | null {
  const targetPath = options.explicitDataDirectory || join(options.appDataDirectory, 'p2p-multiple-groups')
  const lockDirectory = getCoordinationLockDirectory(options.appDataDirectory, targetPath)

  mkdirSync(lockDirectory, { recursive: true })

  const acquired = acquireLock(lockDirectory)
  if (!acquired) {
    return null
  }

  return prepareProfileDirectory(options)
}
