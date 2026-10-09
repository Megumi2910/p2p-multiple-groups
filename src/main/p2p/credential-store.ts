import type { SafeStorage } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export interface CredentialStoreOptions {
  dataDirectory: string
  mockEncryption?: {
    isAvailable: () => boolean
    encrypt: (plainText: string) => Buffer
    decrypt: (cipherBuffer: Buffer) => string
  }
}

export interface CredentialStore {
  getCredential(groupKey: string): Promise<string | null>
  setCredential(groupKey: string, token: string): Promise<void>
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
  private isLoaded = false

  constructor(options: CredentialStoreOptions) {
    if (options.dataDirectory) {
      mkdirSync(options.dataDirectory, { recursive: true })
    }
    this.filePath = join(options.dataDirectory, 'credentials.enc')
    this.mockEncryption = options.mockEncryption
  }

  private isEncryptionSupported(): boolean {
    if (this.mockEncryption) {
      return this.mockEncryption.isAvailable()
    }
    try {
      return Boolean(electronSafeStorage && typeof electronSafeStorage.isEncryptionAvailable === 'function' && electronSafeStorage.isEncryptionAvailable())
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

  private async load(): Promise<void> {
    if (this.isLoaded) return
    this.isLoaded = true

    if (!this.isEncryptionSupported() || !existsSync(this.filePath)) {
      return
    }

    try {
      const encryptedBytes = await readFile(this.filePath)
      if (encryptedBytes.length === 0) return

      const decryptedJson = this.decrypt(encryptedBytes)
      const parsed = JSON.parse(decryptedJson)
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string') {
            this.memoryCache.set(k, v)
          }
        }
      }
    } catch (err) {
      console.warn('[credential-store] Failed to decrypt saved credentials; operating in memory-only mode:', err)
    }
  }

  private async persist(): Promise<void> {
    if (!this.isEncryptionSupported()) {
      return
    }

    try {
      const obj: Record<string, string> = {}
      for (const [k, v] of this.memoryCache.entries()) {
        obj[k] = v
      }
      const rawJson = JSON.stringify(obj)
      const encrypted = this.encrypt(rawJson)
      await writeFile(this.filePath, encrypted)
    } catch (err) {
      console.warn('[credential-store] Failed to save encrypted credentials:', err)
    }
  }

  async getCredential(groupKey: string): Promise<string | null> {
    await this.load()
    return this.memoryCache.get(groupKey) || null
  }

  async setCredential(groupKey: string, token: string): Promise<void> {
    await this.load()
    this.memoryCache.set(groupKey, token)
    await this.persist()
  }

  async deleteCredential(groupKey: string): Promise<void> {
    await this.load()
    if (this.memoryCache.delete(groupKey)) {
      await this.persist()
    }
  }

  async clear(): Promise<void> {
    this.memoryCache.clear()
    this.isLoaded = true
    try {
      await unlink(this.filePath)
    } catch {
      // ignore
    }
  }
}

export function createCredentialStore(options: CredentialStoreOptions): CredentialStore {
  return new SafeCredentialStore(options)
}
