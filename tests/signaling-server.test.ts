import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { createSignalingServer } from '../services/signaling/server.ts'
import type { ServerSignalingMessage } from '../src/shared/p2p-wire.ts'

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
