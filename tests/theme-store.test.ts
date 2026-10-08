import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createThemeStore } from '../src/main/theme-store.ts'
import type { ThemePreference } from '../src/shared/contracts.ts'

describe('ThemeStore', () => {
  let tempDir: string
  let settingsFile: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kazaa-theme-test-'))
    settingsFile = join(tempDir, 'settings.json')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('reads a saved preference in a newly created store, rejects invalid input without altering preference', async () => {
    const store1 = await createThemeStore(settingsFile)
    assert.equal(store1.get(), 'system')

    const saved = await store1.set('dark')
    assert.equal(saved, 'dark')
    assert.equal(store1.get(), 'dark')

    const store2 = await createThemeStore(settingsFile)
    assert.equal(store2.get(), 'dark')

    // Invalid input rejection
    await assert.rejects(
      async () => {
        // @ts-expect-error testing runtime boundary rejection
        await store2.set('invalid-theme')
      },
      {
        name: 'TypeError',
        message: 'Invalid theme preference'
      }
    )

    // Verify in-memory preference remains unchanged
    assert.equal(store2.get(), 'dark')

    // Verify disk content remains unchanged
    const diskContent = JSON.parse(await readFile(settingsFile, 'utf-8'))
    assert.deepEqual(diskContent, { theme: 'dark' })

    // Verify newly created store still reads last saved preference
    const store3 = await createThemeStore(settingsFile)
    assert.equal(store3.get(), 'dark')
  })

  it('recovers to system when JSON is corrupt without rewriting the file on load, and persists later choice', async () => {
    const corruptPayload = '{"theme": "corrupted json without closing brace'
    await writeFile(settingsFile, corruptPayload, 'utf-8')

    const store1 = await createThemeStore(settingsFile)
    assert.equal(store1.get(), 'system')

    // Verify the corrupt file was NOT rewritten on store creation
    const onDiskRaw = await readFile(settingsFile, 'utf-8')
    assert.equal(onDiskRaw, corruptPayload)

    // Explicit choice now persists
    const result = await store1.set('light')
    assert.equal(result, 'light')
    assert.equal(store1.get(), 'light')

    const diskContent = JSON.parse(await readFile(settingsFile, 'utf-8'))
    assert.deepEqual(diskContent, { theme: 'light' })

    const store2 = await createThemeStore(settingsFile)
    assert.equal(store2.get(), 'light')
  })

  it('serializes concurrent accepted writes and the last requested value survives a new store instance', async () => {
    const store = await createThemeStore(settingsFile)

    const values: ThemePreference[] = ['dark', 'light', 'dark', 'system']
    const writes = values.map((val) => store.set(val))
    const results = await Promise.all(writes)

    assert.deepEqual(results, values)
    assert.equal(store.get(), 'system')

    const storeAfter = await createThemeStore(settingsFile)
    assert.equal(storeAfter.get(), 'system')

    const diskContent = JSON.parse(await readFile(settingsFile, 'utf-8'))
    assert.deepEqual(diskContent, { theme: 'system' })
  })

  it('rejects write on filesystem obstruction without changing previous state, and subsequent writes succeed', async () => {
    const store = await createThemeStore(settingsFile)
    await store.set('light')
    assert.equal(store.get(), 'light')

    const savedPayloadBefore = await readFile(settingsFile, 'utf-8')

    // Portable deterministic obstruction: move settings file aside, put a directory at destination
    const backupFile = `${settingsFile}.bak`
    await rename(settingsFile, backupFile)
    await mkdir(settingsFile)
    try {
      await assert.rejects(
        async () => {
          await store.set('dark')
        },
        (err: Error) => {
          return err !== null
        }
      )

      // Verify in-memory preference remains 'light'
      assert.equal(store.get(), 'light')

      // Verify saved backup bytes unchanged
      const savedBackup = await readFile(backupFile, 'utf-8')
      assert.equal(savedBackup, savedPayloadBefore)
    } finally {
      // Remove obstruction and restore file
      await rm(settingsFile, { recursive: true, force: true })
      await rename(backupFile, settingsFile)
    }

    // Prove that a subsequent write succeeds and queue was not poisoned
    const laterResult = await store.set('dark')
    assert.equal(laterResult, 'dark')
    assert.equal(store.get(), 'dark')

    const newStore = await createThemeStore(settingsFile)
    assert.equal(newStore.get(), 'dark')
  })
})
