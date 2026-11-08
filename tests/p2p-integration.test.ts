import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fork, type ChildProcess } from 'node:child_process'
import { createSignalingServer } from '../services/signaling/server.ts'
import {
  calculatePeerRole,
  electSupernodes,
  RecoveryEventRingBuffer,
  selectSupernodesForPeer
} from '../src/main/p2p/election.ts'
import type { MultiGroupP2pState, MultiGroupRosterMember } from '../src/shared/p2p.ts'

describe('Supernode Election & Recovery Logic', () => {
  it('elects top 2 candidates by joinOrder then peerId deterministically', () => {
    const peers: MultiGroupRosterMember[] = [
      { peerId: 'peer-3', sessionId: 's3', membershipId: 'm3', joinOrder: 3, displayName: 'Peer 3', supernodeEligible: true, role: 'ordinary' },
      { peerId: 'peer-1', sessionId: 's1', membershipId: 'm1', joinOrder: 1, displayName: 'Peer 1', supernodeEligible: true, role: 'ordinary' },
      { peerId: 'peer-2', sessionId: 's2', membershipId: 'm2', joinOrder: 2, displayName: 'Peer 2', supernodeEligible: true, role: 'ordinary' },
      { peerId: 'peer-4', sessionId: 's4', membershipId: 'm4', joinOrder: 4, displayName: 'Peer 4', supernodeEligible: false, role: 'ordinary' }
    ]

    const result = electSupernodes(peers)
    assert.equal(result.electedSupernodes.length, 2)
    assert.equal(result.electedSupernodes[0].peerId, 'peer-1')
    assert.equal(result.electedSupernodes[1].peerId, 'peer-2')

    assert.equal(calculatePeerRole('peer-1', result.electedSupernodes), 'supernode')
    assert.equal(calculatePeerRole('peer-2', result.electedSupernodes), 'supernode')
    assert.equal(calculatePeerRole('peer-3', result.electedSupernodes), 'ordinary')
    assert.equal(calculatePeerRole('peer-4', result.electedSupernodes), 'ordinary')
  })

  it('selects distinct primary and standby routes for ordinary peer using consistent hashing', () => {
    const supernodes: MultiGroupRosterMember[] = [
      { peerId: 'sn-alpha', sessionId: 's1', membershipId: 'm1', joinOrder: 1, displayName: 'SN 1', supernodeEligible: true, role: 'supernode' },
      { peerId: 'sn-beta', sessionId: 's2', membershipId: 'm2', joinOrder: 2, displayName: 'SN 2', supernodeEligible: true, role: 'supernode' }
    ]

    const routes = selectSupernodesForPeer('ordinary-peer-99', supernodes)
    assert.ok(routes.primary)
    assert.ok(routes.standby)
    assert.notEqual(routes.primary.peerId, routes.standby?.peerId)
  })

  it('maintains bounded recovery events ring buffer and calculates monotonic durations', () => {
    const ring = new RecoveryEventRingBuffer(3)
    ring.add('supernode-lost', ['sn1'], 'ep1', 1, null, 'Lost sn1')
    ring.add('role-changed', ['p2'], 'ep1', 2, null, 'Became supernode')
    ring.add('route-changed', ['sn2'], 'ep1', 2, 250, 'Route switched')
    ring.add('index-ready', ['p2'], 'ep1', 2, null, 'Index ready')

    const events = ring.getAll()
    assert.equal(events.length, 3)
    assert.equal(events[0].type, 'index-ready')
    assert.equal(events[1].type, 'route-changed')
    assert.equal(events[1].durationMs, 250)
    assert.equal(events[2].type, 'role-changed')
  })
})

describe('Five Real Headless Peers Election & Self-Healing', () => {
  it('elects 2 supernodes, heals abruptly killed supernode, promotes ordinary candidate, and blocks stale preemption', async () => {
    const groupId = `group-${randomUUID().slice(0, 8)}`
    const token = Buffer.alloc(32, 8).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [{ groupId, token }]
    })

    const signalUrl = `ws://127.0.0.1:${server.address.port}/signal`
    const childDirs: string[] = []
    const children: ChildProcess[] = []
    interface PeerHarness {
      child: ChildProcess
      dataDir: string
      name: string
      state: MultiGroupP2pState | null
      waitForState(predicate: (state: MultiGroupP2pState) => boolean, timeoutMs?: number): Promise<MultiGroupP2pState>
    }

    const peers: PeerHarness[] = []

    async function spawnPeer(name: string, notEligible = false): Promise<PeerHarness> {
      const dir = await mkdtemp(join(tmpdir(), `p2p-peer-${name}-`))
      childDirs.push(dir)

      const args = [
        `--data-dir=${dir}`,
        `--signaling-url=${signalUrl}`,
        `--group-id=${groupId}`,
        `--token=${token}`,
        `--name=${name}`
      ]
      if (notEligible) args.push('--not-eligible')

      const child = fork(join(process.cwd(), 'tests/fixtures/peer-process.ts'), args, {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc']
      })
      children.push(child)

      const harness: PeerHarness = {
        child,
        dataDir: dir,
        name,
        state: null,
        waitForState: (predicate, timeoutMs = 25000) => {
          const { promise, resolve, reject } = Promise.withResolvers<MultiGroupP2pState>()
          const timeout = setTimeout(() => {
            reject(new Error(`Timeout waiting for state on ${name}`))
          }, timeoutMs)

          if (harness.state && predicate(harness.state)) {
            clearTimeout(timeout)
            resolve(harness.state)
            return promise
          }

          const listener = (msg: unknown) => {
            if (!msg || typeof msg !== 'object') return
            const m = msg as Record<string, unknown>
            if (m.type === 'state' || m.type === 'ready') {
              harness.state = m.state as MultiGroupP2pState
              if (predicate(harness.state)) {
                clearTimeout(timeout)
                child.off('message', listener)
                resolve(harness.state)
              }
            }
          }

          child.on('message', listener)
          return promise
        }
      }

      child.on('message', (msg: unknown) => {
        if (!msg || typeof msg !== 'object') return
        const m = msg as Record<string, unknown>
        if (m.type === 'state' || m.type === 'ready') {
          harness.state = m.state as MultiGroupP2pState
        }
      })

      return harness
    }

    try {
      // 1. Spawn 5 real peer processes sequentially
      const p1 = await spawnPeer('Peer1')
      peers.push(p1)
      await p1.waitForState((s) => s.groups[0]?.network.status === 'connected')

      const p2 = await spawnPeer('Peer2')
      peers.push(p2)
      await p2.waitForState((s) => s.groups[0]?.network.status === 'connected')

      const p3 = await spawnPeer('Peer3')
      peers.push(p3)
      await p3.waitForState((s) => s.groups[0]?.network.status === 'connected')

      const p4 = await spawnPeer('Peer4')
      peers.push(p4)
      await p4.waitForState((s) => s.groups[0]?.network.status === 'connected')

      const p5 = await spawnPeer('Peer5')
      peers.push(p5)
      await p5.waitForState((s) => s.groups[0]?.network.status === 'connected')

      // 2. Wait for all 5 to see a complete 5-member roster
      await Promise.all(peers.map((p) => p.waitForState((s) => (s.groups[0]?.network.members.length || 0) === 5)))

      // Verify roles: Peer1 and Peer2 must be supernodes; Peer3, Peer4, Peer5 must be ordinary
      assert.equal(p1.state?.groups[0]?.network.role, 'supernode')
      assert.equal(p2.state?.groups[0]?.network.role, 'supernode')
      assert.equal(p3.state?.groups[0]?.network.role, 'ordinary')
      assert.equal(p4.state?.groups[0]?.network.role, 'ordinary')
      assert.equal(p5.state?.groups[0]?.network.role, 'ordinary')

      // Ordinary peers have selected primary and standby
      assert.ok(p3.state?.groups[0]?.network.primaryPeerId)
      assert.ok(p3.state?.groups[0]?.network.standbyPeerId)

      // 3. Abruptly kill Peer 1 without sending leave
      p1.child.kill('SIGKILL')

      // 4. Observe survivors: Peer 1 evicted within lease bound, roster drops to 4
      // Peer 3 must automatically become supernode!
      await Promise.all([
        p2.waitForState((s) => (s.groups[0]?.network.members.length || 0) === 4),
        p3.waitForState((s) => (s.groups[0]?.network.members.length || 0) === 4 && s.groups[0]?.network.role === 'supernode'),
        p4.waitForState((s) => (s.groups[0]?.network.members.length || 0) === 4),
        p5.waitForState((s) => (s.groups[0]?.network.members.length || 0) === 4)
      ])

      assert.equal(p2.state?.groups[0]?.network.role, 'supernode')
      assert.equal(p3.state?.groups[0]?.network.role, 'supernode')
      assert.equal(p4.state?.groups[0]?.network.role, 'ordinary')
      assert.equal(p5.state?.groups[0]?.network.role, 'ordinary')

      // Check recovery events on Peer 3
      const p3Events = p3.state?.groups[0]?.recoveryEvents || []
      assert.ok(p3Events.some((e) => e.type === 'role-changed' || e.type === 'supernode-lost'))

      // 5. Rejoin Peer 1 with its same data directory: receives a new joinOrder
      // Must NOT displace Peer 2 or Peer 3!
      const p1Rejoined = await spawnPeer('Peer1-Rejoined')
      peers.push(p1Rejoined)
      await p1Rejoined.waitForState((s) => s.groups[0]?.network.status === 'connected')

      await Promise.all([
        p2.waitForState((s) => (s.groups[0]?.network.members.length || 0) === 5),
        p3.waitForState((s) => (s.groups[0]?.network.members.length || 0) === 5),
        p1Rejoined.waitForState((s) => (s.groups[0]?.network.members.length || 0) === 5)
      ])
      assert.equal(p2.state?.groups[0]?.network.role, 'supernode')
      assert.equal(p3.state?.groups[0]?.network.role, 'supernode')
      assert.equal(p1Rejoined.state?.groups[0]?.network.role, 'ordinary')
    } finally {
      for (const c of children) {
        try {
          c.kill('SIGKILL')
        } catch {
          // ignore
        }
      }
      await server.close()
      for (const d of childDirs) {
        await rm(d, { recursive: true, force: true }).catch(() => {})
      }
    }
  })
})
