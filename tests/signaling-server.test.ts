import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { createSignalingServer } from '../services/signaling/server.ts'
import type {
  ServerSignalingMessage,
  ServerSignalingMessageV2,
  ClientSignalingMessageV2,
  GroupJoinedMessage
} from '../src/shared/p2p-wire.ts'

describe('Signaling Server Rendezvous', () => {
  const roomId = 'test-room-1'
  const token = Buffer.alloc(32, 5).toString('base64url')

  it('serves /healthz with minimal status and no credentials', async () => {
    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      roomId,
      token
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
      roomId,
      token
    })

    try {
      // 1. Missing Authorization header
      const { promise: failPromise1, resolve: resolveFail1 } = Promise.withResolvers<void>()
      const wsNoAuth = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`)
      wsNoAuth.on('unexpected-response', (_req, res) => {
        assert.equal(res.statusCode, 401)
        resolveFail1()
      })
      await failPromise1

      // 2. Invalid Token
      const { promise: failPromise2, resolve: resolveFail2 } = Promise.withResolvers<void>()
      const wsBadAuth = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`, {
        headers: { Authorization: 'Bearer wrong-token-value' }
      })
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
      roomId,
      token,
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

      const { promise: welcomeA, resolve: resolveWelcomeA } = Promise.withResolvers<ServerSignalingMessage>()
      wsA.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf-8')) as ServerSignalingMessage
        if (msg.type === 'welcome') {
          resolveWelcomeA(msg)
        }
      })

      wsA.send(
        JSON.stringify({
          v: 1,
          type: 'join',
          roomId,
          peerId: peerAId,
          displayName: 'Alice',
          supernodeEligible: true
        })
      )

      const welcomeAMsg = await welcomeA
      assert.equal(welcomeAMsg.type, 'welcome')
      assert.ok(welcomeAMsg.sessionId)
      assert.ok(welcomeAMsg.epoch)
      assert.equal(welcomeAMsg.iceConfig.servers.length, 2)
      assert.ok(welcomeAMsg.iceConfig.servers[1].username?.includes(welcomeAMsg.sessionId))

      // Connect Peer B
      const wsB = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`, {
        headers: { Authorization: `Bearer ${token}` }
      })

      const { promise: openB, resolve: resolveOpenB } = Promise.withResolvers<void>()
      wsB.on('open', () => resolveOpenB())
      await openB

      const { promise: rosterOnA, resolve: resolveRosterOnA } = Promise.withResolvers<ServerSignalingMessage>()
      wsA.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf-8')) as ServerSignalingMessage
        if (msg.type === 'roster' && msg.peers.length === 2) {
          resolveRosterOnA(msg)
        }
      })

      wsB.send(
        JSON.stringify({
          v: 1,
          type: 'join',
          roomId,
          peerId: peerBId,
          displayName: 'Bob',
          supernodeEligible: true
        })
      )

      const rosterMsg = await rosterOnA
      assert.equal(rosterMsg.type, 'roster')
      assert.equal(rosterMsg.peers.length, 2)
      assert.equal(rosterMsg.peers[0].peerId, peerAId)
      assert.equal(rosterMsg.peers[1].peerId, peerBId)

      // Test message forwarding from A to B
      const connectionId = randomUUID()
      const { promise: signalOnB, resolve: resolveSignalOnB } = Promise.withResolvers<ServerSignalingMessage>()
      wsB.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf-8')) as ServerSignalingMessage
        if (msg.type === 'signal') {
          resolveSignalOnB(msg)
        }
      })

      wsA.send(
        JSON.stringify({
          v: 1,
          type: 'signal',
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
      const { promise: updatedRosterOnA, resolve: resolveUpdatedRosterA } = Promise.withResolvers<ServerSignalingMessage>()
      wsA.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf-8')) as ServerSignalingMessage
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

  it('rejects duplicate peer IDs and room mismatches', async () => {
    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      roomId,
      token
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
          v: 1,
          type: 'join',
          roomId,
          peerId,
          displayName: 'Client1',
          supernodeEligible: true
        })
      )

      // Try joining with duplicate peerId
      const ws2 = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`, {
        headers: { Authorization: `Bearer ${token}` }
      })

      const { promise: open2, resolve: resolveOpen2 } = Promise.withResolvers<void>()
      ws2.on('open', () => resolveOpen2())
      await open2

      const { promise: duplicateError, resolve: resolveDupError } = Promise.withResolvers<ServerSignalingMessage>()
      ws2.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf-8')) as ServerSignalingMessage
        if (msg.type === 'error') {
          resolveDupError(msg)
        }
      })

      ws2.send(
        JSON.stringify({
          v: 1,
          type: 'join',
          roomId,
          peerId, // duplicate!
          displayName: 'Client2',
          supernodeEligible: true
        })
      )

      const err = await duplicateError
      assert.equal(err.type, 'error')
      if (err.type === 'error') {
        assert.equal(err.code, 'DUPLICATE_PEER_ID')
      }
      // Try joining wrong room
      const ws3 = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const { promise: open3, resolve: resolveOpen3 } = Promise.withResolvers<void>()
      ws3.on('open', () => resolveOpen3())
      await open3

      const { promise: roomError, resolve: resolveRoomError } = Promise.withResolvers<ServerSignalingMessage>()
      ws3.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf-8')) as ServerSignalingMessage
        if (msg.type === 'error') {
          resolveRoomError(msg)
        }
      })

      ws3.send(
        JSON.stringify({
          v: 1,
          type: 'join',
          roomId: 'wrong-room-id',
          peerId: randomUUID(),
          displayName: 'Client3',
          supernodeEligible: true
        })
      )

      const roomErr = await roomError
      assert.equal(roomErr.type, 'error')
      if (roomErr.type === 'error') {
        assert.equal(roomErr.code, 'ROOM_MISMATCH')
      }
      ws1.close()
      ws2.close()
      ws3.close()
    } finally {
      await server.close()
    }
  })

  it('delivers managed STUN and TURN iceConfig when configured for Render/Metered', async () => {
    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      roomId,
      token,
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

      const { promise: welcomePromise, resolve: resolveWelcome } = Promise.withResolvers<ServerSignalingMessage>()
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf-8')) as ServerSignalingMessage
        if (msg.type === 'welcome') {
          resolveWelcome(msg)
        }
      })

      ws.send(
        JSON.stringify({
          v: 1,
          type: 'join',
          roomId,
          peerId: randomUUID(),
          displayName: 'RenderPeer',
          supernodeEligible: true
        })
      )

      const welcome = await welcomePromise
      assert.equal(welcome.type, 'welcome')
      if (welcome.type === 'welcome') {
        assert.deepEqual(welcome.iceConfig.servers, [
          { urls: 'stun:stun.relay.metered.ca:80' },
          {
            urls: 'turns:global.relay.metered.ca:443?transport=tcp',
            username: 'metered-user',
            credential: 'metered-pass'
          }
        ])
      }
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

      const messages: ServerSignalingMessageV2[] = []
      ws.on('message', (d) => {
        messages.push(JSON.parse(d.toString('utf-8')) as ServerSignalingMessageV2)
      })

      // 1. Register socket identity
      ws.send(JSON.stringify({ v: 2, type: 'register', peerId, displayName: 'Alice' }))
      await new Promise<void>((r) => {
        const check = () => (messages.some((m) => m.type === 'welcome') ? r() : setTimeout(check, 10))
        check()
      })

      const welcome = messages.find((m) => m.type === 'welcome')
      assert.ok(welcome && welcome.type === 'welcome')
      const sessionId = welcome.sessionId
      assert.ok(sessionId)

      // 2. Join group A
      ws.send(JSON.stringify({ v: 2, type: 'join-group', groupId: 'group-A', token: tokenA, supernodeEligible: true }))
      await new Promise<void>((r) => {
        const check = () => (messages.some((m) => m.type === 'group-joined' && m.groupId === 'group-A') ? r() : setTimeout(check, 10))
        check()
      })

      const joinedA = messages.find((m) => m.type === 'group-joined' && m.groupId === 'group-A')
      assert.ok(joinedA && joinedA.type === 'group-joined')
      assert.equal(joinedA.groupId, 'group-A')
      assert.equal(joinedA.peers.length, 1)
      assert.equal(joinedA.peers[0].peerId, peerId)
      assert.equal(joinedA.peers[0].sessionId, sessionId)
      const membershipIdA = joinedA.membershipId
      assert.ok(membershipIdA)

      // 3. Join group B on same socket
      ws.send(JSON.stringify({ v: 2, type: 'join-group', groupId: 'group-B', token: tokenB, supernodeEligible: false }))
      await new Promise<void>((r) => {
        const check = () => (messages.some((m) => m.type === 'group-joined' && m.groupId === 'group-B') ? r() : setTimeout(check, 10))
        check()
      })

      const joinedB = messages.find((m) => m.type === 'group-joined' && m.groupId === 'group-B')
      assert.ok(joinedB && joinedB.type === 'group-joined')
      assert.equal(joinedB.groupId, 'group-B')
      assert.equal(joinedB.peers.length, 1)
      assert.equal(joinedB.peers[0].peerId, peerId)
      assert.equal(joinedB.peers[0].sessionId, sessionId)
      const membershipIdB = joinedB.membershipId
      assert.ok(membershipIdB)

      // Membership IDs must be distinct across groups!
      assert.notEqual(membershipIdA, membershipIdB)

      // Duplicate join to group A is idempotent and returns current membership
      ws.send(JSON.stringify({ v: 2, type: 'join-group', groupId: 'group-A', token: tokenA, supernodeEligible: true }))
      await new Promise<void>((r) => {
        const count = messages.filter((m) => m.type === 'group-joined' && m.groupId === 'group-A').length
        const check = () => (messages.filter((m) => m.type === 'group-joined' && m.groupId === 'group-A').length > count ? r() : setTimeout(check, 10))
        check()
      })
      const secondJoinedA = messages.filter((m) => m.type === 'group-joined' && m.groupId === 'group-A').pop()
      assert.ok(secondJoinedA && secondJoinedA.type === 'group-joined')
      assert.equal(secondJoinedA.membershipId, membershipIdA)
    } finally {
      ws.close()
      await server.close()
    }
  })

  it('isolates rosters between unrelated groups (events in A do not leak to B)', async () => {
    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups
    })

    // Client 1 joins Group A only
    const ws1 = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    })
    // Client 2 joins Group B only
    const ws2 = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`, {
      headers: { Authorization: `Bearer ${tokenB}` }
    })

    try {
      await Promise.all([
        new Promise<void>((r) => ws1.on('open', r)),
        new Promise<void>((r) => ws2.on('open', r))
      ])

      const msgs1: ServerSignalingMessageV2[] = []
      const msgs2: ServerSignalingMessageV2[] = []
      ws1.on('message', (d) => msgs1.push(JSON.parse(d.toString('utf-8'))))
      ws2.on('message', (d) => msgs2.push(JSON.parse(d.toString('utf-8'))))

      ws1.send(JSON.stringify({ v: 2, type: 'register', peerId: randomUUID(), displayName: 'Peer1' }))
      ws2.send(JSON.stringify({ v: 2, type: 'register', peerId: randomUUID(), displayName: 'Peer2' }))

      await new Promise<void>((r) => {
        const check = () => (msgs1.some((m) => m.type === 'welcome') && msgs2.some((m) => m.type === 'welcome') ? r() : setTimeout(check, 10))
        check()
      })

      ws1.send(JSON.stringify({ v: 2, type: 'join-group', groupId: 'group-A', token: tokenA, supernodeEligible: true }))
      ws2.send(JSON.stringify({ v: 2, type: 'join-group', groupId: 'group-B', token: tokenB, supernodeEligible: true }))

      await new Promise<void>((r) => {
        const check = () => (msgs1.some((m) => m.type === 'group-joined') && msgs2.some((m) => m.type === 'group-joined') ? r() : setTimeout(check, 10))
        check()
      })

      // Client 3 joins Group A: must trigger roster on Client 1, but Client 2 must receive NOTHING from Group A
      const ws3 = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`, {
        headers: { Authorization: `Bearer ${tokenA}` }
      })
      await new Promise<void>((r) => ws3.on('open', r))
      ws3.send(JSON.stringify({ v: 2, type: 'register', peerId: randomUUID(), displayName: 'Peer3' }))
      await new Promise((r) => setTimeout(r, 50))
      ws3.send(JSON.stringify({ v: 2, type: 'join-group', groupId: 'group-A', token: tokenA, supernodeEligible: true }))

      // Wait for Client 1 to receive updated roster for group A
      await new Promise<void>((r) => {
        const check = () => (msgs1.some((m) => m.type === 'roster' && m.groupId === 'group-A') ? r() : setTimeout(check, 10))
        check()
      })

      // Verify Client 2 (in Group B) received zero messages for Group A
      assert.equal(msgs2.some((m) => 'groupId' in m && m.groupId === 'group-A'), false)

      ws3.close()
    } finally {
      ws1.close()
      ws2.close()
      await server.close()
    }
  })

  it('scoped invalid token and leave do not affect other active memberships on same socket', async () => {
    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups
    })

    const ws = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    })

    try {
      await new Promise<void>((r) => ws.on('open', r))
      const messages: ServerSignalingMessageV2[] = []
      ws.on('message', (d) => messages.push(JSON.parse(d.toString('utf-8'))))

      ws.send(JSON.stringify({ v: 2, type: 'register', peerId: randomUUID(), displayName: 'Alice' }))
      await new Promise<void>((r) => {
        const check = () => (messages.some((m) => m.type === 'welcome') ? r() : setTimeout(check, 10))
        check()
      })

      // Join Group A
      ws.send(JSON.stringify({ v: 2, type: 'join-group', groupId: 'group-A', token: tokenA, supernodeEligible: true }))
      await new Promise<void>((r) => {
        const check = () => (messages.some((m) => m.type === 'group-joined' && m.groupId === 'group-A') ? r() : setTimeout(check, 10))
        check()
      })

      // Attempt to join Group B with wrong token
      ws.send(JSON.stringify({ v: 2, type: 'join-group', groupId: 'group-B', token: 'wrong-token-value', supernodeEligible: true }))
      await new Promise<void>((r) => {
        const check = () => (messages.some((m) => m.type === 'error' && m.groupId === 'group-B') ? r() : setTimeout(check, 10))
        check()
      })

      const errB = messages.find((m) => m.type === 'error' && m.groupId === 'group-B')
      assert.ok(errB && errB.type === 'error')
      assert.equal(errB.code, 'AUTH_FAILED')
      // Socket remains OPEN and Group A membership is intact!
      assert.equal(ws.readyState, WebSocket.OPEN)

      // Leave Group A
      ws.send(JSON.stringify({ v: 2, type: 'leave-group', groupId: 'group-A' }))
      await new Promise<void>((r) => {
        const check = () => (messages.some((m) => m.type === 'group-left' && m.groupId === 'group-A') ? r() : setTimeout(check, 10))
        check()
      })
      // Socket remains OPEN!
      assert.equal(ws.readyState, WebSocket.OPEN)
    } finally {
      ws.close()
      await server.close()
    }
  })

  it('forwards signals strictly when both peers share group and target session matches', async () => {
    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups
    })

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

      const msgs1: ServerSignalingMessageV2[] = []
      const msgs2: ServerSignalingMessageV2[] = []
      ws1.on('message', (d) => msgs1.push(JSON.parse(d.toString('utf-8'))))
      ws2.on('message', (d) => msgs2.push(JSON.parse(d.toString('utf-8'))))

      const peer1 = randomUUID()
      const peer2 = randomUUID()
      ws1.send(JSON.stringify({ v: 2, type: 'register', peerId: peer1, displayName: 'P1' }))
      ws2.send(JSON.stringify({ v: 2, type: 'register', peerId: peer2, displayName: 'P2' }))

      await new Promise<void>((r) => {
        const check = () => (msgs1.some((m) => m.type === 'welcome') && msgs2.some((m) => m.type === 'welcome') ? r() : setTimeout(check, 10))
        check()
      })
      const welcome2 = msgs2.find((m) => m.type === 'welcome')
      assert.ok(welcome2 && welcome2.type === 'welcome')
      const sess2 = welcome2.sessionId
      // Both join Group A
      ws1.send(JSON.stringify({ v: 2, type: 'join-group', groupId: 'group-A', token: tokenA, supernodeEligible: true }))
      ws2.send(JSON.stringify({ v: 2, type: 'join-group', groupId: 'group-A', token: tokenA, supernodeEligible: true }))

      await new Promise<void>((r) => {
        const check = () => (msgs1.some((m) => m.type === 'group-joined') && msgs2.some((m) => m.type === 'group-joined') ? r() : setTimeout(check, 10))
        check()
      })

      // P1 sends signal to P2 with matching targetSessionId
      const connId = randomUUID()
      ws1.send(
        JSON.stringify({
          v: 2,
          type: 'signal',
          groupId: 'group-A',
          targetPeerId: peer2,
          targetSessionId: sess2,
          connectionId: connId,
          kind: 'request-offer',
          payload: null
        })
      )

      await new Promise<void>((r) => {
        const check = () => (msgs2.some((m) => m.type === 'signal') ? r() : setTimeout(check, 10))
        check()
      })

      const sig2 = msgs2.find((m) => m.type === 'signal')
      assert.ok(sig2 && sig2.type === 'signal')
      assert.equal(sig2.fromPeerId, peer1)
      assert.equal(sig2.kind, 'request-offer')

      // Signal with stale targetSessionId is dropped
      ws1.send(
        JSON.stringify({
          v: 2,
          type: 'signal',
          groupId: 'group-A',
          targetPeerId: peer2,
          targetSessionId: randomUUID(), // stale!
          connectionId: connId,
          kind: 'request-offer',
          payload: null
        })
      )
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(msgs2.filter((m) => m.type === 'signal').length, 1) // no new signal received
    } finally {
      ws1.close()
      ws2.close()
      await server.close()
    }
  })

  it('cleans up all memberships across multiple groups on socket disconnect', async () => {
    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups
    })

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

      const msgs2: ServerSignalingMessageV2[] = []
      ws2.on('message', (d) => msgs2.push(JSON.parse(d.toString('utf-8'))))

      const peer1 = randomUUID()
      const peer2 = randomUUID()
      ws1.send(JSON.stringify({ v: 2, type: 'register', peerId: peer1, displayName: 'P1' }))
      ws2.send(JSON.stringify({ v: 2, type: 'register', peerId: peer2, displayName: 'P2' }))
      await new Promise((r) => setTimeout(r, 40))

      // Both join Group A and Group B
      ws1.send(JSON.stringify({ v: 2, type: 'join-group', groupId: 'group-A', token: tokenA, supernodeEligible: true }))
      ws1.send(JSON.stringify({ v: 2, type: 'join-group', groupId: 'group-B', token: tokenB, supernodeEligible: true }))
      ws2.send(JSON.stringify({ v: 2, type: 'join-group', groupId: 'group-A', token: tokenA, supernodeEligible: true }))
      ws2.send(JSON.stringify({ v: 2, type: 'join-group', groupId: 'group-B', token: tokenB, supernodeEligible: true }))

      // Wait for P2 to see both groups joined with 2 members
      await new Promise<void>((resolve, reject) => {
        const start = Date.now()
        const check = () => {
          const hasA = msgs2.some((m) => (m.type === 'group-joined' || m.type === 'roster') && m.groupId === 'group-A' && m.peers.length === 2)
          const hasB = msgs2.some((m) => (m.type === 'group-joined' || m.type === 'roster') && m.groupId === 'group-B' && m.peers.length === 2)
          if (hasA && hasB) {
            resolve()
          } else if (Date.now() - start > 5000) {
            reject(new Error('Timeout waiting for P2 to join groups A and B with 2 peers'))
          } else {
            setTimeout(check, 10)
          }
        }
        check()
      })

      // Now P1 disconnects
      ws1.close()

      // Wait for P2 to receive updated rosters with 1 member for BOTH Group A and Group B
      await new Promise<void>((resolve, reject) => {
        const start = Date.now()
        const check = () => {
          const latestA = msgs2.filter((m) => m.type === 'roster' && m.groupId === 'group-A').pop()
          const latestB = msgs2.filter((m) => m.type === 'roster' && m.groupId === 'group-B').pop()
          if (latestA && latestA.type === 'roster' && latestA.peers.length === 1 &&
              latestB && latestB.type === 'roster' && latestB.peers.length === 1) {
            resolve()
          } else if (Date.now() - start > 5000) {
            reject(new Error('Timeout waiting for P2 to receive updated rosters with 1 peer after P1 disconnect'))
          } else {
            setTimeout(check, 10)
          }
        }
        check()
      })

      const finalA = msgs2.filter((m) => m.type === 'roster' && m.groupId === 'group-A').pop()
      const finalB = msgs2.filter((m) => m.type === 'roster' && m.groupId === 'group-B').pop()
      assert.ok(finalA && finalA.type === 'roster')
      assert.ok(finalB && finalB.type === 'roster')
      assert.equal(finalA.peers[0].peerId, peer2)
      assert.equal(finalB.peers[0].peerId, peer2)
    } finally {
      ws1.close()
      ws2.close()
      await server.close()
    }
  })
})
