import { createHash, randomUUID } from 'node:crypto'
import type { SignalingRosterPeer } from '../../shared/p2p-wire.ts'
import type { P2pRecoveryEvent, P2pRecoveryEventType, P2pRole } from '../../shared/p2p.ts'

export interface ElectionResult {
  electedSupernodes: SignalingRosterPeer[]
  eligibleCandidates: SignalingRosterPeer[]
}

export function electSupernodes(peers: readonly SignalingRosterPeer[]): ElectionResult {
  const eligible = peers.filter((p) => p.supernodeEligible)
  // Sort ascending by joinOrder, then lexical peerId
  eligible.sort((a, b) => {
    if (a.joinOrder !== b.joinOrder) {
      return a.joinOrder - b.joinOrder
    }
    return a.peerId.localeCompare(b.peerId)
  })

  return {
    electedSupernodes: eligible.slice(0, 2),
    eligibleCandidates: eligible.slice(2)
  }
}

export function calculatePeerRole(
  peerId: string,
  electedSupernodes: readonly SignalingRosterPeer[]
): P2pRole {
  return electedSupernodes.some((s) => s.peerId === peerId) ? 'supernode' : 'ordinary'
}

export function selectSupernodesForPeer(
  peerId: string,
  electedSupernodes: readonly SignalingRosterPeer[]
): { primary: SignalingRosterPeer | null; standby: SignalingRosterPeer | null } {
  if (electedSupernodes.length === 0) {
    return { primary: null, standby: null }
  }
  if (electedSupernodes.length === 1) {
    return { primary: electedSupernodes[0], standby: null }
  }

  // 2 or more supernodes: calculate SHA-256 hex digest of (peerId + ':' + supernodeId)
  const scored = electedSupernodes.map((s) => {
    const hash = createHash('sha256').update(`${peerId}:${s.peerId}`).digest('hex')
    return { supernode: s, hash }
  })

  // Sort descending by hash; lexical supernode ID breaks ties
  scored.sort((a, b) => {
    if (a.hash !== b.hash) {
      return b.hash.localeCompare(a.hash)
    }
    return b.supernode.peerId.localeCompare(a.supernode.peerId)
  })

  return {
    primary: scored[0].supernode,
    standby: scored[1].supernode
  }
}

export class RecoveryEventRingBuffer {
  private readonly capacity: number
  private readonly events: P2pRecoveryEvent[] = []

  constructor(capacity = 100) {
    this.capacity = capacity
  }

  add(
    type: P2pRecoveryEventType,
    peerIds: string[],
    epoch: string | null,
    membershipRevision: number,
    durationMs: number | null,
    message: string
  ): P2pRecoveryEvent {
    const event: P2pRecoveryEvent = {
      id: randomUUID(),
      at: new Date().toISOString(),
      type,
      peerIds: [...peerIds],
      epoch,
      membershipRevision,
      durationMs,
      message
    }

    this.events.unshift(event)
    if (this.events.length > this.capacity) {
      this.events.pop()
    }

    return event
  }

  getAll(): P2pRecoveryEvent[] {
    return [...this.events]
  }

  clear(): void {
    this.events.length = 0
  }
}
