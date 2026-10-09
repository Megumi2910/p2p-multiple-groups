import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { validatePersistedState } from './p2p/peer-store.ts'

export interface PrepareProfileOptions {
  appDataDirectory: string
  explicitDataDirectory?: string
}

export interface PrepareProfileResult {
  dataDirectory: string
  notices: string[]
}

const STAGING_PREFIX = '.staging-migration-'

function getNormalizedPathIdentity(filePath: string): string {
  try {
    return realpathSync.native(filePath)
  } catch {
    return filePath
  }
}

export function findLegacyProfileDirectory(appDataDirectory: string): string | null {
  const candidateNames = ['Kazaa', 'kazaa']
  const seenIdentities = new Map<string, string>() // identity -> originalPath
  const legacyProfiles: string[] = []

  for (const name of candidateNames) {
    const candidatePath = join(appDataDirectory, name)
    if (!existsSync(candidatePath)) continue

    const identity = getNormalizedPathIdentity(candidatePath)
    if (seenIdentities.has(identity)) continue
    seenIdentities.set(identity, candidatePath)

    const stateFilePath = join(candidatePath, 'peer-state.json')
    if (existsSync(stateFilePath)) {
      legacyProfiles.push(candidatePath)
    }
  }

  if (legacyProfiles.length === 0) {
    return null
  }

  if (legacyProfiles.length > 1) {
    // Distinct directories contain peer profiles: check if they conflict
    const contents = legacyProfiles.map((p) => {
      try {
        return readFileSync(join(p, 'peer-state.json'), 'utf-8')
      } catch {
        return ''
      }
    })
    const isIdentical = contents.every((c) => c.length > 0 && c === contents[0])
    if (!isIdentical) {
      throw new Error(
        `Conflicting legacy profiles found in ${legacyProfiles.join(' and ')}. Automatic migration refused to prevent data loss.`
      )
    }
  }

  return legacyProfiles[0]
}

export function prepareProfileDirectory(options: PrepareProfileOptions): PrepareProfileResult {
  const notices: string[] = []

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

  // Check if target directory already exists
  if (existsSync(targetDir)) {
    const targetStatePath = join(targetDir, 'peer-state.json')
    if (existsSync(targetStatePath)) {
      // Existing target peer profile is authoritative; never merge
      return {
        dataDirectory: targetDir,
        notices: ['Existing p2p-multiple-groups profile found. Legacy profile preserved untouched.']
      }
    }

    // Target directory exists but has NO peer-state.json
    const entries = readdirSync(targetDir)
    if (entries.length > 0) {
      // Contains unknown files or settings without peer profile: refuse to overwrite
      throw new Error(
        `Target directory ${targetDir} contains files but no peer profile. Refusing automatic migration to prevent overwriting unknown contents.`
      )
    }

    // Target directory is completely empty: remove it so atomic rename can proceed
    try {
      rmdirSync(targetDir)
    } catch (rmErr) {
      throw new Error(
        `Failed to clean up empty target directory ${targetDir} before migration: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`
      )
    }
  }

  // Check for legacy profile to import
  const legacyDir = findLegacyProfileDirectory(appData)
  if (!legacyDir) {
    mkdirSync(targetDir, { recursive: true })
    return {
      dataDirectory: targetDir,
      notices
    }
  }

  // Validate legacy peer profile before copying
  const legacyStatePath = join(legacyDir, 'peer-state.json')
  const legacyRaw = readFileSync(legacyStatePath, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(legacyRaw)
  } catch {
    throw new Error(`Corrupt legacy peer profile at ${legacyStatePath}: malformed JSON`)
  }
  // Validate that it has valid peer state structure
  validatePersistedState(parsed, legacyStatePath)

  // Stage migration into an owned sibling directory
  const stagingDir = join(appData, `${STAGING_PREFIX}${randomUUID()}`)
  mkdirSync(stagingDir, { recursive: true })

  try {
    copyFileSync(legacyStatePath, join(stagingDir, 'peer-state.json'))

    const legacySettingsPath = join(legacyDir, 'settings.json')
    if (existsSync(legacySettingsPath)) {
      copyFileSync(legacySettingsPath, join(stagingDir, 'settings.json'))
    }

    // Atomic rename staging directory into target
    renameSync(stagingDir, targetDir)
    notices.push(
      `Successfully migrated profile from ${legacyDir} to ${targetDir}. Original legacy profile preserved.`
    )
  } catch (copyError) {
    rmSync(stagingDir, { recursive: true, force: true })
    throw copyError
  }

  return {
    dataDirectory: targetDir,
    notices
  }
}
