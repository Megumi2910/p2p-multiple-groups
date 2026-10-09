import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  parseNetworkInvitation,
  parseGroupInvitation,
  validateConnectOptions,
  validateDisplayName,
  validateRoomId,
  validateGroupId,
  validateSignalingUrl,
  validateToken,
  makeGroupKey,
  parseGroupKey,
  validateJoinGroupOptions,
  type ConnectOptions,
  type JoinGroupOptions
} from '../src/shared/p2p.ts'
import {
  isClientSignalingMessage,
  isOverlayControlMessage,
  isServerSignalingMessage,
  isTransferControlMessage,
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
import { createPeerStore, type PeerStore } from '../src/main/p2p/peer-store.ts'
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

  it('validates room IDs, tokens, and display names', () => {
    assert.equal(validateRoomId('room-123_abc').valid, true)
    assert.equal(validateRoomId('room with spaces').valid, false)
    assert.equal(validateRoomId('').valid, false)

    const token32 = Buffer.alloc(32, 7).toString('base64url')
    assert.equal(validateToken(token32).valid, true)
    assert.equal(validateToken('too-short').valid, false)

    assert.equal(validateDisplayName('Alice').valid, true)
    assert.equal(validateDisplayName('  Alice  ').valid, true)
    assert.equal(validateDisplayName('').valid, false)
    assert.equal(validateDisplayName('Name\x00WithNull').valid, false)
  })

  it('parses network invitations accurately', () => {
    const token = Buffer.alloc(32, 9).toString('base64url')
    const validRaw = JSON.stringify({
      version: 1,
      signalingUrl: 'ws://127.0.0.1:8787/signal',
      roomId: 'test-room',
      token
    })
    const parsed = parseNetworkInvitation(validRaw)
    assert.ok(parsed)
    assert.equal(parsed?.version, 1)
    assert.equal(parsed?.roomId, 'test-room')

    assert.equal(parseNetworkInvitation('invalid json'), null)
    assert.equal(parseNetworkInvitation(JSON.stringify({ version: 2 })), null)
  })

  it('validates connect options payload', () => {
    const token = Buffer.alloc(32, 9).toString('base64url')
    const valid: ConnectOptions = {
      signalingUrl: 'ws://127.0.0.1:8787/signal',
      roomId: 'room-1',
      token,
      displayName: 'Bob',
      supernodeEligible: true,
      relayOnly: false
    }
    assert.equal(validateConnectOptions(valid).valid, true)
    assert.equal(validateConnectOptions({ ...valid, displayName: '' }).valid, false)
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

  it('validates wire protocol message discriminators and limits', () => {
    const epoch = randomUUID()
    assert.equal(
      isClientSignalingMessage({
        v: 1,
        type: 'join',
        roomId: 'room1',
        peerId: randomUUID(),
        displayName: 'Alice',
        supernodeEligible: true
      }),
      true
    )

    assert.equal(
      isOverlayControlMessage({
        v: 1,
        type: 'hello',
        epoch,
        revision: 1,
        peerId: randomUUID(),
        sessionId: randomUUID()
      }),
      true
    )

    // Stale or missing epoch/revision fails
    assert.equal(
      isOverlayControlMessage({
        v: 1,
        type: 'hello',
        peerId: randomUUID(),
        sessionId: randomUUID()
      }),
      false
    )

    assert.equal(
      isTransferControlMessage({
        v: 1,
        type: 'request',
        fileId: randomUUID(),
        size: 100,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      }),
      true
    )
  })

  it('validates group IDs, strengthened 32-byte tokens, and rejects non-canonical base64url', () => {
    assert.equal(validateGroupId('group-123_abc').valid, true)
    assert.equal(validateGroupId('invalid group spaces').valid, false)
    assert.equal(validateGroupId('').valid, false)

    const validToken = Buffer.alloc(32, 10).toString('base64url')
    assert.equal(validateToken(validToken).valid, true)
    assert.equal(validateToken('too-short').valid, false)
    assert.equal(validateToken(validToken + 'extra').valid, false)

    // Tamper with last char to make trailing padding bits non-zero
    const nonCanonicalToken = validToken.slice(0, 42) + 'B'
    assert.equal(validateToken(nonCanonicalToken).valid, false)
  })

  it('parses v2 group invitations and normalizes v1 invitations', () => {
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

    // v1 invitation normalized to v2
    const v1Raw = JSON.stringify({
      version: 1,
      signalingUrl: 'ws://127.0.0.1:8787/signal',
      roomId: 'legacy-room',
      token
    })
    const normalizedV1 = parseGroupInvitation(v1Raw)
    assert.ok(normalizedV1)
    assert.equal(normalizedV1?.version, 2)
    assert.equal(normalizedV1?.groupId, 'legacy-room')
    assert.equal(normalizedV1?.token, token)

    // Invalid version or payload rejected
    assert.equal(parseGroupInvitation(JSON.stringify({ version: 99 })), null)
    assert.equal(parseGroupInvitation('not-json'), null)
  })

  it('validates join group options and group keys', () => {
    const token = Buffer.alloc(32, 15).toString('base64url')
    const validOptions: JoinGroupOptions = {
      invitation: {
        version: 2,
        signalingUrl: 'ws://127.0.0.1:8787/signal',
        groupId: 'test-group',
        token
      },
      displayName: 'Alice',
      supernodeEligible: true,
      relayOnly: false,
      rememberInvitation: false
    }

    assert.equal(validateJoinGroupOptions(validOptions).valid, true)
    assert.equal(validateJoinGroupOptions({ ...validOptions, displayName: '' }).valid, false)
    assert.equal(validateJoinGroupOptions({ ...validOptions, supernodeEligible: 'true' as unknown as boolean }).valid, false)
    assert.equal(validateJoinGroupOptions({ ...validOptions, relayOnly: 1 as unknown as boolean }).valid, false)
    assert.equal(validateJoinGroupOptions({ ...validOptions, rememberInvitation: null as unknown as boolean }).valid, false)

    const key = makeGroupKey('ws://127.0.0.1:8787/signal', 'test-group')
    const parsedKey = parseGroupKey(key)
    assert.deepEqual(parsedKey, { signalingUrl: 'ws://127.0.0.1:8787/signal', groupId: 'test-group' })
    assert.equal(parseGroupKey('invalid-key'), null)
  })

  it('validates v2 wire protocol messages, physical hello, and scoped channel labels', () => {
    const peerId = randomUUID()
    const sessionId = randomUUID()
    const membershipId = randomUUID()
    const connectionId = randomUUID()
    const epoch = randomUUID()

    // Client V2
    assert.equal(
      isClientSignalingMessageV2({
        v: 2,
        type: 'join-group',
        groupId: 'grp1',
        token: Buffer.alloc(32, 1).toString('base64url'),
        supernodeEligible: true
      }),
      true
    )

    // Server V2
    assert.equal(
      isServerSignalingMessageV2({
        v: 2,
        type: 'group-joined',
        groupId: 'grp1',
        membershipId,
        epoch,
        revision: 1,
        peers: [
          {
            peerId,
            sessionId,
            membershipId,
            joinOrder: 1,
            displayName: 'Bob',
            supernodeEligible: true
          }
        ]
      }),
      true
    )

    // Physical Peer Hello
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
    // Physical hello with extra or wrong version fails
    assert.equal(isPeerHelloMessage({ v: 1, type: 'hello', peerId, sessionId, connectionId }), false)

    // Overlay Control V2
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

    // Transfer Control V2
    assert.equal(
      isTransferControlMessageV2({
        v: 2,
        type: 'request',
        groupId: 'grp1',
        transferId: randomUUID(),
        epoch,
        requesterMembershipId: membershipId,
        ownerMembershipId: randomUUID(),
        fileId: randomUUID(),
        size: 1024,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
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

describe('PeerStore Persistence', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kazaa-test-store-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('creates a fresh identity when peer-state.json is missing', async () => {
    const store = await createPeerStore(tempDir)
    const state = store.get()
    assert.equal(state.version, 1)
    assert.ok(isUuid(state.peerId))
    assert.ok(state.displayName.startsWith('Peer-'))
    assert.equal(state.supernodeEligible, true)
    assert.deepEqual(state.sharedFiles, [])
  })

  it('persists and reloads mutations durably', async () => {
    const store1 = await createPeerStore(tempDir)
    await store1.setDisplayName('CustomPeer')
    await store1.setSupernodeEligible(false)
    await store1.setConnectionParams('ws://127.0.0.1:8787/signal', 'room-alpha')
    const fileId = randomUUID()
    await store1.addSharedFile({ fileId, path: 'C:\\test\\file.txt' })

    const store2 = await createPeerStore(tempDir)
    const state2 = store2.get()
    assert.equal(state2.displayName, 'CustomPeer')
    assert.equal(state2.supernodeEligible, false)
    assert.equal(state2.signalingUrl, 'ws://127.0.0.1:8787/signal')
    assert.equal(state2.roomId, 'room-alpha')
    assert.equal(state2.sharedFiles.length, 1)
    assert.equal(state2.sharedFiles[0].fileId, fileId)
  })

  it('throws actionable error on corrupt state file and never overwrites it', async () => {
    const statePath = join(tempDir, 'peer-state.json')
    await writeFile(statePath, '{ "corrupted": true, broken JSON ...', 'utf-8')

    await assert.rejects(
      async () => {
        await createPeerStore(tempDir)
      },
      (err: Error) => {
        assert.ok(err.message.includes('Corrupt peer profile'))
        return true
      }
    )
  })
})

describe('TransportManager Loopback Peer Connection', () => {
  it('connects two local peers, completes hello handshake and opens file channel', async () => {
    const epoch = randomUUID()
    const peerAId = '00000000-0000-4000-8000-000000000001'
    const peerBId = '00000000-0000-4000-8000-000000000002'
    const sessionAId = randomUUID()
    const sessionBId = randomUUID()

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
        void tmB.handleSignal(sig.targetPeerId === peerBId ? peerAId : peerBId, sessionAId, sig.connectionId, sig.kind, sig.payload)
      }
    })

    tmB = new TransportManager({
      onControlMessage: () => {},
      onFileChannel: (_peerId: string, tId: string, channel: RTCDataChannel) => {
        if (tId === transferId) {
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
        void tmA.handleSignal(sig.targetPeerId === peerAId ? peerBId : peerAId, sessionBId, sig.connectionId, sig.kind, sig.payload)
      }
    })

    const emptyIce = { expiresAt: Date.now() + 3600000, servers: [] }
    tmA.setSignalingContext(epoch, 1, peerAId, sessionAId, emptyIce, false)
    tmB.setSignalingContext(epoch, 1, peerBId, sessionBId, emptyIce, false)

    const roster = [
      { peerId: peerAId, sessionId: sessionAId, joinOrder: 1, displayName: 'PeerA', supernodeEligible: true },
      { peerId: peerBId, sessionId: sessionBId, joinOrder: 2, displayName: 'PeerB', supernodeEligible: true }
    ]

    tmA.updateRoster(roster)
    tmB.updateRoster(roster)

    try {
      await Promise.all([openA, openB])

      assert.equal(tmA.getLinkState(peerBId)?.state, 'open')
      assert.equal(tmB.getLinkState(peerAId)?.state, 'open')

      // Open file channel from A to B
      const channelA = await tmA.openFileChannel(peerBId, transferId)
      channelA.send(Buffer.from('chunk-1'))
      await fileChannelReceived
    } finally {
      await tmA.dispose()
      await tmB.dispose()
    }
  })
})
