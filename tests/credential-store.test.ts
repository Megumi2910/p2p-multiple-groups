import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCredentialStore } from '../src/main/p2p/credential-store.ts'

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
      await store1.setCredential('group-1', 'token-secret-1')
      await store1.setCredential('group-2', 'token-secret-2')

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
      encrypt: () => { throw new Error('Unused') },
      decrypt: () => { throw new Error('Unused') }
    }

    try {
      const store = createCredentialStore({ dataDirectory: dir, mockEncryption: mockDisabled })
      await store.setCredential('mem-group', 'mem-token')
      assert.equal(await store.getCredential('mem-group'), 'mem-token')

      // Must not write encrypted file to disk when encryption is unsupported
      await assert.rejects(async () => stat(join(dir, 'credentials.enc')), (err: NodeJS.ErrnoException) => err.code === 'ENOENT')
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
      decrypt: () => { throw new Error('Invalid padding or signature') }
    }

    try {
      const store = createCredentialStore({ dataDirectory: dir, mockEncryption })
      // Reading corrupt file should not crash; returns null and operates gracefully
      const val = await store.getCredential('some-key')
      assert.equal(val, null)

      // Writing new credential recovers the store
      mockEncryption.decrypt = (buf: Buffer) => buf.toString('utf-8')
      await store.setCredential('recovered-key', 'recovered-token')
      assert.equal(await store.getCredential('recovered-key'), 'recovered-token')
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
