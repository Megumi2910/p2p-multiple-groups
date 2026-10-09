import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  validateDisplayName,
  validateRoomId,
  validateGroupId,
  validateSignalingUrl,
  makeGroupKey,
  parseGroupKey
} from '../../shared/p2p.ts'
import { isUuid } from '../../shared/p2p-wire.ts'

// ==========================================
// V1 Contracts (Preserved for Phase 1 & 2)
// ==========================================

export interface PersistedSharedFile {
  fileId: string
  path: string
}

export interface PersistedPeerState {
  version: 1
  peerId: string
  displayName: string
  supernodeEligible: boolean
  signalingUrl: string
  roomId: string
  sharedFiles: PersistedSharedFile[]
}

export interface PeerStore {
  get(): PersistedPeerState
  setDisplayName(name: string): Promise<PersistedPeerState>
  setSupernodeEligible(eligible: boolean): Promise<PersistedPeerState>
  setConnectionParams(signalingUrl: string, roomId: string): Promise<PersistedPeerState>
  addSharedFile(file: PersistedSharedFile): Promise<PersistedPeerState>
  removeSharedFile(fileId: string): Promise<PersistedPeerState>
  setSharedFiles(files: PersistedSharedFile[]): Promise<PersistedPeerState>
}

export function validatePersistedState(data: unknown, filePath: string): PersistedPeerState {
  if (!data || typeof data !== 'object') {
    throw new Error(`Corrupt peer profile at ${filePath}: expected object payload`)
  }
  const r = data as Record<string, unknown>
  if (r.version !== 1) {
    throw new Error(`Corrupt peer profile at ${filePath}: unsupported version ${String(r.version)}`)
  }
  if (!isUuid(r.peerId)) {
    throw new Error(`Corrupt peer profile at ${filePath}: invalid peerId`)
  }
  const nameCheck = validateDisplayName(typeof r.displayName === 'string' ? r.displayName : '')
  if (!nameCheck.valid) {
    throw new Error(`Corrupt peer profile at ${filePath}: invalid displayName: ${nameCheck.error}`)
  }
  if (typeof r.supernodeEligible !== 'boolean') {
    throw new Error(`Corrupt peer profile at ${filePath}: invalid supernodeEligible`)
  }
  const sigUrl = typeof r.signalingUrl === 'string' ? r.signalingUrl : ''
  if (sigUrl.length > 0) {
    const urlCheck = validateSignalingUrl(sigUrl)
    if (!urlCheck.valid) {
      throw new Error(`Corrupt peer profile at ${filePath}: invalid signalingUrl: ${urlCheck.error}`)
    }
  }
  const rmId = typeof r.roomId === 'string' ? r.roomId : ''
  if (rmId.length > 0) {
    const rmCheck = validateRoomId(rmId)
    if (!rmCheck.valid) {
      throw new Error(`Corrupt peer profile at ${filePath}: invalid roomId: ${rmCheck.error}`)
    }
  }

  if (!Array.isArray(r.sharedFiles)) {
    throw new Error(`Corrupt peer profile at ${filePath}: sharedFiles must be an array`)
  }

  const validatedFiles: PersistedSharedFile[] = []
  for (const f of r.sharedFiles) {
    if (!f || typeof f !== 'object') {
      throw new Error(`Corrupt peer profile at ${filePath}: invalid sharedFile entry`)
    }
    const fe = f as Record<string, unknown>
    if (!isUuid(fe.fileId) || typeof fe.path !== 'string' || fe.path.length === 0) {
      throw new Error(`Corrupt peer profile at ${filePath}: invalid sharedFile attributes`)
    }
    validatedFiles.push({ fileId: fe.fileId as string, path: fe.path as string })
  }

  return {
    version: 1,
    peerId: r.peerId as string,
    displayName: nameCheck.value,
    supernodeEligible: r.supernodeEligible,
    signalingUrl: sigUrl,
    roomId: rmId,
    sharedFiles: validatedFiles
  }
}

export async function createPeerStore(dataDirectory: string): Promise<PeerStore> {
  const filePath = join(dataDirectory, 'peer-state.json')
  let currentState: PersistedPeerState

  try {
    const raw = await readFile(filePath, 'utf-8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`Corrupt peer profile at ${filePath}: malformed JSON`)
    }
    currentState = validatePersistedState(parsed, filePath)
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException
    if (err?.code === 'ENOENT') {
      currentState = {
        version: 1,
        peerId: randomUUID(),
        displayName: `Peer-${randomUUID().slice(0, 6)}`,
        supernodeEligible: true,
        signalingUrl: '',
        roomId: '',
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

  const persist = (nextState: PersistedPeerState): Promise<PersistedPeerState> => {
    const task = async (): Promise<PersistedPeerState> => {
      const tempPath = `${filePath}.${randomUUID()}.tmp`
      try {
        await mkdir(dirname(filePath), { recursive: true })
        const payload = JSON.stringify(nextState, null, 2) + '\n'
        await writeFile(tempPath, payload, 'utf-8')
        await rename(tempPath, filePath)
        currentState = nextState
        return currentState
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
    get: () => ({ ...currentState, sharedFiles: [...currentState.sharedFiles] }),

    setDisplayName: (name: string) => {
      const checked = validateDisplayName(name)
      if (!checked.valid) {
        return Promise.reject(new Error(checked.error))
      }
      return persist({ ...currentState, displayName: checked.value })
    },

    setSupernodeEligible: (eligible: boolean) => {
      return persist({ ...currentState, supernodeEligible: Boolean(eligible) })
    },

    setConnectionParams: (signalingUrl: string, roomId: string) => {
      const urlCheck = validateSignalingUrl(signalingUrl)
      if (!urlCheck.valid) return Promise.reject(new Error(urlCheck.error))
      const roomCheck = validateRoomId(roomId)
      if (!roomCheck.valid) return Promise.reject(new Error(roomCheck.error))
      return persist({
        ...currentState,
        signalingUrl: urlCheck.url,
        roomId: roomCheck.value
      })
    },

    addSharedFile: (file: PersistedSharedFile) => {
      if (!isUuid(file.fileId) || typeof file.path !== 'string' || file.path.length === 0) {
        return Promise.reject(new Error('Invalid shared file entry'))
      }
      const existing = currentState.sharedFiles.find(
        (f) => f.fileId === file.fileId || f.path === file.path
      )
      if (existing) {
        return Promise.resolve(currentState)
      }
      return persist({
        ...currentState,
        sharedFiles: [...currentState.sharedFiles, file]
      })
    },

    removeSharedFile: (fileId: string) => {
      const filtered = currentState.sharedFiles.filter((f) => f.fileId !== fileId)
      if (filtered.length === currentState.sharedFiles.length) {
        return Promise.resolve(currentState)
      }
      return persist({
        ...currentState,
        sharedFiles: filtered
      })
    },

    setSharedFiles: (files: PersistedSharedFile[]) => {
      return persist({
        ...currentState,
        sharedFiles: [...files]
      })
    }
  }
}

// ==========================================
// V2 Contracts (Group-Aware Multiplexed)
// ==========================================

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

export function migratePeerStateV1(
  data: unknown,
  filePath: string
): { state: PersistedPeerStateV2; notices: string[] } {
  const v1 = validatePersistedState(data, filePath)
  const notices: string[] = []

  let groups: PersistedGroupV2[] = []
  const initialGroupKeys: string[] = []

  if (v1.signalingUrl && v1.roomId) {
    const urlCheck = validateSignalingUrl(v1.signalingUrl)
    const roomCheck = validateRoomId(v1.roomId)
    if (urlCheck.valid && roomCheck.valid) {
      const groupKey = makeGroupKey(urlCheck.url, roomCheck.value)
      initialGroupKeys.push(groupKey)
      groups.push({
        groupKey,
        signalingUrl: urlCheck.url,
        groupId: roomCheck.value,
        supernodeEligible: v1.supernodeEligible,
        autoJoin: false,
        credentialCiphertext: null
      })
    } else {
      notices.push('Legacy connection parameters were invalid. Files remain unshared until a valid group is joined.')
    }
  } else {
    notices.push('Legacy connection parameters were incomplete. Files remain unshared until a group is joined.')
  }

  const sharedFiles: PersistedSharedFileV2[] = v1.sharedFiles.map((f) => ({
    fileId: f.fileId,
    path: f.path,
    groupKeys: [...initialGroupKeys]
  }))

  return {
    state: {
      version: 2,
      peerId: v1.peerId,
      displayName: v1.displayName,
      relayOnly: false,
      groups,
      sharedFiles
    },
    notices
  }
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
    throw new Error(`Corrupt peer profile at ${filePath}: invalid displayName: ${nameCheck.error}`)
  }
  if (typeof r.relayOnly !== 'boolean') {
    throw new Error(`Corrupt peer profile at ${filePath}: invalid relayOnly`)
  }

  if (!Array.isArray(r.groups)) {
    throw new Error(`Corrupt peer profile at ${filePath}: groups must be an array`)
  }
  const groups: PersistedGroupV2[] = []
  const groupKeys = new Set<string>()

  for (const g of r.groups) {
    if (!g || typeof g !== 'object') {
      throw new Error(`Corrupt peer profile at ${filePath}: invalid group entry`)
    }
    const ge = g as Record<string, unknown>
    const urlCheck = validateSignalingUrl(typeof ge.signalingUrl === 'string' ? ge.signalingUrl : '')
    if (!urlCheck.valid) {
      throw new Error(`Corrupt peer profile at ${filePath}: invalid group signalingUrl: ${urlCheck.error}`)
    }
    const groupCheck = validateGroupId(typeof ge.groupId === 'string' ? ge.groupId : '')
    if (!groupCheck.valid) {
      throw new Error(`Corrupt peer profile at ${filePath}: invalid groupId: ${groupCheck.error}`)
    }
    const expectedKey = makeGroupKey(urlCheck.url, groupCheck.value)
    if (ge.groupKey !== expectedKey) {
      throw new Error(`Corrupt peer profile at ${filePath}: mismatched groupKey ${String(ge.groupKey)}`)
    }
    if (groupKeys.has(expectedKey)) {
      throw new Error(`Corrupt peer profile at ${filePath}: duplicate groupKey ${expectedKey}`)
    }
    if (typeof ge.supernodeEligible !== 'boolean') {
      throw new Error(`Corrupt peer profile at ${filePath}: invalid group supernodeEligible`)
    }
    if (typeof ge.autoJoin !== 'boolean') {
      throw new Error(`Corrupt peer profile at ${filePath}: invalid group autoJoin`)
    }
    if (ge.credentialCiphertext !== null && typeof ge.credentialCiphertext !== 'string') {
      throw new Error(`Corrupt peer profile at ${filePath}: invalid group credentialCiphertext`)
    }
    groupKeys.add(expectedKey)
    groups.push({
      groupKey: expectedKey,
      signalingUrl: urlCheck.url,
      groupId: groupCheck.value,
      supernodeEligible: ge.supernodeEligible,
      autoJoin: ge.autoJoin,
      credentialCiphertext: ge.credentialCiphertext
    })
  }

  if (!Array.isArray(r.sharedFiles)) {
    throw new Error(`Corrupt peer profile at ${filePath}: sharedFiles must be an array`)
  }
  const sharedFiles: PersistedSharedFileV2[] = []
  const fileIds = new Set<string>()
  const filePaths = new Set<string>()

  for (const f of r.sharedFiles) {
    if (!f || typeof f !== 'object') {
      throw new Error(`Corrupt peer profile at ${filePath}: invalid sharedFile entry`)
    }
    const fe = f as Record<string, unknown>
    if (!isUuid(fe.fileId)) {
      throw new Error(`Corrupt peer profile at ${filePath}: invalid sharedFile fileId`)
    }
    if (fileIds.has(fe.fileId as string)) {
      throw new Error(`Corrupt peer profile at ${filePath}: duplicate sharedFile fileId ${String(fe.fileId)}`)
    }
    if (typeof fe.path !== 'string' || fe.path.length === 0) {
      throw new Error(`Corrupt peer profile at ${filePath}: invalid sharedFile path`)
    }
    if (filePaths.has(fe.path)) {
      throw new Error(`Corrupt peer profile at ${filePath}: duplicate sharedFile path ${fe.path}`)
    }
    if (!Array.isArray(fe.groupKeys)) {
      throw new Error(`Corrupt peer profile at ${filePath}: sharedFile groupKeys must be an array`)
    }
    const validFileKeys: string[] = []
    for (const k of fe.groupKeys) {
      if (typeof k !== 'string' || !parseGroupKey(k)) {
        throw new Error(`Corrupt peer profile at ${filePath}: invalid groupKey in sharedFile: ${String(k)}`)
      }
      if (!validFileKeys.includes(k)) {
        validFileKeys.push(k)
      }
    }
    fileIds.add(fe.fileId as string)
    filePaths.add(fe.path)
    sharedFiles.push({
      fileId: fe.fileId as string,
      path: fe.path,
      groupKeys: validFileKeys
    })
  }

  return {
    version: 2,
    peerId: r.peerId as string,
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
  const backupPath = join(dataDirectory, 'peer-state.v1.backup.json')
  let currentState: PersistedPeerStateV2

  try {
    const raw = await readFile(filePath, 'utf-8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`Corrupt peer profile at ${filePath}: malformed JSON`)
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`Corrupt peer profile at ${filePath}: expected object payload`)
    }
    const version = (parsed as Record<string, unknown>).version

    if (version === 2) {
      currentState = validatePersistedStateV2(parsed, filePath)
    } else if (version === 1) {
      // Migrate v1 to v2 with exclusive backup creation
      const migrationResult = migratePeerStateV1(parsed, filePath)
      currentState = migrationResult.state

      // Exclusive creation of v1 backup
      try {
        await writeFile(backupPath, raw, { flag: 'wx', encoding: 'utf-8' })
      } catch (backupError) {
        const err = backupError as NodeJS.ErrnoException
        if (err?.code === 'EEXIST') {
          // Verify existing backup content matches original raw
          const existingBackup = await readFile(backupPath, 'utf-8')
          if (existingBackup !== raw) {
            throw new Error(`Conflicting backup exists at ${backupPath}: existing backup content differs from current peer-state.json`)
          }
        } else {
          throw backupError
        }
      }

      // Atomic write of migrated v2 state
      await mkdir(dirname(filePath), { recursive: true })
      const tempPath = `${filePath}.${randomUUID()}.tmp`
      const payload = JSON.stringify(currentState, null, 2) + '\n'
      await writeFile(tempPath, payload, 'utf-8')
      await rename(tempPath, filePath)
    } else {
      throw new Error(`Corrupt peer profile at ${filePath}: unsupported version ${String(version)}`)
    }
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
