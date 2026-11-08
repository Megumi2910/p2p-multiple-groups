import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  prepareProfileDirectory,
  prepareProfileDirectoryWithLock,
  getCoordinationLockDirectory
} from '../src/main/profile-migration.ts'

describe('Profile Directory & Singleton Lock Coordination', () => {
  let tempAppData: string

  beforeEach(async () => {
    tempAppData = await mkdtemp(join(tmpdir(), 'p2p-appdata-test-'))
  })

  afterEach(async () => {
    await rm(tempAppData, { recursive: true, force: true }).catch(() => {})
  })

  it('creates the canonical p2p-multiple-groups directory when no profile exists', async () => {
    const result = prepareProfileDirectory({ appDataDirectory: tempAppData })
    const targetDir = join(tempAppData, 'p2p-multiple-groups')
    assert.equal(result.dataDirectory, targetDir)
    assert.equal(existsSync(targetDir), true)
  })

  it('explicitDataDirectory wins and creates target directory', async () => {
    const customDir = join(tempAppData, 'custom-data-dir')
    const result = prepareProfileDirectory({
      appDataDirectory: tempAppData,
      explicitDataDirectory: customDir
    })
    assert.equal(result.dataDirectory, customDir)
    assert.equal(existsSync(customDir), true)
  })

  it('validates existing v2 profile and throws on corrupt JSON', async () => {
    const targetDir = join(tempAppData, 'p2p-multiple-groups')
    await mkdir(targetDir, { recursive: true })
    await writeFile(join(targetDir, 'peer-state.json'), 'not valid json', 'utf-8')

    assert.throws(
      () => prepareProfileDirectory({ appDataDirectory: tempAppData }),
      (err: Error) => err.message.includes('malformed JSON')
    )
  })

  it('validates existing v2 profile and succeeds on valid v2 peer-state.json', async () => {
    const targetDir = join(tempAppData, 'p2p-multiple-groups')
    await mkdir(targetDir, { recursive: true })
    const validV2 = {
      version: 2,
      peerId: randomUUID(),
      displayName: 'Alice',
      relayOnly: false,
      groups: [],
      sharedFiles: []
    }
    await writeFile(join(targetDir, 'peer-state.json'), JSON.stringify(validV2), 'utf-8')

    const result = prepareProfileDirectory({ appDataDirectory: tempAppData })
    assert.equal(result.dataDirectory, targetDir)
  })

  it('cleans up stale staging artifacts from prior incomplete runs', async () => {
    const stagingDir = join(tempAppData, '.staging-migration-crash-123')
    await mkdir(stagingDir, { recursive: true })
    await writeFile(join(stagingDir, 'temp.txt'), 'hello', 'utf-8')

    prepareProfileDirectory({ appDataDirectory: tempAppData })
    assert.equal(existsSync(stagingDir), false)
  })

  it('prepareProfileDirectoryWithLock returns null without mutating target when lock is denied', async () => {
    let acquiredCallbackCalled = false
    let passedLockDirectory = ''

    const result = prepareProfileDirectoryWithLock(
      { appDataDirectory: tempAppData },
      (lockDir) => {
        acquiredCallbackCalled = true
        passedLockDirectory = lockDir
        return false // Deny lock
      }
    )

    assert.equal(acquiredCallbackCalled, true)
    assert.equal(result, null)

    const targetDir = join(tempAppData, 'p2p-multiple-groups')
    assert.equal(existsSync(targetDir), false, 'Target directory must not be created when lock is denied')
    assert.ok(passedLockDirectory)
    assert.equal(existsSync(passedLockDirectory), true, 'Lock coordination directory must exist')
  })

  it('prepareProfileDirectoryWithLock performs preparation when lock acquisition succeeds', async () => {
    const result = prepareProfileDirectoryWithLock(
      { appDataDirectory: tempAppData },
      () => true
    )

    assert.ok(result)
    const targetDir = join(tempAppData, 'p2p-multiple-groups')
    assert.equal(result.dataDirectory, targetDir)
    assert.equal(existsSync(targetDir), true)
  })

  it('derives identical lock coordination directory for canonical path aliases and distinct directories for distinct targets', async () => {
    const defaultTarget = join(tempAppData, 'p2p-multiple-groups')
    const aliasTarget = join(tempAppData, '.', 'p2p-multiple-groups')

    const lock1 = getCoordinationLockDirectory(tempAppData, defaultTarget)
    const lockAlias = getCoordinationLockDirectory(tempAppData, aliasTarget)
    assert.equal(lock1, lockAlias, 'Aliases to the same target profile must resolve to identical coordination lock directory')

    const explicitTargetA = join(tempAppData, 'custom-profile-A')
    const explicitTargetB = join(tempAppData, 'custom-profile-B')
    const lockA = getCoordinationLockDirectory(tempAppData, explicitTargetA)
    const lockB = getCoordinationLockDirectory(tempAppData, explicitTargetB)

    assert.notEqual(lockA, lockB, 'Different targets must resolve to distinct coordination lock directories')
    assert.notEqual(lock1, lockA, 'Default target and custom target must resolve to distinct lock directories')
  })
})
