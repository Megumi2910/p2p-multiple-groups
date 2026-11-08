import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  parseGroupInvitation,
  validateDisplayName,
  validateGroupId,
  validateInviteCode,
  validateSignalingUrl,
  validateToken,
  validateCreateGroupOptions,
  validateJoinGroupOptions,
  makeGroupKey,
  parseGroupKey,
  type CreateGroupOptions,
  type JoinGroupOptions
} from '../src/shared/p2p.ts'
import {
  isValidFileMetadata,
  isUuid,
  isSha256,
  isClientSignalingMessageV2,
  isServerSignalingMessageV2,
  isPeerHelloMessage,
  isOverlayControlMessageV2,
  isTransferControlMessageV2,
  makeFileChannelLabelV2,
  parseFileChannelLabelV2
} from '../src/shared/p2p-wire.ts'
import { createMultiGroupPeerStore, type MultiGroupPeerStore } from '../src/main/p2p/peer-store.ts'
import { TransportManager } from '../src/main/p2p/transport.ts'
import type { RTCDataChannel } from 'werift'

describe('P2P Protocol & Shared Contracts', () => {
  it('validates UUIDs and SHA256 hashes correctly', () => {
    assert.equal(isUuid(randomUUID()), true)
    assert.equal(isUuid('not-a-uuid'), false)
    assert.equal(isSha256('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'), true)
    assert.equal(isSha256('E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855'), false)
    assert.equal(isSha256('short'), false)
  })

  it('validates signaling URLs with loopback ws and internet wss', () => {
    assert.equal(validateSignalingUrl('ws://127.0.0.1:8787/signal').valid, true)
    assert.equal(validateSignalingUrl('ws://[::1]:8787/signal').valid, true)
    assert.equal(validateSignalingUrl('ws://example.com/signal').valid, false) // ws on non-loopback rejected
    assert.equal(validateSignalingUrl('wss://example.com/signal').valid, true)
    assert.equal(validateSignalingUrl('wss://example.com/wrong').valid, false)
    assert.equal(validateSignalingUrl('wss://user:pass@example.com/signal').valid, false)
    assert.equal(validateSignalingUrl('wss://example.com/signal?param=1').valid, false)
  })

  it('validates group IDs, invite codes, and display names', () => {
    assert.equal(validateGroupId('group-123_abc').valid, true)
    assert.equal(validateGroupId('invalid group spaces').valid, false)
    assert.equal(validateGroupId('').valid, false)

    assert.equal(validateInviteCode('short-code-1234').valid, true)
    assert.equal(validateInviteCode('A'.repeat(22)).valid, true)
    assert.equal(validateInviteCode('B'.repeat(43)).valid, true)
    assert.equal(validateInviteCode('bad code spaces').valid, false)
    assert.equal(validateInviteCode('short').valid, false) // < 8 chars

    const token32 = Buffer.alloc(32, 7).toString('base64url')
    assert.equal(validateToken(token32).valid, true)
    assert.equal(validateToken('too-short').valid, false)

    assert.equal(validateDisplayName('Alice').valid, true)
    assert.equal(validateDisplayName('  Alice  ').valid, true)
    assert.equal(validateDisplayName('').valid, false)
    assert.equal(validateDisplayName('Name\x00WithNull').valid, false)
  })

  it('enforces file metadata boundary rules', () => {
    const validMeta = {
      fileId: randomUUID(),
      name: 'test.txt',
      size: 1024,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    }
    assert.equal(isValidFileMetadata(validMeta), true)
    assert.equal(isValidFileMetadata({ ...validMeta, name: '../escaped' }), false)
    assert.equal(isValidFileMetadata({ ...validMeta, name: 'sub/dir' }), false)
    assert.equal(isValidFileMetadata({ ...validMeta, name: '.' }), false)
    assert.equal(isValidFileMetadata({ ...validMeta, size: -1 }), false)
    assert.equal(isValidFileMetadata({ ...validMeta, size: 2 * 1024 * 1024 * 1024 }), false) // > 1 GiB
  })

  it('parses v2 group invitations and short invite codes', () => {
    const token = Buffer.alloc(32, 12).toString('base64url')
    const v2Raw = JSON.stringify({
      version: 2,
      signalingUrl: 'ws://127.0.0.1:8787/signal',
      groupId: 'alpha-group',
      token
    })
    const parsedV2 = parseGroupInvitation(v2Raw)
    assert.ok(parsedV2)
    assert.equal(parsedV2?.version, 2)
    assert.equal(parsedV2?.groupId, 'alpha-group')

    // Short invite code parsed with fallback signaling URL
    const shortCode = 'my-invite-code-1234'
    const parsedShort = parseGroupInvitation(shortCode, 'ws://127.0.0.1:8787/signal')
    assert.ok(parsedShort)
    assert.equal(parsedShort?.version, 2)
    assert.equal(parsedShort?.groupId, '')
    assert.equal(parsedShort?.token, shortCode)
    assert.equal(parsedShort?.signalingUrl, 'ws://127.0.0.1:8787/signal')

    // Invalid versions or payloads rejected
    assert.equal(parseGroupInvitation(JSON.stringify({ version: 1 })), null)
    assert.equal(parseGroupInvitation(JSON.stringify({ version: 99 })), null)
    assert.equal(parseGroupInvitation('short', 'ws://127.0.0.1:8787/signal'), null)
  })

  it('validates create group options and join group options', () => {
    const validCreate: CreateGroupOptions = {
      groupId: 'club-alpha',
      displayName: 'Alice',
      supernodeEligible: true,
      autoJoin: true,
      rememberInvitation: true
    }
    assert.equal(validateCreateGroupOptions(validCreate, 'ws://127.0.0.1:8787/signal').valid, true)
    assert.equal(validateCreateGroupOptions({ ...validCreate, groupId: '' }, 'ws://127.0.0.1:8787/signal').valid, false)

    const token = Buffer.alloc(32, 15).toString('base64url')
    const validJoinWithOptions: JoinGroupOptions = {
      invitation: {
        version: 2,
        signalingUrl: 'ws://127.0.0.1:8787/signal',
        groupId: 'test-group',
        token
      },
      displayName: 'Bob',
      supernodeEligible: true,
      relayOnly: false,
      rememberInvitation: false
    }

    assert.equal(validateJoinGroupOptions(validJoinWithOptions).valid, true)
    assert.equal(validateJoinGroupOptions({ ...validJoinWithOptions, displayName: '' }).valid, false)

    // Code-only join
    const validJoinCode: JoinGroupOptions = {
      inviteCode: 'code-12345678',
      displayName: 'Charlie',
      supernodeEligible: false
    }
    const validatedCode = validateJoinGroupOptions(validJoinCode, 'ws://127.0.0.1:8787/signal')
    assert.equal(validatedCode.valid, true)
    if (validatedCode.valid) {
      assert.equal(validatedCode.value.invitation.groupId, '')
      assert.equal(validatedCode.value.invitation.token, 'code-12345678')
    }

    const key = makeGroupKey('ws://127.0.0.1:8787/signal', 'test-group')
    const parsedKey = parseGroupKey(key)
    assert.deepEqual(parsedKey, { signalingUrl: 'ws://127.0.0.1:8787/signal', groupId: 'test-group' })
    assert.equal(parseGroupKey('invalid-key'), null)
  })

  it('validates v2 wire protocol messages, owner frames, and scoped channel labels', () => {
    const peerId = randomUUID()
    const sessionId = randomUUID()
    const membershipId = randomUUID()
    const connectionId = randomUUID()
    const epoch = randomUUID()

    // Client V2 create-group
    assert.equal(
      isClientSignalingMessageV2({
        v: 2,
        type: 'create-group',
        groupId: 'alpha',
        ownerSecret: 'owner-secret-1234',
        supernodeEligible: true
      }),
      true
    )

    // Client V2 rotate-invite
    assert.equal(
      isClientSignalingMessageV2({
        v: 2,
        type: 'rotate-invite',
        groupId: 'alpha',
        ownerSecret: 'owner-secret-1234'
      }),
      true
    )

    // Client V2 remove-member
    assert.equal(
      isClientSignalingMessageV2({
        v: 2,
        type: 'remove-member',
        groupId: 'alpha',
        targetPeerId: peerId,
        ownerSecret: 'owner-secret-1234'
      }),
      true
    )

    // Server V2 invite-rotated and group-kicked
    assert.equal(
      isServerSignalingMessageV2({
        v: 2,
        type: 'invite-rotated',
        groupId: 'alpha',
        inviteCode: 'new-invite-code-22'
      }),
      true
    )

    assert.equal(
      isServerSignalingMessageV2({
        v: 2,
        type: 'group-kicked',
        groupId: 'alpha',
        reason: 'Removed by group owner'
      }),
      true
    )

    // Physical hello
    assert.equal(
      isPeerHelloMessage({
        v: 2,
        type: 'hello',
        peerId,
        sessionId,
        connectionId
      }),
      true
    )

    // Overlay control V2 scoped to group
    assert.equal(
      isOverlayControlMessageV2({
        v: 2,
        type: 'ping',
        groupId: 'grp1',
        epoch,
        revision: 1,
        senderMembershipId: membershipId
      }),
      true
    )

    // Scoped channel labels
    const label = makeFileChannelLabelV2('grp1', connectionId)
    assert.equal(label, `p2p-multiple-groups-file-v2:grp1:${connectionId}`)
    assert.deepEqual(parseFileChannelLabelV2(label), { groupId: 'grp1', transferId: connectionId })
    assert.equal(parseFileChannelLabelV2('invalid-label'), null)
  })
})

describe('MultiGroupPeerStore Persistence', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'p2p-test-store-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('creates a fresh v2 identity when peer-state.json is missing', async () => {
    const store = await createMultiGroupPeerStore(tempDir)
    const state = store.get()
    assert.equal(state.version, 2)
    assert.ok(isUuid(state.peerId))
    assert.ok(state.displayName.startsWith('Peer-'))
    assert.equal(state.relayOnly, false)
    assert.deepEqual(state.groups, [])
    assert.deepEqual(state.sharedFiles, [])
  })

  it('persists and reloads v2 group mutations durably', async () => {
    const store1 = await createMultiGroupPeerStore(tempDir)
    await store1.setDisplayName('CustomPeer')
    await store1.setRelayOnly(true)
    const groupKey = makeGroupKey('ws://127.0.0.1:8787/signal', 'alpha-group')
    await store1.upsertGroup({
      groupKey,
      signalingUrl: 'ws://127.0.0.1:8787/signal',
      groupId: 'alpha-group',
      supernodeEligible: false,
      autoJoin: true,
      credentialCiphertext: null
    })
    const fileId = randomUUID()
    await store1.addSharedFile({ fileId, path: 'C:\\test\\file.txt', groupKeys: [groupKey] })

    const store2 = await createMultiGroupPeerStore(tempDir)
    const state2 = store2.get()
    assert.equal(state2.displayName, 'CustomPeer')
    assert.equal(state2.relayOnly, true)
    assert.equal(state2.groups.length, 1)
    assert.equal(state2.groups[0].groupId, 'alpha-group')
    assert.equal(state2.groups[0].autoJoin, true)
    assert.equal(state2.sharedFiles.length, 1)
    assert.deepEqual(state2.sharedFiles[0].groupKeys, [groupKey])
  })

  it('throws actionable error on corrupt state file and never overwrites it', async () => {
    const statePath = join(tempDir, 'peer-state.json')
    await writeFile(statePath, '{ "corrupted": true, broken JSON ...', 'utf-8')

    await assert.rejects(
      async () => {
        await createMultiGroupPeerStore(tempDir)
      },
      (err: Error) => {
        assert.ok(err.message.includes('Corrupt peer profile'))
        return true
      }
    )
  })
})

describe('TransportManager Loopback Peer Connection', () => {
  it('connects two local peers, completes hello handshake and opens scoped file channel', async () => {
    const epoch = randomUUID()
    const peerAId = '00000000-0000-4000-8000-000000000001'
    const peerBId = '00000000-0000-4000-8000-000000000002'
    const sessionAId = randomUUID()
    const sessionBId = randomUUID()
    const memAId = randomUUID()
    const memBId = randomUUID()

    const { promise: openA, resolve: resolveOpenA } = Promise.withResolvers<void>()
    const { promise: openB, resolve: resolveOpenB } = Promise.withResolvers<void>()

    const transferId = randomUUID()
    const { promise: fileChannelReceived, resolve: resolveFileChannelReceived, reject: rejectFileChannelReceived } = Promise.withResolvers<void>()

    let tmA!: TransportManager
    let tmB!: TransportManager

    tmA = new TransportManager({
      onControlMessage: () => {},
      onFileChannel: () => {},
      onLinkStateChange: (_peerId, state) => {
        if (state === 'open') resolveOpenA()
      },
      onSendSignal: (sig) => {
        void tmB.handleSignal(sig.groupId || 'test-group', sig.targetPeerId === peerBId ? peerAId : peerBId, sessionAId, sig.connectionId, sig.kind, sig.payload)
      }
    })

    tmB = new TransportManager({
      onControlMessage: () => {},
      onFileChannel: (groupId, _peerId, _sessId, tId, channel: RTCDataChannel) => {
        if (tId === transferId) {
          assert.equal(groupId, 'test-group')
          channel.onmessage = (msg: { data: unknown }) => {
            try {
              const raw = msg.data
              const str = Buffer.isBuffer(raw)
                ? raw.toString('utf-8')
                : typeof raw === 'string'
                  ? raw
                  : Buffer.from(raw as ArrayBuffer).toString('utf-8')
              assert.equal(str, 'chunk-1')
              resolveFileChannelReceived()
            } catch (err) {
              rejectFileChannelReceived(err instanceof Error ? err : new Error(String(err)))
            }
          }
        }
      },
      onLinkStateChange: (_peerId, state) => {
        if (state === 'open') resolveOpenB()
      },
      onSendSignal: (sig) => {
        void tmA.handleSignal(sig.groupId || 'test-group', sig.targetPeerId === peerAId ? peerBId : peerAId, sessionBId, sig.connectionId, sig.kind, sig.payload)
      }
    })

    const emptyIce = { expiresAt: Date.now() + 3600000, servers: [] }
    tmA.setPeerContext(peerAId, sessionAId, emptyIce, false)
    tmB.setPeerContext(peerBId, sessionBId, emptyIce, false)

    const roster = [
      { peerId: peerAId, sessionId: sessionAId, membershipId: memAId, joinOrder: 1, displayName: 'PeerA', supernodeEligible: true },
      { peerId: peerBId, sessionId: sessionBId, membershipId: memBId, joinOrder: 2, displayName: 'PeerB', supernodeEligible: true }
    ]

    tmA.updateGroupRoster('test-group', epoch, 1, roster, true)
    tmB.updateGroupRoster('test-group', epoch, 1, roster, true)

    try {
      await Promise.all([openA, openB])

      assert.equal(tmA.getLinkState(peerBId)?.state, 'open')
      assert.equal(tmB.getLinkState(peerAId)?.state, 'open')

      const channelA = await tmA.openFileChannel('test-group', peerBId, transferId)
      channelA.send(Buffer.from('chunk-1'))
      await fileChannelReceived
    } finally {
      await tmA.dispose()
      await tmB.dispose()
    }
  })
})
