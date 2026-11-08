import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  validateDisplayName,
  validateGroupId,
  validateSignalingUrl,
  makeGroupKey,
  parseGroupKey
} from '../../shared/p2p.ts'
import { isUuid } from '../../shared/p2p-wire.ts'

export interface PersistedGroupV2 {
  groupKey: string
  signalingUrl: string
  groupId: string
  supernodeEligible: boolean
  autoJoin: boolean
  credentialCiphertext: string | null
}

export interface PersistedSharedFileV2 {
  fileId: string
  path: string
  groupKeys: string[]
}

export interface PersistedPeerStateV2 {
  version: 2
  peerId: string
  displayName: string
  relayOnly: boolean
  groups: PersistedGroupV2[]
  sharedFiles: PersistedSharedFileV2[]
}

export interface MultiGroupPeerStore {
  get(): PersistedPeerStateV2
  setDisplayName(name: string): Promise<PersistedPeerStateV2>
  setRelayOnly(relayOnly: boolean): Promise<PersistedPeerStateV2>
  upsertGroup(
    group: PersistedGroupV2,
    identityUpdates?: { displayName?: string; relayOnly?: boolean }
  ): Promise<PersistedPeerStateV2>
  removeGroup(groupKey: string): Promise<PersistedPeerStateV2>
  setGroupAutoJoin(groupKey: string, autoJoin: boolean): Promise<PersistedPeerStateV2>
  setGroupEligibility(groupKey: string, eligible: boolean): Promise<PersistedPeerStateV2>
  setGroupCredential(groupKey: string, ciphertext: string | null): Promise<PersistedPeerStateV2>
  addSharedFile(file: { fileId: string; path: string; groupKeys?: string[] }): Promise<PersistedPeerStateV2>
  removeSharedFile(fileId: string): Promise<PersistedPeerStateV2>
  setFileGroups(fileId: string, groupKeys: string[]): Promise<PersistedPeerStateV2>
}

export function validatePersistedStateV2(data: unknown, filePath: string): PersistedPeerStateV2 {
  if (!data || typeof data !== 'object') {
    throw new Error(`Corrupt peer profile at ${filePath}: expected object payload`)
  }
  const r = data as Record<string, unknown>
  if (r.version !== 2) {
    throw new Error(`Corrupt peer profile at ${filePath}: unsupported version ${String(r.version)}`)
  }
  if (!isUuid(r.peerId)) {
    throw new Error(`Corrupt peer profile at ${filePath}: invalid peerId`)
  }
  const nameCheck = validateDisplayName(typeof r.displayName === 'string' ? r.displayName : '')
  if (!nameCheck.valid) {
    throw new Error(`Corrupt peer profile at ${filePath}: ${nameCheck.error}`)
  }
  if (typeof r.relayOnly !== 'boolean') {
    throw new Error(`Corrupt peer profile at ${filePath}: relayOnly must be boolean`)
  }

  // Validate groups
  if (!Array.isArray(r.groups)) {
    throw new Error(`Corrupt peer profile at ${filePath}: groups must be an array`)
  }

  const seenGroupKeys = new Set<string>()
  const groups: PersistedGroupV2[] = []

  for (let i = 0; i < r.groups.length; i++) {
    const item = r.groups[i]
    if (!item || typeof item !== 'object') {
      throw new Error(`Corrupt peer profile at ${filePath}: invalid group entry at index ${i}`)
    }
    const g = item as Record<string, unknown>

    if (typeof g.groupKey !== 'string') {
      throw new Error(`Corrupt peer profile at ${filePath}: missing groupKey at index ${i}`)
    }
    const parsedKey = parseGroupKey(g.groupKey)
    if (!parsedKey) {
      throw new Error(`Corrupt peer profile at ${filePath}: invalid groupKey format at index ${i}`)
    }

    const urlCheck = validateSignalingUrl(typeof g.signalingUrl === 'string' ? g.signalingUrl : '')
    if (!urlCheck.valid) {
      throw new Error(`Corrupt peer profile at ${filePath}: invalid signalingUrl in group at index ${i}`)
    }
    const groupCheck = validateGroupId(typeof g.groupId === 'string' ? g.groupId : '')
    if (!groupCheck.valid) {
      throw new Error(`Corrupt peer profile at ${filePath}: invalid groupId in group at index ${i}`)
    }

    const expectedKey = makeGroupKey(urlCheck.url, groupCheck.value)
    if (g.groupKey !== expectedKey) {
      throw new Error(`Corrupt peer profile at ${filePath}: groupKey mismatch at index ${i}`)
    }

    if (seenGroupKeys.has(expectedKey)) {
      throw new Error(`Corrupt peer profile at ${filePath}: duplicate groupKey "${expectedKey}"`)
    }
    seenGroupKeys.add(expectedKey)

    if (typeof g.supernodeEligible !== 'boolean') {
      throw new Error(`Corrupt peer profile at ${filePath}: supernodeEligible must be boolean in group at index ${i}`)
    }
    if (typeof g.autoJoin !== 'boolean') {
      throw new Error(`Corrupt peer profile at ${filePath}: autoJoin must be boolean in group at index ${i}`)
    }
    if (g.credentialCiphertext !== null && typeof g.credentialCiphertext !== 'string') {
      throw new Error(`Corrupt peer profile at ${filePath}: credentialCiphertext must be string or null in group at index ${i}`)
    }

    groups.push({
      groupKey: expectedKey,
      signalingUrl: urlCheck.url,
      groupId: groupCheck.value,
      supernodeEligible: g.supernodeEligible,
      autoJoin: g.autoJoin,
      credentialCiphertext: g.credentialCiphertext
    })
  }

  // Validate shared files
  if (!Array.isArray(r.sharedFiles)) {
    throw new Error(`Corrupt peer profile at ${filePath}: sharedFiles must be an array`)
  }

  const seenFileIds = new Set<string>()
  const seenFilePaths = new Set<string>()
  const sharedFiles: PersistedSharedFileV2[] = []
  for (let i = 0; i < r.sharedFiles.length; i++) {
    const item = r.sharedFiles[i]
    if (!item || typeof item !== 'object') {
      throw new Error(`Corrupt peer profile at ${filePath}: invalid sharedFile entry at index ${i}`)
    }
    const f = item as Record<string, unknown>

    if (!isUuid(f.fileId)) {
      throw new Error(`Corrupt peer profile at ${filePath}: invalid fileId at index ${i}`)
    }
    if (seenFileIds.has(f.fileId)) {
      throw new Error(`Corrupt peer profile at ${filePath}: duplicate fileId "${f.fileId}"`)
    }
    seenFileIds.add(f.fileId)

    if (typeof f.path !== 'string' || f.path.trim().length === 0) {
      throw new Error(`Corrupt peer profile at ${filePath}: invalid path for fileId "${f.fileId}"`)
    }
    const normalizedPath = f.path.trim()
    if (seenFilePaths.has(normalizedPath)) {
      throw new Error(`Corrupt peer profile at ${filePath}: duplicate shared file path "${normalizedPath}"`)
    }
    seenFilePaths.add(normalizedPath)
    if (!Array.isArray(f.groupKeys)) {
      throw new Error(`Corrupt peer profile at ${filePath}: groupKeys must be an array for fileId "${f.fileId}"`)
    }

    const validFileKeys: string[] = []
    const seenFileKeys = new Set<string>()
    for (const key of f.groupKeys) {
      if (typeof key !== 'string' || !parseGroupKey(key)) {
        throw new Error(`Corrupt peer profile at ${filePath}: invalid groupKey in shared file "${f.fileId}"`)
      }
      if (!seenFileKeys.has(key)) {
        seenFileKeys.add(key)
        validFileKeys.push(key)
      }
    }

    sharedFiles.push({
      fileId: f.fileId,
      path: f.path,
      groupKeys: validFileKeys
    })
  }

  return {
    version: 2,
    peerId: r.peerId,
    displayName: nameCheck.value,
    relayOnly: r.relayOnly,
    groups,
    sharedFiles
  }
}

function cloneStateV2(s: PersistedPeerStateV2): PersistedPeerStateV2 {
  return {
    version: 2,
    peerId: s.peerId,
    displayName: s.displayName,
    relayOnly: s.relayOnly,
    groups: s.groups.map((g) => ({ ...g })),
    sharedFiles: s.sharedFiles.map((f) => ({ ...f, groupKeys: [...f.groupKeys] }))
  }
}

export async function createMultiGroupPeerStore(dataDirectory: string): Promise<MultiGroupPeerStore> {
  const filePath = join(dataDirectory, 'peer-state.json')
  let currentState: PersistedPeerStateV2

  try {
    const raw = await readFile(filePath, 'utf-8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`Corrupt peer profile at ${filePath}: malformed JSON`)
    }

    currentState = validatePersistedStateV2(parsed, filePath)
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException
    if (err?.code === 'ENOENT') {
      currentState = {
        version: 2,
        peerId: randomUUID(),
        displayName: `Peer-${randomUUID().slice(0, 6)}`,
        relayOnly: false,
        groups: [],
        sharedFiles: []
      }
      await mkdir(dirname(filePath), { recursive: true })
      const tempPath = `${filePath}.${randomUUID()}.tmp`
      const payload = JSON.stringify(currentState, null, 2) + '\n'
      await writeFile(tempPath, payload, 'utf-8')
      await rename(tempPath, filePath)
    } else {
      throw error
    }
  }

  let writeQueue: Promise<void> = Promise.resolve()

  const queueMutation = (
    derive: (current: PersistedPeerStateV2) => PersistedPeerStateV2
  ): Promise<PersistedPeerStateV2> => {
    const task = async (): Promise<PersistedPeerStateV2> => {
      const nextState = derive(currentState)
      const validated = validatePersistedStateV2(nextState, filePath)
      const tempPath = `${filePath}.${randomUUID()}.tmp`
      try {
        await mkdir(dirname(filePath), { recursive: true })
        const payload = JSON.stringify(validated, null, 2) + '\n'
        await writeFile(tempPath, payload, 'utf-8')
        await rename(tempPath, filePath)
        currentState = validated
        return cloneStateV2(currentState)
      } catch (writeError) {
        await rm(tempPath, { force: true }).catch(() => {})
        throw writeError
      }
    }

    const enqueued = writeQueue.then(task)
    writeQueue = enqueued.then(
      () => {},
      () => {}
    )
    return enqueued
  }

  return {
    get: () => cloneStateV2(currentState),

    setDisplayName: (name: string) => {
      const checked = validateDisplayName(name)
      if (!checked.valid) {
        return Promise.reject(new Error(checked.error))
      }
      return queueMutation((curr) => ({
        ...curr,
        displayName: checked.value
      }))
    },

    setRelayOnly: (relayOnly: boolean) => {
      return queueMutation((curr) => ({
        ...curr,
        relayOnly: Boolean(relayOnly)
      }))
    },

    upsertGroup: (
      group: PersistedGroupV2,
      identityUpdates?: { displayName?: string; relayOnly?: boolean }
    ) => {
      return queueMutation((curr) => {
        let displayName = curr.displayName
        if (identityUpdates?.displayName !== undefined) {
          const checked = validateDisplayName(identityUpdates.displayName)
          if (!checked.valid) throw new Error(checked.error)
          displayName = checked.value
        }
        const relayOnly = identityUpdates?.relayOnly !== undefined ? Boolean(identityUpdates.relayOnly) : curr.relayOnly

        const existingIdx = curr.groups.findIndex((g) => g.groupKey === group.groupKey)
        const updatedGroups = [...curr.groups]
        if (existingIdx >= 0) {
          updatedGroups[existingIdx] = { ...group }
        } else {
          updatedGroups.push({ ...group })
        }

        return {
          ...curr,
          displayName,
          relayOnly,
          groups: updatedGroups
        }
      })
    },

    removeGroup: (groupKey: string) => {
      return queueMutation((curr) => {
        const filteredGroups = curr.groups.filter((g) => g.groupKey !== groupKey)
        const updatedSharedFiles = curr.sharedFiles.map((f) => ({
          ...f,
          groupKeys: f.groupKeys.filter((k) => k !== groupKey)
        }))
        return {
          ...curr,
          groups: filteredGroups,
          sharedFiles: updatedSharedFiles
        }
      })
    },

    setGroupAutoJoin: (groupKey: string, autoJoin: boolean) => {
      return queueMutation((curr) => {
        const idx = curr.groups.findIndex((g) => g.groupKey === groupKey)
        if (idx < 0) return curr
        const updatedGroups = [...curr.groups]
        updatedGroups[idx] = { ...updatedGroups[idx], autoJoin: Boolean(autoJoin) }
        return {
          ...curr,
          groups: updatedGroups
        }
      })
    },

    setGroupEligibility: (groupKey: string, eligible: boolean) => {
      return queueMutation((curr) => {
        const idx = curr.groups.findIndex((g) => g.groupKey === groupKey)
        if (idx < 0) return curr
        const updatedGroups = [...curr.groups]
        updatedGroups[idx] = { ...updatedGroups[idx], supernodeEligible: Boolean(eligible) }
        return {
          ...curr,
          groups: updatedGroups
        }
      })
    },

    setGroupCredential: (groupKey: string, ciphertext: string | null) => {
      return queueMutation((curr) => {
        const idx = curr.groups.findIndex((g) => g.groupKey === groupKey)
        if (idx < 0) return curr
        const updatedGroups = [...curr.groups]
        updatedGroups[idx] = { ...updatedGroups[idx], credentialCiphertext: ciphertext }
        return {
          ...curr,
          groups: updatedGroups
        }
      })
    },

    addSharedFile: (file: { fileId: string; path: string; groupKeys?: string[] }) => {
      if (!isUuid(file.fileId) || typeof file.path !== 'string' || file.path.length === 0) {
        return Promise.reject(new Error('Invalid shared file entry'))
      }
      return queueMutation((curr) => {
        const existing = curr.sharedFiles.find((f) => f.fileId === file.fileId || f.path === file.path)
        if (existing) {
          if (file.groupKeys && file.groupKeys.length > 0) {
            const combined = Array.from(new Set([...existing.groupKeys, ...file.groupKeys]))
            const updated = curr.sharedFiles.map((f) =>
              f.fileId === existing.fileId ? { ...f, groupKeys: combined } : f
            )
            return { ...curr, sharedFiles: updated }
          }
          return curr
        }
        const newKeys = file.groupKeys ? Array.from(new Set(file.groupKeys)) : []
        return {
          ...curr,
          sharedFiles: [...curr.sharedFiles, { fileId: file.fileId, path: file.path, groupKeys: newKeys }]
        }
      })
    },

    removeSharedFile: (fileId: string) => {
      return queueMutation((curr) => ({
        ...curr,
        sharedFiles: curr.sharedFiles.filter((f) => f.fileId !== fileId)
      }))
    },

    setFileGroups: (fileId: string, groupKeys: string[]) => {
      return queueMutation((curr) => {
        const existing = curr.sharedFiles.find((f) => f.fileId === fileId)
        if (!existing) return curr
        const deduplicated = Array.from(new Set(groupKeys))
        const updated = curr.sharedFiles.map((f) =>
          f.fileId === fileId ? { ...f, groupKeys: deduplicated } : f
        )
        return {
          ...curr,
          sharedFiles: updated
        }
      })
    }
  }
}
