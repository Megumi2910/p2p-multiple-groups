import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  createMultiGroupPeerStore,
  migratePeerStateV1,
  validatePersistedStateV2,
  type PersistedGroupV2,
  type PersistedPeerStateV2
} from '../src/main/p2p/peer-store.ts'
import { makeGroupKey } from '../src/shared/p2p.ts'

describe('PeerStore V2 Schema & Migration', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'p2p-store-v2-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('migrates valid v1 profile to v2, creating a group and granting existing files', () => {
    const peerId = randomUUID()
    const fileId = randomUUID()
    const v1Data = {
      version: 1,
      peerId,
      displayName: 'Alice',
      supernodeEligible: true,
      signalingUrl: 'ws://127.0.0.1:8787/signal',
      roomId: 'room-alpha',
      sharedFiles: [{ fileId, path: '/shared/song.mp3' }]
    }

    const { state, notices } = migratePeerStateV1(v1Data, '/path/to/peer-state.json')
    assert.equal(state.version, 2)
    assert.equal(state.peerId, peerId)
    assert.equal(state.displayName, 'Alice')
    assert.equal(state.relayOnly, false)
    assert.equal(state.groups.length, 1)

    const expectedGroupKey = makeGroupKey('ws://127.0.0.1:8787/signal', 'room-alpha')
    assert.equal(state.groups[0].groupKey, expectedGroupKey)
    assert.equal(state.groups[0].signalingUrl, 'ws://127.0.0.1:8787/signal')
    assert.equal(state.groups[0].groupId, 'room-alpha')
    assert.equal(state.groups[0].supernodeEligible, true)
    assert.equal(state.groups[0].autoJoin, false)
    assert.equal(state.groups[0].credentialCiphertext, null)

    assert.equal(state.sharedFiles.length, 1)
    assert.equal(state.sharedFiles[0].fileId, fileId)
    assert.deepEqual(state.sharedFiles[0].groupKeys, [expectedGroupKey])
    assert.equal(notices.length, 0)
  })

  it('migrates v1 profile with empty connection params without creating groups', () => {
    const peerId = randomUUID()
    const fileId = randomUUID()
    const v1Data = {
      version: 1,
      peerId,
      displayName: 'Bob',
      supernodeEligible: false,
      signalingUrl: '',
      roomId: '',
      sharedFiles: [{ fileId, path: '/shared/doc.pdf' }]
    }

    const { state, notices } = migratePeerStateV1(v1Data, '/path/to/peer-state.json')
    assert.equal(state.version, 2)
    assert.equal(state.groups.length, 0)
    assert.equal(state.sharedFiles.length, 1)
    assert.deepEqual(state.sharedFiles[0].groupKeys, [])
    assert.ok(notices.length > 0)
  })

  it('validates v2 schema, rejecting invalid groupKey or duplicate entries', () => {
    const peerId = randomUUID()
    const validGroupKey = makeGroupKey('ws://127.0.0.1:8787/signal', 'grp-1')
    const validV2: PersistedPeerStateV2 = {
      version: 2,
      peerId,
      displayName: 'Charlie',
      relayOnly: false,
      groups: [
        {
          groupKey: validGroupKey,
          signalingUrl: 'ws://127.0.0.1:8787/signal',
          groupId: 'grp-1',
          supernodeEligible: true,
          autoJoin: false,
          credentialCiphertext: null
        }
      ],
      sharedFiles: [
        {
          fileId: randomUUID(),
          path: '/path/file.txt',
          groupKeys: [validGroupKey]
        }
      ]
    }

    assert.ok(validatePersistedStateV2(validV2, 'test.json'))

    // Mismatched group key rejected
    assert.throws(() => {
      validatePersistedStateV2(
        {
          ...validV2,
          groups: [{ ...validV2.groups[0], groupKey: 'mismatched-key' }]
        },
        'test.json'
      )
    })

    // Duplicate shared file paths rejected
    assert.throws(() => {
      validatePersistedStateV2(
        {
          ...validV2,
          sharedFiles: [
            validV2.sharedFiles[0],
            { fileId: randomUUID(), path: validV2.sharedFiles[0].path, groupKeys: [] }
          ]
        },
        'test.json'
      )
    })
  })

  it('performs on-disk upgrade with exclusive v1 backup creation', async () => {
    const peerId = randomUUID()
    const stateFile = join(tempDir, 'peer-state.json')
    const backupFile = join(tempDir, 'peer-state.v1.backup.json')

    const v1Raw = JSON.stringify(
      {
        version: 1,
        peerId,
        displayName: 'Dave',
        supernodeEligible: true,
        signalingUrl: 'ws://127.0.0.1:8787/signal',
        roomId: 'room-dave',
        sharedFiles: [{ fileId: randomUUID(), path: '/dave/file.bin' }]
      },
      null,
      2
    )

    await writeFile(stateFile, v1Raw, 'utf-8')

    // Open store: should migrate to v2 and create backup
    const store = await createMultiGroupPeerStore(tempDir)
    const current = store.get()
    assert.equal(current.version, 2)
    assert.equal(current.peerId, peerId)
    assert.equal(current.displayName, 'Dave')
    assert.equal(current.groups.length, 1)

    // Verify backup exists and matches original v1 raw bytes
    const backupContent = await readFile(backupFile, 'utf-8')
    assert.equal(backupContent, v1Raw)

    // Re-opening store is idempotent and does not error on existing identical backup
    const storeReopened = await createMultiGroupPeerStore(tempDir)
    assert.equal(storeReopened.get().peerId, peerId)
  })

  it('rejects upgrade when a conflicting backup file with different content exists', async () => {
    const peerId = randomUUID()
    const stateFile = join(tempDir, 'peer-state.json')
    const backupFile = join(tempDir, 'peer-state.v1.backup.json')

    const v1Raw = JSON.stringify({
      version: 1,
      peerId,
      displayName: 'Eve',
      supernodeEligible: true,
      signalingUrl: 'ws://127.0.0.1:8787/signal',
      roomId: 'room-eve',
      sharedFiles: []
    })

    await writeFile(stateFile, v1Raw, 'utf-8')
    // Pre-create conflicting backup
    await writeFile(backupFile, '{"different":"backup"}', 'utf-8')

    await assert.rejects(
      async () => createMultiGroupPeerStore(tempDir),
      (err: Error) => err.message.includes('Conflicting backup exists')
    )
  })

  it('creates a fresh v2 identity if peer-state.json is missing', async () => {
    const store = await createMultiGroupPeerStore(tempDir)
    const state = store.get()
    assert.equal(state.version, 2)
    assert.ok(state.peerId)
    assert.ok(state.displayName.startsWith('Peer-'))
    assert.equal(state.groups.length, 0)
    assert.equal(state.sharedFiles.length, 0)

    const onDisk = JSON.parse(await readFile(join(tempDir, 'peer-state.json'), 'utf-8'))
    assert.equal(onDisk.version, 2)
    assert.equal(onDisk.peerId, state.peerId)
  })

  it('serializes concurrent two-group writes and survives restart', async () => {
    const store = await createMultiGroupPeerStore(tempDir)
    const key1 = makeGroupKey('ws://127.0.0.1:8787/signal', 'grp-1')
    const key2 = makeGroupKey('ws://127.0.0.1:8787/signal', 'grp-2')

    const group1: PersistedGroupV2 = {
      groupKey: key1,
      signalingUrl: 'ws://127.0.0.1:8787/signal',
      groupId: 'grp-1',
      supernodeEligible: true,
      autoJoin: true,
      credentialCiphertext: 'enc1'
    }
    const group2: PersistedGroupV2 = {
      groupKey: key2,
      signalingUrl: 'ws://127.0.0.1:8787/signal',
      groupId: 'grp-2',
      supernodeEligible: false,
      autoJoin: false,
      credentialCiphertext: 'enc2'
    }

    // Concurrent writes
    await Promise.all([
      store.upsertGroup(group1),
      store.upsertGroup(group2),
      store.setRelayOnly(true),
      store.setDisplayName('RenamedUser')
    ])

    const updated = store.get()
    assert.equal(updated.displayName, 'RenamedUser')
    assert.equal(updated.relayOnly, true)
    assert.equal(updated.groups.length, 2)

    // Reload from disk
    const reloaded = await createMultiGroupPeerStore(tempDir)
    const reloadedState = reloaded.get()
    assert.equal(reloadedState.displayName, 'RenamedUser')
    assert.equal(reloadedState.relayOnly, true)
    assert.equal(reloadedState.groups.length, 2)
    assert.ok(reloadedState.groups.some((g) => g.groupKey === key1 && g.autoJoin === true))
    assert.ok(reloadedState.groups.some((g) => g.groupKey === key2 && g.credentialCiphertext === 'enc2'))
  })

  it('removes group and atomically revokes that group from all shared files', async () => {
    const store = await createMultiGroupPeerStore(tempDir)
    const keyA = makeGroupKey('ws://127.0.0.1:8787/signal', 'grp-A')
    const keyB = makeGroupKey('ws://127.0.0.1:8787/signal', 'grp-B')

    await store.upsertGroup({
      groupKey: keyA,
      signalingUrl: 'ws://127.0.0.1:8787/signal',
      groupId: 'grp-A',
      supernodeEligible: true,
      autoJoin: false,
      credentialCiphertext: null
    })
    await store.upsertGroup({
      groupKey: keyB,
      signalingUrl: 'ws://127.0.0.1:8787/signal',
      groupId: 'grp-B',
      supernodeEligible: false,
      autoJoin: false,
      credentialCiphertext: null
    })

    const fileId = randomUUID()
    await store.addSharedFile({
      fileId,
      path: '/shared/dual.txt',
      groupKeys: [keyA, keyB]
    })

    const before = store.get()
    assert.deepEqual(before.sharedFiles[0].groupKeys, [keyA, keyB])

    // Remove group A (forget group)
    await store.removeGroup(keyA)

    const after = store.get()
    assert.equal(after.groups.length, 1)
    assert.equal(after.groups[0].groupKey, keyB)
    assert.deepEqual(after.sharedFiles[0].groupKeys, [keyB]) // keyA removed atomically!
  })
})
