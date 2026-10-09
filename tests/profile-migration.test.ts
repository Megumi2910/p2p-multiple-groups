import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  findLegacyProfileDirectory,
  prepareProfileDirectory
} from '../src/main/profile-migration.ts'

describe('Default Profile Directory Migration', () => {
  let tempAppData: string

  beforeEach(async () => {
    tempAppData = await mkdtemp(join(tmpdir(), 'p2p-appdata-test-'))
  })

  afterEach(async () => {
    await rm(tempAppData, { recursive: true, force: true }).catch(() => {})
  })

  it('migrates legacy Kazaa profile, copying peer-state.json and settings.json while preserving originals', async () => {
    const legacyDir = join(tempAppData, 'Kazaa')
    await mkdir(legacyDir, { recursive: true })

    const peerId = randomUUID()
    const stateContent = JSON.stringify({
      version: 1,
      peerId,
      displayName: 'Alice',
      supernodeEligible: true,
      signalingUrl: 'ws://127.0.0.1:8787/signal',
      roomId: 'room-1',
      sharedFiles: []
    })
    const settingsContent = JSON.stringify({ appearance: 'dark' })

    await writeFile(join(legacyDir, 'peer-state.json'), stateContent, 'utf-8')
    await writeFile(join(legacyDir, 'settings.json'), settingsContent, 'utf-8')

    const result = prepareProfileDirectory({ appDataDirectory: tempAppData })

    const targetDir = join(tempAppData, 'p2p-multiple-groups')
    assert.equal(result.dataDirectory, targetDir)
    assert.ok(result.notices.length > 0)
    assert.ok(existsSync(join(targetDir, 'peer-state.json')))
    assert.ok(existsSync(join(targetDir, 'settings.json')))

    // Verify copied contents match
    const migratedState = await readFile(join(targetDir, 'peer-state.json'), 'utf-8')
    assert.equal(migratedState, stateContent)
    const migratedSettings = await readFile(join(targetDir, 'settings.json'), 'utf-8')
    assert.equal(migratedSettings, settingsContent)

    // Verify original legacy files remain untouched
    assert.ok(existsSync(join(legacyDir, 'peer-state.json')))
    assert.ok(existsSync(join(legacyDir, 'settings.json')))
  })

  it('explicitDataDirectory wins and never imports from legacy default directory', async () => {
    const legacyDir = join(tempAppData, 'Kazaa')
    await mkdir(legacyDir, { recursive: true })
    await writeFile(
      join(legacyDir, 'peer-state.json'),
      JSON.stringify({
        version: 1,
        peerId: randomUUID(),
        displayName: 'Bob',
        supernodeEligible: false,
        signalingUrl: '',
        roomId: '',
        sharedFiles: []
      }),
      'utf-8'
    )

    const explicitDir = await mkdtemp(join(tmpdir(), 'explicit-dir-'))
    try {
      const result = prepareProfileDirectory({
        appDataDirectory: tempAppData,
        explicitDataDirectory: explicitDir
      })

      assert.equal(result.dataDirectory, explicitDir)
      assert.equal(result.notices.length, 0)
      // Must not create default target directory
      assert.equal(existsSync(join(tempAppData, 'p2p-multiple-groups')), false)
    } finally {
      await rm(explicitDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('treats existing target peer profile as authoritative without overwriting or merging', async () => {
    const legacyDir = join(tempAppData, 'Kazaa')
    await mkdir(legacyDir, { recursive: true })
    const legacyPeerId = randomUUID()
    await writeFile(
      join(legacyDir, 'peer-state.json'),
      JSON.stringify({
        version: 1,
        peerId: legacyPeerId,
        displayName: 'OldPeer',
        supernodeEligible: true,
        signalingUrl: '',
        roomId: '',
        sharedFiles: []
      }),
      'utf-8'
    )

    const targetDir = join(tempAppData, 'p2p-multiple-groups')
    await mkdir(targetDir, { recursive: true })
    const targetPeerId = randomUUID()
    const targetContent = JSON.stringify({
      version: 2,
      peerId: targetPeerId,
      displayName: 'NewPeer',
      relayOnly: false,
      groups: [],
      sharedFiles: []
    })
    await writeFile(join(targetDir, 'peer-state.json'), targetContent, 'utf-8')

    const result = prepareProfileDirectory({ appDataDirectory: tempAppData })
    assert.equal(result.dataDirectory, targetDir)
    assert.ok(result.notices.some((n) => n.includes('Existing p2p-multiple-groups profile found')))

    const currentTargetContent = await readFile(join(targetDir, 'peer-state.json'), 'utf-8')
    assert.equal(currentTargetContent, targetContent) // untouched!
  })

  it('refuses automatic migration when target directory contains files but no peer profile', async () => {
    const legacyDir = join(tempAppData, 'Kazaa')
    await mkdir(legacyDir, { recursive: true })
    await writeFile(
      join(legacyDir, 'peer-state.json'),
      JSON.stringify({
        version: 1,
        peerId: randomUUID(),
        displayName: 'Alice',
        supernodeEligible: true,
        signalingUrl: '',
        roomId: '',
        sharedFiles: []
      }),
      'utf-8'
    )

    const targetDir = join(tempAppData, 'p2p-multiple-groups')
    await mkdir(targetDir, { recursive: true })
    // Only settings.json in target, no peer-state.json
    await writeFile(join(targetDir, 'settings.json'), '{"theme":"dark"}', 'utf-8')

    assert.throws(
      () => prepareProfileDirectory({ appDataDirectory: tempAppData }),
      (err: Error) => err.message.includes('contains files but no peer profile')
    )
  })

  it('safely handles empty target directory before migration', async () => {
    const legacyDir = join(tempAppData, 'Kazaa')
    await mkdir(legacyDir, { recursive: true })
    const peerId = randomUUID()
    await writeFile(
      join(legacyDir, 'peer-state.json'),
      JSON.stringify({
        version: 1,
        peerId,
        displayName: 'Alice',
        supernodeEligible: true,
        signalingUrl: '',
        roomId: '',
        sharedFiles: []
      }),
      'utf-8'
    )

    // Pre-create empty target directory
    const targetDir = join(tempAppData, 'p2p-multiple-groups')
    await mkdir(targetDir, { recursive: true })

    const result = prepareProfileDirectory({ appDataDirectory: tempAppData })
    assert.equal(result.dataDirectory, targetDir)
    assert.ok(existsSync(join(targetDir, 'peer-state.json')))
  })

  it('refuses migration when legacy profile contains corrupt JSON', async () => {
    const legacyDir = join(tempAppData, 'Kazaa')
    await mkdir(legacyDir, { recursive: true })
    await writeFile(join(legacyDir, 'peer-state.json'), 'not-json', 'utf-8')

    assert.throws(
      () => prepareProfileDirectory({ appDataDirectory: tempAppData }),
      (err: Error) => err.message.includes('malformed JSON')
    )
  })

  it('cleans up stale staging artifacts from prior incomplete runs', async () => {
    const stagingDir = join(tempAppData, '.staging-migration-crash-123')
    await mkdir(stagingDir, { recursive: true })
    await writeFile(join(stagingDir, 'temp.txt'), 'hello', 'utf-8')

    prepareProfileDirectory({ appDataDirectory: tempAppData })

    assert.equal(existsSync(stagingDir), false)
  })
})
