import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rename, unlink, rm, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCredentialStore, type CredentialStoreFileIO } from '../src/main/p2p/credential-store.ts'

describe('CredentialStore Persistence & Security', () => {
  it('stores and retrieves encrypted credentials across distinct store instances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cred-test-'))

    // Provide mock symmetric encryption for headless node environment
    const mockEncryption = {
      isAvailable: () => true,
      encrypt: (text: string) => Buffer.from(text.split('').reverse().join(''), 'utf-8'),
      decrypt: (buf: Buffer) => buf.toString('utf-8').split('').reverse().join('')
    }

    try {
      const store1 = createCredentialStore({ dataDirectory: dir, mockEncryption })
      const res1 = await store1.setCredential('group-1', 'token-secret-1')
      const res2 = await store1.setCredential('group-2', 'token-secret-2')
      assert.equal(res1, 'stored')
      assert.equal(res2, 'stored')

      assert.equal(await store1.getCredential('group-1'), 'token-secret-1')
      assert.equal(await store1.getCredential('group-2'), 'token-secret-2')
      assert.equal(await store1.getCredential('group-3'), null)

      // Verify file on disk is encrypted (does not contain plaintext tokens)
      const diskBytes = await readFile(join(dir, 'credentials.enc'), 'utf-8')
      assert.equal(diskBytes.includes('token-secret-1'), false, 'Disk file must not contain raw plaintext token')

      // Second store instance on same directory
      const store2 = createCredentialStore({ dataDirectory: dir, mockEncryption })
      assert.equal(await store2.getCredential('group-1'), 'token-secret-1')
      assert.equal(await store2.getCredential('group-2'), 'token-secret-2')

      // Delete credential
      await store2.deleteCredential('group-1')
      assert.equal(await store2.getCredential('group-1'), null)

      const store3 = createCredentialStore({ dataDirectory: dir, mockEncryption })
      assert.equal(await store3.getCredential('group-1'), null)
      assert.equal(await store3.getCredential('group-2'), 'token-secret-2')

      // Clear all
      await store3.clear()
      assert.equal(await store3.getCredential('group-2'), null)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('falls back gracefully to memory-only storage when encryption is unavailable without crashing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cred-unavail-'))

    const mockDisabled = {
      isAvailable: () => false,
      encrypt: () => {
        throw new Error('Unused')
      },
      decrypt: () => {
        throw new Error('Unused')
      }
    }

    try {
      const store = createCredentialStore({ dataDirectory: dir, mockEncryption: mockDisabled })
      const res = await store.setCredential('mem-group', 'mem-token')
      assert.equal(res, 'memory')
      assert.equal(await store.getCredential('mem-group'), 'mem-token')

      // Must not write encrypted file to disk when encryption is unsupported
      await assert.rejects(
        async () => stat(join(dir, 'credentials.enc')),
        (err: unknown) => Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT')
      )
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('recovers gracefully from corrupt encrypted ciphertext on disk without crashing startup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cred-corrupt-'))
    const credPath = join(dir, 'credentials.enc')
    await writeFile(credPath, Buffer.from('NOT_VALID_CIPHERTEXT', 'utf-8'))

    const mockEncryption: {
      isAvailable: () => boolean
      encrypt: (text: string) => Buffer
      decrypt: (buf: Buffer) => string
    } = {
      isAvailable: () => true,
      encrypt: (text: string) => Buffer.from(text, 'utf-8'),
      decrypt: () => {
        throw new Error('Invalid padding or signature')
      }
    }

    try {
      const store = createCredentialStore({ dataDirectory: dir, mockEncryption })
      // Reading corrupt file should not crash; returns null and operates gracefully
      const val = await store.getCredential('some-key')
      assert.equal(val, null)

      // Writing new credential recovers the store
      mockEncryption.decrypt = (buf: Buffer) => buf.toString('utf-8')
      const res = await store.setCredential('recovered-key', 'recovered-token')
      assert.equal(res, 'stored')
      assert.equal(await store.getCredential('recovered-key'), 'recovered-token')
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('serializes operations through queue and preserves invocation order during paused read and across clear/reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cred-queue-'))

    const mockEncryption = {
      isAvailable: () => true,
      encrypt: (text: string) => Buffer.from(text.split('').reverse().join(''), 'utf-8'),
      decrypt: (buf: Buffer) => buf.toString('utf-8').split('').reverse().join('')
    }

    try {
      // 1. Seed initial credential
      const initStore = createCredentialStore({ dataDirectory: dir, mockEncryption })
      await initStore.setCredential('init-1', 'token-init-1')

      // 2. Controlled store with paused initial read
      const { promise: pausePromise, resolve: unpauseRead } = Promise.withResolvers<void>()
      const customFileIO: CredentialStoreFileIO = {
        readFile: async (path: Parameters<typeof readFile>[0]): Promise<Buffer> => {
          await pausePromise
          return readFile(path)
        },
        writeFile,
        rename,
        unlink,
        rm
      }

      const store = createCredentialStore({ dataDirectory: dir, mockEncryption, fileIO: customFileIO })

      // Dispatch concurrent operations while initial read is paused
      const pGet = store.getCredential('init-1')
      const pSetA = store.setCredential('group-A', 'token-A-1')
      const pSetB = store.setCredential('group-B', 'token-B')
      const pOverwriteA = store.setCredential('group-A', 'token-A-2')
      const pDeleteB = store.deleteCredential('group-B')

      // Release paused read
      unpauseRead()

      const valGet = await pGet
      assert.equal(valGet, 'token-init-1', 'Read issued before mutation must see seeded value')

      const resA = await pSetA
      const resB = await pSetB
      const resOverwriteA = await pOverwriteA
      await pDeleteB

      assert.equal(resA, 'stored')
      assert.equal(resB, 'stored')
      assert.equal(resOverwriteA, 'stored')

      // State in memory
      assert.equal(await store.getCredential('group-A'), 'token-A-2')
      assert.equal(await store.getCredential('group-B'), null)
      assert.equal(await store.getCredential('init-1'), 'token-init-1')

      // Clear followed immediately by set C in queue
      const pClear = store.clear()
      const pSetC = store.setCredential('group-C', 'token-C')

      await pClear
      const resC = await pSetC
      assert.equal(resC, 'stored')

      // Reload in fresh instance: must reload to exactly group-C
      const reloadStore = createCredentialStore({ dataDirectory: dir, mockEncryption })
      assert.equal(await reloadStore.getCredential('group-A'), null)
      assert.equal(await reloadStore.getCredential('group-B'), null)
      assert.equal(await reloadStore.getCredential('init-1'), null)
      assert.equal(await reloadStore.getCredential('group-C'), 'token-C')
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('isolates failed rename, cleans up temp file, preserves snapshot, and rejects unavailable selective delete', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cred-fault-'))

    const mockEncryption = {
      isAvailable: () => true,
      encrypt: (text: string) => Buffer.from(text.split('').reverse().join(''), 'utf-8'),
      decrypt: (buf: Buffer) => buf.toString('utf-8').split('').reverse().join('')
    }

    try {
      // 1. Seed valid snapshot
      const seedStore = createCredentialStore({ dataDirectory: dir, mockEncryption })
      await seedStore.setCredential('key-1', 'token-1')

      // 2. Inject failed rename
      let renameFailed = false
      const customFileIO = {
        readFile,
        writeFile,
        rename: async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
          if (!renameFailed) {
            renameFailed = true
            throw new Error('EPERM injected rename failure')
          }
          return rename(from, to)
        },
        unlink,
        rm
      }

      const store = createCredentialStore({ dataDirectory: dir, mockEncryption, fileIO: customFileIO })

      // Mutation must reject on rename failure
      await assert.rejects(
        async () => store.setCredential('key-2', 'token-2'),
        /injected rename failure/
      )

      // Cache remains unchanged
      assert.equal(await store.getCredential('key-1'), 'token-1')
      assert.equal(await store.getCredential('key-2'), null)

      // Temp file was removed
      const dirFiles = await readdir(dir)
      assert.ok(!dirFiles.some((f) => f.endsWith('.tmp')), 'Operation temp file must be cleaned up on failure')

      // Disk snapshot remains intact and readable
      const reloadStore = createCredentialStore({ dataDirectory: dir, mockEncryption })
      assert.equal(await reloadStore.getCredential('key-1'), 'token-1')
      assert.equal(await reloadStore.getCredential('key-2'), null)

      // Subsequent mutation succeeds
      const resLater = await store.setCredential('key-3', 'token-3')
      assert.equal(resLater, 'stored')
      assert.equal(await store.getCredential('key-3'), 'token-3')

      // Verify raw ciphertext never contains test tokens
      const rawDisk = await readFile(join(dir, 'credentials.enc'), 'utf-8')
      assert.equal(rawDisk.includes('token-1'), false)
      assert.equal(rawDisk.includes('token-3'), false)

      // 3. Selective delete when encryption unavailable must reject without deleting disk file
      const disabledEncryption = {
        isAvailable: () => false,
        encrypt: () => {
          throw new Error('Disabled')
        },
        decrypt: () => {
          throw new Error('Disabled')
        }
      }

      const storeDisabled = createCredentialStore({ dataDirectory: dir, mockEncryption: disabledEncryption })
      await assert.rejects(
        async () => storeDisabled.deleteCredential('key-1'),
        /encryption is unavailable/
      )

      // Verify disk file was not erased
      const reVerifyStore = createCredentialStore({ dataDirectory: dir, mockEncryption })
      assert.equal(await reVerifyStore.getCredential('key-1'), 'token-1')
      assert.equal(await reVerifyStore.getCredential('key-3'), 'token-3')

      // With no ciphertext file, memory-only delete succeeds
      const emptyDir = await mkdtemp(join(tmpdir(), 'cred-empty-'))
      try {
        const storeEmpty = createCredentialStore({ dataDirectory: emptyDir, mockEncryption: disabledEncryption })
        await storeEmpty.deleteCredential('some-key')
      } finally {
        await rm(emptyDir, { recursive: true, force: true }).catch(() => {})
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
