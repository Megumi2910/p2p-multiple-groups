import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSignalingServer } from '../services/signaling/server.ts'
import {
  calculatePeerRole,
  electSupernodes,
  RecoveryEventRingBuffer,
  selectSupernodesForPeer
} from '../src/main/p2p/election.ts'
import type { SignalingRosterPeer } from '../src/shared/p2p-wire.ts'
import type { P2pState } from '../src/shared/p2p.ts'

describe('Supernode Election & Recovery Logic', () => {
  it('elects the first two eligible peers deterministically by joinOrder then peerId', () => {
    const peers: SignalingRosterPeer[] = [
      { peerId: 'p3', sessionId: 's3', joinOrder: 3, displayName: 'P3', supernodeEligible: true },
      { peerId: 'p1', sessionId: 's1', joinOrder: 1, displayName: 'P1', supernodeEligible: true },
      { peerId: 'p2', sessionId: 's2', joinOrder: 2, displayName: 'P2', supernodeEligible: false }, // opted out
      { peerId: 'p4', sessionId: 's4', joinOrder: 4, displayName: 'P4', supernodeEligible: true }
    ]

    const result = electSupernodes(peers)
    assert.equal(result.electedSupernodes.length, 2)
    assert.equal(result.electedSupernodes[0].peerId, 'p1')
    assert.equal(result.electedSupernodes[1].peerId, 'p3')
    assert.equal(result.eligibleCandidates.length, 1)
    assert.equal(result.eligibleCandidates[0].peerId, 'p4')

    assert.equal(calculatePeerRole('p1', result.electedSupernodes), 'supernode')
    assert.equal(calculatePeerRole('p3', result.electedSupernodes), 'supernode')
    assert.equal(calculatePeerRole('p4', result.electedSupernodes), 'ordinary')
    assert.equal(calculatePeerRole('p2', result.electedSupernodes), 'ordinary')
  })

  it('selects primary and standby supernodes for ordinary peers deterministically', () => {
    const supernodes: SignalingRosterPeer[] = [
      { peerId: 'sn-alpha', sessionId: 's1', joinOrder: 1, displayName: 'Alpha', supernodeEligible: true },
      { peerId: 'sn-beta', sessionId: 's2', joinOrder: 2, displayName: 'Beta', supernodeEligible: true }
    ]

    const sel1 = selectSupernodesForPeer('client-1', supernodes)
    const sel2 = selectSupernodesForPeer('client-1', supernodes)
    assert.ok(sel1.primary)
    assert.ok(sel1.standby)
    assert.equal(sel1.primary?.peerId, sel2.primary?.peerId)
    assert.equal(sel1.standby?.peerId, sel2.standby?.peerId)
    assert.notEqual(sel1.primary?.peerId, sel1.standby?.peerId)
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
    const roomId = `room-${randomUUID().slice(0, 8)}`
    const token = Buffer.alloc(32, 8).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      roomId,
      token
    })

    const signalUrl = `ws://127.0.0.1:${server.address.port}/signal`
    const childDirs: string[] = []
    const children: ChildProcess[] = []
    interface PeerHarness {
      child: ChildProcess
      dataDir: string
      name: string
      state: P2pState | null
      waitForState(predicate: (state: P2pState) => boolean, timeoutMs?: number): Promise<P2pState>
    }

    const peers: PeerHarness[] = []

    async function spawnPeer(name: string, notEligible = false): Promise<PeerHarness> {
      const dir = await mkdtemp(join(tmpdir(), `kazaa-peer-${name}-`))
      childDirs.push(dir)

      const args = [
        `--data-dir=${dir}`,
        `--signaling-url=${signalUrl}`,
        `--room-id=${roomId}`,
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
          const { promise, resolve, reject } = Promise.withResolvers<P2pState>()
          // Real-time safety deadline: bounding child-process IPC events across independent Node processes
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
              harness.state = m.state as P2pState
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
          harness.state = m.state as P2pState
        }
      })

      return harness
    }

    try {
      // 1. Spawn 5 real peer processes sequentially
      const p1 = await spawnPeer('Peer1')
      peers.push(p1)
      await p1.waitForState((s) => s.network.status === 'connected')

      const p2 = await spawnPeer('Peer2')
      peers.push(p2)
      await p2.waitForState((s) => s.network.status === 'connected')

      const p3 = await spawnPeer('Peer3')
      peers.push(p3)
      await p3.waitForState((s) => s.network.status === 'connected')

      const p4 = await spawnPeer('Peer4')
      peers.push(p4)
      await p4.waitForState((s) => s.network.status === 'connected')

      const p5 = await spawnPeer('Peer5')
      peers.push(p5)
      await p5.waitForState((s) => s.network.status === 'connected')

      // 2. Wait for all 5 to see a complete 5-member roster
      await Promise.all(peers.map((p) => p.waitForState((s) => s.network.members.length === 5)))

      // Verify roles: Peer1 and Peer2 must be supernodes; Peer3, Peer4, Peer5 must be ordinary
      assert.equal(p1.state?.network.role, 'supernode')
      assert.equal(p2.state?.network.role, 'supernode')
      assert.equal(p3.state?.network.role, 'ordinary')
      assert.equal(p4.state?.network.role, 'ordinary')
      assert.equal(p5.state?.network.role, 'ordinary')

      // Ordinary peers have selected primary and standby
      assert.ok(p3.state?.network.primaryPeerId)
      assert.ok(p3.state?.network.standbyPeerId)

      // 3. Abruptly kill Peer 1 without sending leave
      p1.child.kill('SIGKILL')

      // 4. Observe survivors: Peer 1 evicted within lease bound, roster drops to 4
      // Peer 3 must automatically become supernode!
      await Promise.all([
        p2.waitForState((s) => s.network.members.length === 4),
        p3.waitForState((s) => s.network.members.length === 4 && s.network.role === 'supernode'),
        p4.waitForState((s) => s.network.members.length === 4),
        p5.waitForState((s) => s.network.members.length === 4)
      ])

      assert.equal(p2.state?.network.role, 'supernode')
      assert.equal(p3.state?.network.role, 'supernode')
      assert.equal(p4.state?.network.role, 'ordinary')
      assert.equal(p5.state?.network.role, 'ordinary')

      // Check recovery events on Peer 3
      const p3Events = p3.state?.recoveryEvents || []
      assert.ok(p3Events.some((e) => e.type === 'role-changed' || e.type === 'supernode-lost'))

      // 5. Rejoin Peer 1 with its same data directory: receives a new joinOrder
      // Must NOT displace Peer 2 or Peer 3!
      const p1Rejoined = await spawnPeer('Peer1-Rejoined')
      peers.push(p1Rejoined)
      await p1Rejoined.waitForState((s) => s.network.status === 'connected')

      await Promise.all([
        p2.waitForState((s) => s.network.members.length === 5),
        p3.waitForState((s) => s.network.members.length === 5),
        p1Rejoined.waitForState((s) => s.network.members.length === 5)
      ])
      assert.equal(p2.state?.network.role, 'supernode')
      assert.equal(p3.state?.network.role, 'supernode')
      assert.equal(p1Rejoined.state?.network.role, 'ordinary')
    } finally {
      // Clean up all children
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
