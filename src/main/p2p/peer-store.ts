import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { validateDisplayName, validateRoomId, validateSignalingUrl } from '../../shared/p2p.ts'
import { isUuid } from '../../shared/p2p-wire.ts'

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

function validatePersistedState(data: unknown, filePath: string): PersistedPeerState {
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
      // Create fresh identity
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
      // Must not silently overwrite corrupted profiles
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
