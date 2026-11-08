import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { createSignalingServer } from '../services/signaling/server.ts'
import type {
  ServerSignalingMessageV2,
  ClientSignalingMessageV2,
  GroupJoinedMessage
} from '../src/shared/p2p-wire.ts'

describe('Signaling Server Rendezvous', () => {
  const groupId = 'test-group-1'
  const token = Buffer.alloc(32, 5).toString('base64url')

  it('serves /healthz with minimal status and no credentials', async () => {
    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [{ groupId, token }]
    })

    try {
      const res = await fetch(`http://127.0.0.1:${server.address.port}/healthz`)
      assert.equal(res.status, 200)
      const data = await res.json() as Record<string, unknown>
      assert.deepEqual(data, { ok: true })
      assert.equal(Object.keys(data).length, 1)

      const notFound = await fetch(`http://127.0.0.1:${server.address.port}/other`)
      assert.equal(notFound.status, 404)
    } finally {
      await server.close()
    }
  })

  it('rejects upgrades with missing or invalid token', async () => {
    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [{ groupId, token }]
    })

    try {
      // 1. Missing Authorization header
      const { promise: failPromise1, resolve: resolveFail1 } = Promise.withResolvers<void>()
      const wsNoAuth = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`)
      wsNoAuth.on('error', () => {})
      wsNoAuth.on('unexpected-response', (_req, res) => {
        assert.equal(res.statusCode, 401)
        resolveFail1()
      })
      await failPromise1

      // 2. Invalid Token Format (fails validateInviteCode)
      const { promise: failPromise2, resolve: resolveFail2 } = Promise.withResolvers<void>()
      const wsBadAuth = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`, {
        headers: { Authorization: 'Bearer invalid token spaces' }
      })
      wsBadAuth.on('error', () => {})
      wsBadAuth.on('unexpected-response', (_req, res) => {
        assert.equal(res.statusCode, 401)
        resolveFail2()
      })
      await failPromise2

      // 3. Token in query string rejected
      const { promise: failPromise3, resolve: resolveFail3 } = Promise.withResolvers<void>()
      const wsQuery = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal?token=${token}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      wsQuery.on('error', () => {})
      wsQuery.on('unexpected-response', (_req, res) => {
        assert.equal(res.statusCode, 400)
        resolveFail3()
      })
      await failPromise3
    } finally {
      await server.close()
    }
  })

  it('authenticates, joins peers, broadcasts rosters, and handles disconnects', async () => {
    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [{ groupId, token }],
      turnHost: 'turn.example.com',
      turnSecret: 'turn-secret-key-123'
    })

    const peerAId = randomUUID()
    const peerBId = randomUUID()

    try {
      // Connect Peer A
      const wsA = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`, {
        headers: { Authorization: `Bearer ${token}` }
      })

      const { promise: openA, resolve: resolveOpenA } = Promise.withResolvers<void>()
      wsA.on('open', () => resolveOpenA())
      await openA

      const { promise: welcomeA, resolve: resolveWelcomeA } = Promise.withResolvers<Extract<ServerSignalingMessageV2, { type: 'welcome' }>>()
      wsA.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'welcome') {
          resolveWelcomeA(msg)
        }
      })

      wsA.send(
        JSON.stringify({
          v: 2,
          type: 'register',
          peerId: peerAId,
          displayName: 'Alice'
        })
      )

      const welcomeAMsg = await welcomeA
      assert.equal(welcomeAMsg.type, 'welcome')
      assert.ok(welcomeAMsg.sessionId)
      assert.equal(welcomeAMsg.iceConfig.servers.length, 3)
      assert.ok(welcomeAMsg.iceConfig.servers[1].username?.includes(welcomeAMsg.sessionId))

      // Peer A joins group
      const { promise: joinedA, resolve: resolveJoinedA } = Promise.withResolvers<GroupJoinedMessage>()
      wsA.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'group-joined') {
          resolveJoinedA(msg)
        }
      })

      wsA.send(
        JSON.stringify({
          v: 2,
          type: 'join-group',
          groupId,
          token,
          supernodeEligible: true
        })
      )
      const joinedAMsg = await joinedA
      assert.equal(joinedAMsg.groupId, groupId)

      // Connect Peer B
      const wsB = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`, {
        headers: { Authorization: `Bearer ${token}` }
      })

      const { promise: openB, resolve: resolveOpenB } = Promise.withResolvers<void>()
      wsB.on('open', () => resolveOpenB())
      await openB

      const { promise: welcomeB, resolve: resolveWelcomeB } = Promise.withResolvers<void>()
      wsB.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'welcome') resolveWelcomeB()
      })
      wsB.send(
        JSON.stringify({
          v: 2,
          type: 'register',
          peerId: peerBId,
          displayName: 'Bob'
        })
      )
      await welcomeB

      const { promise: rosterOnA, resolve: resolveRosterOnA } = Promise.withResolvers<Extract<ServerSignalingMessageV2, { type: 'roster' }>>()
      wsA.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'roster' && msg.peers.length === 2) {
          resolveRosterOnA(msg)
        }
      })

      wsB.send(
        JSON.stringify({
          v: 2,
          type: 'join-group',
          groupId,
          token,
          supernodeEligible: true
        })
      )

      const rosterMsg = await rosterOnA
      assert.equal(rosterMsg.type, 'roster')
      assert.equal(rosterMsg.peers.length, 2)
      assert.equal(rosterMsg.peers[0].peerId, peerAId)
      assert.equal(rosterMsg.peers[1].peerId, peerBId)

      // Test signal forwarding from A to B
      const connectionId = randomUUID()
      const { promise: signalOnB, resolve: resolveSignalOnB } = Promise.withResolvers<Extract<ServerSignalingMessageV2, { type: 'signal' }>>()
      wsB.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'signal') {
          resolveSignalOnB(msg)
        }
      })

      wsA.send(
        JSON.stringify({
          v: 2,
          type: 'signal',
          groupId,
          targetPeerId: peerBId,
          targetSessionId: rosterMsg.peers[1].sessionId,
          connectionId,
          kind: 'request-offer',
          payload: null
        })
      )

      const signalMsg = await signalOnB
      assert.equal(signalMsg.type, 'signal')
      assert.equal(signalMsg.fromPeerId, peerAId)
      assert.equal(signalMsg.connectionId, connectionId)

      // Disconnect Peer B and observe Peer A receives updated roster with 1 peer
      const { promise: updatedRosterOnA, resolve: resolveUpdatedRosterA } = Promise.withResolvers<Extract<ServerSignalingMessageV2, { type: 'roster' }>>()
      wsA.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'roster' && msg.peers.length === 1) {
          resolveUpdatedRosterA(msg)
        }
      })

      wsB.close()
      const postLeaveRoster = await updatedRosterOnA
      assert.equal(postLeaveRoster.type, 'roster')
      assert.equal(postLeaveRoster.peers.length, 1)
      assert.equal(postLeaveRoster.peers[0].peerId, peerAId)

      wsA.close()
    } finally {
      await server.close()
    }
  })

  it('rejects duplicate peer IDs and non-existent groups', async () => {
    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [{ groupId, token }]
    })

    const peerId = randomUUID()

    try {
      const ws1 = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`, {
        headers: { Authorization: `Bearer ${token}` }
      })

      const { promise: open1, resolve: resolveOpen1 } = Promise.withResolvers<void>()
      ws1.on('open', () => resolveOpen1())
      await open1

      ws1.send(
        JSON.stringify({
          v: 2,
          type: 'register',
          peerId,
          displayName: 'Client1'
        })
      )

      // Try registering duplicate peerId on another connection
      const ws2 = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`, {
        headers: { Authorization: `Bearer ${token}` }
      })

      const { promise: open2, resolve: resolveOpen2 } = Promise.withResolvers<void>()
      ws2.on('open', () => resolveOpen2())
      await open2

      const { promise: duplicateError, resolve: resolveDupError } = Promise.withResolvers<Extract<ServerSignalingMessageV2, { type: 'error' }>>()
      ws2.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'error') {
          resolveDupError(msg)
        }
      })

      ws2.send(
        JSON.stringify({
          v: 2,
          type: 'register',
          peerId, // duplicate
          displayName: 'Client2'
        })
      )

      const err = await duplicateError
      assert.equal(err.type, 'error')
      assert.equal(err.code, 'DUPLICATE_PEER_ID')

      // Client 1 tries joining non-existent group
      const { promise: groupError, resolve: resolveGroupError } = Promise.withResolvers<Extract<ServerSignalingMessageV2, { type: 'error' }>>()
      ws1.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'error') {
          resolveGroupError(msg)
        }
      })

      ws1.send(
        JSON.stringify({
          v: 2,
          type: 'join-group',
          groupId: 'non-existent-group',
          token,
          supernodeEligible: true
        })
      )

      const groupErr = await groupError
      assert.equal(groupErr.type, 'error')
      assert.equal(groupErr.code, 'NOT_FOUND')

      ws1.close()
      ws2.close()
    } finally {
      await server.close()
    }
  })

  it('delivers managed STUN and TURN iceConfig when configured for Render/Metered', async () => {
    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [{ groupId, token }],
      stunUrl: 'stun:stun.relay.metered.ca:80',
      turnUrl: 'turns:global.relay.metered.ca:443?transport=tcp',
      turnUsername: 'metered-user',
      turnCredential: 'metered-pass'
    })

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const { promise: openPromise, resolve: resolveOpen } = Promise.withResolvers<void>()
      ws.on('open', () => resolveOpen())
      await openPromise

      const { promise: welcomePromise, resolve: resolveWelcome } = Promise.withResolvers<Extract<ServerSignalingMessageV2, { type: 'welcome' }>>()
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'welcome') {
          resolveWelcome(msg)
        }
      })

      ws.send(
        JSON.stringify({
          v: 2,
          type: 'register',
          peerId: randomUUID(),
          displayName: 'RenderPeer'
        })
      )

      const welcome = await welcomePromise
      assert.equal(welcome.type, 'welcome')
      assert.deepEqual(welcome.iceConfig.servers, [
        { urls: 'stun:stun.relay.metered.ca:80' },
        {
          urls: 'turns:global.relay.metered.ca:443?transport=tcp',
          username: 'metered-user',
          credential: 'metered-pass'
        }
      ])
      ws.close()
    } finally {
      await server.close()
    }
  })
})

describe('Multi-Group Multiplexed Signaling V2', () => {
  const tokenA = Buffer.alloc(32, 21).toString('base64url')
  const tokenB = Buffer.alloc(32, 22).toString('base64url')
  const groups = [
    { groupId: 'group-A', token: tokenA },
    { groupId: 'group-B', token: tokenB }
  ]

  it('single socket registers identity and joins multiple groups A and B independently', async () => {
    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups
    })

    const peerId = randomUUID()
    const ws = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    })

    try {
      const { promise: openPromise, resolve: resolveOpen } = Promise.withResolvers<void>()
      ws.on('open', () => resolveOpen())
      await openPromise

      const { promise: welcomePromise, resolve: resolveWelcome } = Promise.withResolvers<Extract<ServerSignalingMessageV2, { type: 'welcome' }>>()
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'welcome') {
          resolveWelcome(msg)
        }
      })

      ws.send(
        JSON.stringify({
          v: 2,
          type: 'register',
          peerId,
          displayName: 'MultiClient'
        })
      )

      await welcomePromise

      // Join group A
      const { promise: joinedAPromise, resolve: resolveJoinedA } = Promise.withResolvers<GroupJoinedMessage>()
      const handlerA = (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'group-joined' && msg.groupId === 'group-A') {
          ws.off('message', handlerA)
          resolveJoinedA(msg)
        }
      }
      ws.on('message', handlerA)

      ws.send(
        JSON.stringify({
          v: 2,
          type: 'join-group',
          groupId: 'group-A',
          token: tokenA,
          supernodeEligible: true
        })
      )
      const joinedA = await joinedAPromise
      assert.equal(joinedA.groupId, 'group-A')

      // Join group B on the SAME socket
      const { promise: joinedBPromise, resolve: resolveJoinedB } = Promise.withResolvers<GroupJoinedMessage>()
      const handlerB = (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'group-joined' && msg.groupId === 'group-B') {
          ws.off('message', handlerB)
          resolveJoinedB(msg)
        }
      }
      ws.on('message', handlerB)

      ws.send(
        JSON.stringify({
          v: 2,
          type: 'join-group',
          groupId: 'group-B',
          token: tokenB,
          supernodeEligible: false
        })
      )
      const joinedB = await joinedBPromise
      assert.equal(joinedB.groupId, 'group-B')
      assert.notEqual(joinedA.membershipId, joinedB.membershipId)

      ws.close()
    } finally {
      await server.close()
    }
  })

  it('isolates rosters between unrelated groups (events in A do not leak to B)', async () => {
    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups
    })

    const peerAId = randomUUID()
    const peerBId = randomUUID()

    const wsA = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    })
    const wsB = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`, {
      headers: { Authorization: `Bearer ${tokenB}` }
    })

    try {
      await Promise.all([
        new Promise<void>((r) => wsA.on('open', r)),
        new Promise<void>((r) => wsB.on('open', r))
      ])

      wsA.send(JSON.stringify({ v: 2, type: 'register', peerId: peerAId, displayName: 'PeerA' }))
      wsB.send(JSON.stringify({ v: 2, type: 'register', peerId: peerBId, displayName: 'PeerB' }))

      await Promise.all([
        new Promise<void>((r) => wsA.once('message', () => r())),
        new Promise<void>((r) => wsB.once('message', () => r()))
      ])

      // B listens for any unexpected group-A roster
      let leakDetected = false
      wsB.on('message', (d) => {
        const msg = JSON.parse(d.toString('utf-8')) as ServerSignalingMessageV2
        if ('groupId' in msg && msg.groupId === 'group-A') {
          leakDetected = true
        }
      })

      const { promise: aJoined, resolve: resolveAJoined } = Promise.withResolvers<void>()
      wsA.on('message', (d) => {
        const msg = JSON.parse(d.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'group-joined' && msg.groupId === 'group-A') resolveAJoined()
      })
      wsA.send(JSON.stringify({ v: 2, type: 'join-group', groupId: 'group-A', token: tokenA, supernodeEligible: true }))
      await aJoined

      await new Promise((r) => setTimeout(r, 100))
      assert.equal(leakDetected, false, 'Group-A events must not leak to Group-B socket')

      wsA.close()
      wsB.close()
    } finally {
      await server.close()
    }
  })

  it('scoped invalid token and leave do not affect other active memberships on same socket', async () => {
    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups
    })

    const peerId = randomUUID()
    const ws = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    })

    try {
      await new Promise<void>((r) => ws.on('open', r))
      ws.send(JSON.stringify({ v: 2, type: 'register', peerId, displayName: 'TestPeer' }))
      await new Promise<void>((r) => ws.once('message', () => r()))

      // Join A
      const { promise: aJoined, resolve: resolveAJoined } = Promise.withResolvers<void>()
      ws.on('message', (d) => {
        const msg = JSON.parse(d.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'group-joined' && msg.groupId === 'group-A') resolveAJoined()
      })
      ws.send(JSON.stringify({ v: 2, type: 'join-group', groupId: 'group-A', token: tokenA, supernodeEligible: true }))
      await aJoined

      // Attempt invalid token on group B
      const { promise: bError, resolve: resolveBError } = Promise.withResolvers<Extract<ServerSignalingMessageV2, { type: 'error' }>>()
      const errHandler = (d: WebSocket.RawData) => {
        const msg = JSON.parse(d.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'error' && msg.groupId === 'group-B') {
          ws.off('message', errHandler)
          resolveBError(msg)
        }
      }
      ws.on('message', errHandler)
      ws.send(JSON.stringify({ v: 2, type: 'join-group', groupId: 'group-B', token: 'wrong-token', supernodeEligible: false }))
      const err = await bError
      assert.equal(err.code, 'AUTH_FAILED')
      assert.equal(ws.readyState, WebSocket.OPEN, 'Socket must remain open after scoped auth failure')

      // Leave A
      const { promise: aLeft, resolve: resolveALeft } = Promise.withResolvers<void>()
      ws.on('message', (d) => {
        const msg = JSON.parse(d.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'group-left' && msg.groupId === 'group-A') resolveALeft()
      })
      ws.send(JSON.stringify({ v: 2, type: 'leave-group', groupId: 'group-A' }))
      await aLeft
      assert.equal(ws.readyState, WebSocket.OPEN)

      ws.close()
    } finally {
      await server.close()
    }
  })

  it('forwards signals strictly when both peers share group and target session matches', async () => {
    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups
    })

    const peer1Id = randomUUID()
    const peer2Id = randomUUID()

    const ws1 = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    })
    const ws2 = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    })

    try {
      await Promise.all([
        new Promise<void>((r) => ws1.on('open', r)),
        new Promise<void>((r) => ws2.on('open', r))
      ])

      const { promise: w1P, resolve: resolveW1 } = Promise.withResolvers<Extract<ServerSignalingMessageV2, { type: 'welcome' }>>()
      ws1.on('message', (d) => {
        const m = JSON.parse(d.toString('utf-8')) as ServerSignalingMessageV2
        if (m.type === 'welcome') resolveW1(m)
      })
      ws1.send(JSON.stringify({ v: 2, type: 'register', peerId: peer1Id, displayName: 'Peer1' }))
      await w1P

      const { promise: w2P, resolve: resolveW2 } = Promise.withResolvers<Extract<ServerSignalingMessageV2, { type: 'welcome' }>>()
      ws2.on('message', (d) => {
        const m = JSON.parse(d.toString('utf-8')) as ServerSignalingMessageV2
        if (m.type === 'welcome') resolveW2(m)
      })
      ws2.send(JSON.stringify({ v: 2, type: 'register', peerId: peer2Id, displayName: 'Peer2' }))
      const w2 = await w2P

      // Both join group A
      const { promise: r1P, resolve: resolveR1 } = Promise.withResolvers<Extract<ServerSignalingMessageV2, { type: 'roster' }>>()
      ws1.on('message', (d) => {
        const m = JSON.parse(d.toString('utf-8')) as ServerSignalingMessageV2
        if (m.type === 'roster' && m.peers.length === 2) resolveR1(m)
      })

      ws1.send(JSON.stringify({ v: 2, type: 'join-group', groupId: 'group-A', token: tokenA, supernodeEligible: true }))
      ws2.send(JSON.stringify({ v: 2, type: 'join-group', groupId: 'group-A', token: tokenA, supernodeEligible: true }))
      await r1P

      // Signal from 1 to 2 with matching session
      const connectionId = randomUUID()
      const { promise: sigP, resolve: resolveSig } = Promise.withResolvers<Extract<ServerSignalingMessageV2, { type: 'signal' }>>()
      ws2.on('message', (d) => {
        const m = JSON.parse(d.toString('utf-8')) as ServerSignalingMessageV2
        if (m.type === 'signal') resolveSig(m)
      })

      ws1.send(
        JSON.stringify({
          v: 2,
          type: 'signal',
          groupId: 'group-A',
          targetPeerId: peer2Id,
          targetSessionId: w2.sessionId,
          connectionId,
          kind: 'offer',
          payload: { type: 'offer', sdp: 'test-sdp' }
        })
      )

      const sig = await sigP
      assert.equal(sig.connectionId, connectionId)
      assert.equal(sig.fromPeerId, peer1Id)

      ws1.close()
      ws2.close()
    } finally {
      await server.close()
    }
  })

  it('handles Group Owner creation, short-code join, invite rotation, and member kicking', async () => {
    // Start server with empty groups (dynamic mode)
    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: []
    })

    const peerOwnerId = randomUUID()
    const peerMemberId = randomUUID()
    const ownerSecret = 'owner-super-secret-1234'

    // Owner connects with 'create-group' bearer token
    const wsOwner = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`, {
      headers: { Authorization: 'Bearer create-group' }
    })

    try {
      await new Promise<void>((r) => wsOwner.on('open', r))
      wsOwner.send(JSON.stringify({ v: 2, type: 'register', peerId: peerOwnerId, displayName: 'Owner' }))
      await new Promise<void>((r) => wsOwner.once('message', () => r()))

      // Owner creates dynamic group 'test-owners-club'
      const { promise: createPromise, resolve: resolveCreate } = Promise.withResolvers<GroupJoinedMessage>()
      wsOwner.on('message', (d) => {
        const msg = JSON.parse(d.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'group-joined' && msg.groupId === 'test-owners-club') {
          resolveCreate(msg)
        }
      })

      wsOwner.send(
        JSON.stringify({
          v: 2,
          type: 'create-group',
          groupId: 'test-owners-club',
          ownerSecret,
          supernodeEligible: true
        })
      )

      const createMsg = await createPromise
      assert.equal(createMsg.groupId, 'test-owners-club')
      assert.equal(createMsg.ownerPeerId, peerOwnerId)
      assert.ok(createMsg.inviteCode)
      assert.equal(createMsg.inviteCode.length, 22) // 22-character short code

      const inviteCode = createMsg.inviteCode

      // Member connects using the short inviteCode as Bearer token
      const wsMember = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`, {
        headers: { Authorization: `Bearer ${inviteCode}` }
      })

      await new Promise<void>((r) => wsMember.on('open', r))
      wsMember.send(JSON.stringify({ v: 2, type: 'register', peerId: peerMemberId, displayName: 'InvitedMember' }))
      await new Promise<void>((r) => wsMember.once('message', () => r()))

      // Member joins using code-only join (no groupId specified)
      const { promise: memberJoinPromise, resolve: resolveMemberJoin } = Promise.withResolvers<GroupJoinedMessage>()
      wsMember.on('message', (d) => {
        const msg = JSON.parse(d.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'group-joined') {
          resolveMemberJoin(msg)
        }
      })

      wsMember.send(
        JSON.stringify({
          v: 2,
          type: 'join-group',
          token: inviteCode,
          supernodeEligible: false
        })
      )

      const memberJoinMsg = await memberJoinPromise
      assert.equal(memberJoinMsg.groupId, 'test-owners-club')
      assert.equal(memberJoinMsg.ownerPeerId, peerOwnerId)
      assert.equal(memberJoinMsg.peers.length, 2)

      // Test Rotate Invite: Owner rotates invite code
      const { promise: rotatedOnOwner, resolve: resolveRotatedOnOwner } = Promise.withResolvers<string>()
      const { promise: rotatedOnMember, resolve: resolveRotatedOnMember } = Promise.withResolvers<string>()

      wsOwner.on('message', (d) => {
        const msg = JSON.parse(d.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'invite-rotated' && msg.groupId === 'test-owners-club') {
          resolveRotatedOnOwner(msg.inviteCode)
        }
      })
      wsMember.on('message', (d) => {
        const msg = JSON.parse(d.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'invite-rotated' && msg.groupId === 'test-owners-club') {
          resolveRotatedOnMember(msg.inviteCode)
        }
      })

      wsOwner.send(
        JSON.stringify({
          v: 2,
          type: 'rotate-invite',
          groupId: 'test-owners-club',
          ownerSecret
        })
      )

      const newCodeOwner = await rotatedOnOwner
      const newCodeMember = await rotatedOnMember
      assert.equal(newCodeOwner, newCodeMember)
      assert.notEqual(newCodeOwner, inviteCode)

      // Non-owner attempting rotate-invite is rejected with FORBIDDEN
      const { promise: forbiddenRotPromise, resolve: resolveForbiddenRot } = Promise.withResolvers<Extract<ServerSignalingMessageV2, { type: 'error' }>>()
      wsMember.on('message', (d) => {
        const msg = JSON.parse(d.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'error' && msg.groupId === 'test-owners-club') {
          resolveForbiddenRot(msg)
        }
      })
      wsMember.send(
        JSON.stringify({
          v: 2,
          type: 'rotate-invite',
          groupId: 'test-owners-club',
          ownerSecret: 'wrong-secret'
        })
      )
      const forbiddenRot = await forbiddenRotPromise
      assert.equal(forbiddenRot.code, 'FORBIDDEN')

      // Owner removes Member from group
      const { promise: kickedPromise, resolve: resolveKicked } = Promise.withResolvers<Extract<ServerSignalingMessageV2, { type: 'group-kicked' }>>()
      const { promise: ownerUpdatedRoster, resolve: resolveOwnerRoster } = Promise.withResolvers<Extract<ServerSignalingMessageV2, { type: 'roster' }>>()

      wsMember.on('message', (d) => {
        const msg = JSON.parse(d.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'group-kicked' && msg.groupId === 'test-owners-club') {
          resolveKicked(msg)
        }
      })
      wsOwner.on('message', (d) => {
        const msg = JSON.parse(d.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'roster' && msg.groupId === 'test-owners-club' && msg.peers.length === 1) {
          resolveOwnerRoster(msg)
        }
      })

      wsOwner.send(
        JSON.stringify({
          v: 2,
          type: 'remove-member',
          groupId: 'test-owners-club',
          targetPeerId: peerMemberId,
          ownerSecret
        })
      )

      const kickedMsg = await kickedPromise
      assert.equal(kickedMsg.reason, 'Removed by group owner')

      const ownerRoster = await ownerUpdatedRoster
      assert.equal(ownerRoster.peers.length, 1)
      assert.equal(ownerRoster.peers[0].peerId, peerOwnerId)

      wsOwner.close()
      wsMember.close()
    } finally {
      await server.close()
    }
  })
})
