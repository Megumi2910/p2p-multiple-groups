import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createSignalingServer } from '../services/signaling/server.ts'
import { SignalingClient } from '../src/main/p2p/signaling-client.ts'

describe('SignalingClient Lifecycle & Multi-Group Multiplexing', () => {
  const tokenA = Buffer.alloc(32, 31).toString('base64url')
  const tokenB = Buffer.alloc(32, 32).toString('base64url')
  const groups = [
    { groupId: 'group-A', token: tokenA },
    { groupId: 'group-B', token: tokenB }
  ]

  it('registers identity, receives welcome and iceConfig, and joins groups independently', async () => {
    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups
    })

    const peerId = randomUUID()
    const client = new SignalingClient({
      signalingUrl: `ws://127.0.0.1:${server.address.port}/signal`,
      peerId,
      displayName: 'Alice',
      callbacks: {}
    })

    try {
      const joinedA = await client.joinGroup('group-A', tokenA, true)
      assert.equal(joinedA.groupId, 'group-A')
      assert.ok(joinedA.membershipId)
      assert.ok(client.getSessionId())

      const joinedB = await client.joinGroup('group-B', tokenB, false)
      assert.equal(joinedB.groupId, 'group-B')
      assert.ok(joinedB.membershipId)
      assert.notEqual(joinedA.membershipId, joinedB.membershipId)

      // Re-joining same group is idempotent and resolves with current membership
      const joinedA2 = await client.joinGroup('group-A', tokenA, true)
      assert.equal(joinedA2.membershipId, joinedA.membershipId)
    } finally {
      client.dispose()
      await server.close()
    }
  })

  it('leaves group cleanly and rejects invalid group token without crashing client', async () => {
    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups
    })

    const peerId = randomUUID()
    const client = new SignalingClient({
      signalingUrl: `ws://127.0.0.1:${server.address.port}/signal`,
      peerId,
      displayName: 'Bob',
      callbacks: {}
    })

    try {
      await client.joinGroup('group-A', tokenA, true)

      // Join with bad token fails with AUTH_FAILED
      await assert.rejects(
        () => client.joinGroup('group-B', 'wrong-token-value', false),
        (err: Error) => err.message.includes('AUTH_FAILED')
      )

      // Group A remains functional
      await client.leaveGroup('group-A')
    } finally {
      client.dispose()
      await server.close()
    }
  })

  it('re-joins desired groups automatically across server restart', async () => {
    let server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups
    })
    const port = server.address.port

    const peerId = randomUUID()
    const { promise: rejoinPromise, resolve: resolveRejoin, reject: rejectRejoin } = Promise.withResolvers<string>()
    const rejoinTimeout = setTimeout(() => {
      rejectRejoin(new Error('Timeout waiting for automatic group rejoin after restart'))
    }, 10000)

    let rejoinCount = 0
    const client = new SignalingClient({
      signalingUrl: `ws://127.0.0.1:${port}/signal`,
      peerId,
      displayName: 'Charlie',
      callbacks: {
        onGroupJoined: (msg) => {
          rejoinCount++
          if (rejoinCount >= 2) {
            clearTimeout(rejoinTimeout)
            resolveRejoin(msg.membershipId)
          }
        }
      }
    })

    try {
      const initialJoin = await client.joinGroup('group-A', tokenA, true)
      assert.ok(initialJoin.membershipId)

      // Restart server on same port
      await server.close()

      server = await createSignalingServer({
        host: '127.0.0.1',
        port,
        groups
      })

      // Client should automatically reconnect and receive group-joined with new membershipId
      const newMembershipId = await rejoinPromise
      assert.ok(newMembershipId)
      assert.notEqual(newMembershipId, initialJoin.membershipId)
    } finally {
      client.dispose()
      await server.close()
    }
  })
})
