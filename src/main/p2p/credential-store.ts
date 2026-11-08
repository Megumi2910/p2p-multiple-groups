import type { SafeStorage } from 'electron'
import { mkdirSync } from 'node:fs'
import { readFile, writeFile, rename, unlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface CredentialStoreFileIO {
  readFile: (path: Parameters<typeof readFile>[0]) => Promise<Buffer>
  writeFile: typeof writeFile
  rename: typeof rename
  unlink: typeof unlink
  rm: typeof rm
}

export interface CredentialStoreOptions {
  dataDirectory: string
  mockEncryption?: {
    isAvailable(): boolean
    encrypt(plain: string): Buffer
    decrypt(cipher: Buffer): string
  }
  fileIO?: CredentialStoreFileIO
}

export interface CredentialStore {
  getCredential(groupKey: string): Promise<string | null>
  setCredential(groupKey: string, token: string): Promise<'stored' | 'memory'>
  deleteCredential(groupKey: string): Promise<void>
  clear(): Promise<void>
}

// Exception: platform-specific module; 'electron' runtime APIs are only present when running inside Electron binary, not plain Node.js test runner.
let electronSafeStorage: SafeStorage | null = null

try {
  const electron = await import('electron')
  if (electron && typeof electron === 'object' && 'safeStorage' in electron && electron.safeStorage) {
    electronSafeStorage = electron.safeStorage as SafeStorage
  }
} catch {
  // Plain Node.js runtime / headless environment
}

export class SafeCredentialStore implements CredentialStore {
  private readonly filePath: string
  private readonly memoryCache = new Map<string, string>() // groupKey -> token
  private readonly mockEncryption?: CredentialStoreOptions['mockEncryption']
  private readonly fileIO: CredentialStoreFileIO
  private isLoaded = false
  private hasPendingDiskSnapshot = false
  private queue: Promise<void> = Promise.resolve()

  constructor(options: CredentialStoreOptions) {
    if (options.dataDirectory) {
      mkdirSync(options.dataDirectory, { recursive: true })
    }
    this.filePath = join(options.dataDirectory, 'credentials.enc')
    this.mockEncryption = options.mockEncryption
    this.fileIO = options.fileIO ?? { readFile, writeFile, rename, unlink, rm }
  }

  private isEncryptionSupported(): boolean {
    if (this.mockEncryption) {
      return this.mockEncryption.isAvailable()
    }
    try {
      return Boolean(
        electronSafeStorage &&
          typeof electronSafeStorage.isEncryptionAvailable === 'function' &&
          electronSafeStorage.isEncryptionAvailable()
      )
    } catch {
      return false
    }
  }

  private encrypt(plainText: string): Buffer {
    if (this.mockEncryption) {
      return this.mockEncryption.encrypt(plainText)
    }
    if (electronSafeStorage) {
      return electronSafeStorage.encryptString(plainText)
    }
    throw new Error('Encryption is not available')
  }

  private decrypt(cipherBuffer: Buffer): string {
    if (this.mockEncryption) {
      return this.mockEncryption.decrypt(cipherBuffer)
    }
    if (electronSafeStorage) {
      return electronSafeStorage.decryptString(cipherBuffer)
    }
    throw new Error('Encryption is not available')
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.isLoaded) {
      try {
        const encryptedBytes = await this.fileIO.readFile(this.filePath)
        if (encryptedBytes.length === 0) {
          this.hasPendingDiskSnapshot = false
          this.isLoaded = true
          return
        }

        if (!this.isEncryptionSupported()) {
          this.hasPendingDiskSnapshot = true
          this.isLoaded = true
          return
        }

        try {
          const decryptedJson = this.decrypt(encryptedBytes)
          const parsed = JSON.parse(decryptedJson)
          if (parsed && typeof parsed === 'object') {
            for (const [k, v] of Object.entries(parsed)) {
              if (typeof v === 'string') {
                this.memoryCache.set(k, v)
              }
            }
          }
          this.hasPendingDiskSnapshot = false
        } catch (err) {
          console.warn('[credential-store] Failed to decrypt saved credentials; operating in memory-only mode:', err)
          this.hasPendingDiskSnapshot = false
        }
        this.isLoaded = true
      } catch (readErr: unknown) {
        if (readErr && typeof readErr === 'object' && 'code' in readErr && readErr.code === 'ENOENT') {
          this.hasPendingDiskSnapshot = false
          this.isLoaded = true
        } else {
          throw readErr
        }
      }
    }

    if (this.hasPendingDiskSnapshot && this.isEncryptionSupported()) {
      try {
        const encryptedBytes = await this.fileIO.readFile(this.filePath)
        if (encryptedBytes.length > 0) {
          const decryptedJson = this.decrypt(encryptedBytes)
          const parsed = JSON.parse(decryptedJson)
          if (parsed && typeof parsed === 'object') {
            for (const [k, v] of Object.entries(parsed)) {
              if (typeof v === 'string' && !this.memoryCache.has(k)) {
                this.memoryCache.set(k, v)
              }
            }
          }
        }
        this.hasPendingDiskSnapshot = false
      } catch (err) {
        console.warn('[credential-store] Failed to decrypt pending disk credentials:', err)
        this.hasPendingDiskSnapshot = false
      }
    }
  }

  private queueOperation<T>(op: () => Promise<T>): Promise<T> {
    const task = async (): Promise<T> => {
      await this.ensureLoaded()
      return await op()
    }
    const enqueued = this.queue.then(task)
    this.queue = enqueued.then(
      () => {},
      () => {}
    )
    return enqueued
  }

  async getCredential(groupKey: string): Promise<string | null> {
    return this.queueOperation(async () => {
      return this.memoryCache.get(groupKey) ?? null
    })
  }

  async setCredential(groupKey: string, token: string): Promise<'stored' | 'memory'> {
    return this.queueOperation(async () => {
      if (!this.isEncryptionSupported()) {
        this.memoryCache.set(groupKey, token)
        return 'memory'
      }

      const nextMap = new Map(this.memoryCache)
      nextMap.set(groupKey, token)

      const obj: Record<string, string> = {}
      for (const [k, v] of nextMap.entries()) {
        obj[k] = v
      }
      const rawJson = JSON.stringify(obj)
      const encrypted = this.encrypt(rawJson)

      const tempPath = `${this.filePath}.${randomUUID()}.tmp`
      try {
        await this.fileIO.writeFile(tempPath, encrypted, { flag: 'wx', mode: 0o600 })
        await this.fileIO.rename(tempPath, this.filePath)
        this.memoryCache.set(groupKey, token)
        this.hasPendingDiskSnapshot = false
        return 'stored'
      } catch (writeErr) {
        try {
          await this.fileIO.unlink(tempPath)
        } catch {
          // ignore cleanup error
        }
        throw writeErr
      }
    })
  }

  async deleteCredential(groupKey: string): Promise<void> {
    return this.queueOperation(async () => {
      if (!this.isEncryptionSupported()) {
        if (this.hasPendingDiskSnapshot) {
          throw new Error('Cannot delete credential: encrypted credential file exists on disk but encryption is unavailable')
        }
        this.memoryCache.delete(groupKey)
        return
      }

      const existedInMemory = this.memoryCache.has(groupKey)
      let fileExists = true
      try {
        await this.fileIO.readFile(this.filePath)
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
          fileExists = false
        }
      }

      if (!existedInMemory && !fileExists) {
        return
      }

      const nextMap = new Map(this.memoryCache)
      nextMap.delete(groupKey)

      const obj: Record<string, string> = {}
      for (const [k, v] of nextMap.entries()) {
        obj[k] = v
      }
      const rawJson = JSON.stringify(obj)
      const encrypted = this.encrypt(rawJson)

      const tempPath = `${this.filePath}.${randomUUID()}.tmp`
      try {
        await this.fileIO.writeFile(tempPath, encrypted, { flag: 'wx', mode: 0o600 })
        await this.fileIO.rename(tempPath, this.filePath)
        this.memoryCache.delete(groupKey)
        this.hasPendingDiskSnapshot = false
      } catch (writeErr) {
        try {
          await this.fileIO.unlink(tempPath)
        } catch {
          // ignore cleanup error
        }
        throw writeErr
      }
    })
  }

  async clear(): Promise<void> {
    const task = async (): Promise<void> => {
      try {
        await this.fileIO.unlink(this.filePath)
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && err.code !== 'ENOENT') {
          throw err
        }
      }
      this.memoryCache.clear()
      this.hasPendingDiskSnapshot = false
      this.isLoaded = true
    }
    const enqueued = this.queue.then(task)
    this.queue = enqueued.then(
      () => {},
      () => {}
    )
    return enqueued
  }
}

export function createCredentialStore(options: CredentialStoreOptions): CredentialStore {
  return new SafeCredentialStore(options)
}
