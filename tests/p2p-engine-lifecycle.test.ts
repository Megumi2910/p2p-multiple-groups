import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'
import type { ServerSignalingMessageV2 } from '../src/shared/p2p-wire.ts'
import { RTCPeerConnection, type RTCConfiguration } from 'werift'
import { createSignalingServer } from '../services/signaling/server.ts'
import { createPeerEngine, type PeerEngine } from '../src/main/p2p/engine.ts'
import { createCredentialStore, type CredentialStore } from '../src/main/p2p/credential-store.ts'
import { createMultiGroupPeerStore } from '../src/main/p2p/peer-store.ts'
import { TransportManager, type TransportEvents } from '../src/main/p2p/transport.ts'
import {
  makeGroupKey,
  type MultiGroupP2pState,
  type P2pGroupState
} from '../src/shared/p2p.ts'
function platformDelay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
  return promise
}

function findGroup(state: MultiGroupP2pState, groupKey: string): P2pGroupState | undefined {
  return state.groups.find((g) => g.groupKey === groupKey)
}

function waitForEngineState(
  engine: PeerEngine,
  predicate: (state: MultiGroupP2pState) => boolean,
  timeoutMs = 15000,
  label = 'state condition'
): Promise<MultiGroupP2pState> {
  const { promise, resolve, reject } = Promise.withResolvers<MultiGroupP2pState>()
  let done = false

  const timer = setTimeout(() => {
    if (!done) {
      done = true
      unsub()
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for: ${label}`))
    }
  }, timeoutMs)
  timer.unref?.()

  const check = (s: MultiGroupP2pState) => {
    if (done) return
    if (predicate(s)) {
      done = true
      clearTimeout(timer)
      unsub()
      resolve(s)
    }
  }

  const unsub = engine.subscribe(check)
  check(engine.getState())
  return promise
}

describe('P2P Engine Lifecycle & Endpoint Policy', () => {
  it('resumes multiple auto-join groups without initialization exceptions, handles delayed reads and failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'engine-init-'))
    const groupId1 = 'group-init-1'
    const groupId2 = 'group-init-2'
    const groupIdBad = 'group-init-bad'
    const token1 = Buffer.alloc(32, 11).toString('base64url')
    const token2 = Buffer.alloc(32, 12).toString('base64url')
    const tokenBad = Buffer.alloc(32, 13).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [
        { groupId: groupId1, token: token1 },
        { groupId: groupId2, token: token2 },
        { groupId: groupIdBad, token: tokenBad }
      ]
    })
    const signalingUrl = `ws://127.0.0.1:${server.address.port}/signal`
    const key1 = makeGroupKey(signalingUrl, groupId1)
    const key2 = makeGroupKey(signalingUrl, groupId2)
    const keyBad = makeGroupKey(signalingUrl, groupIdBad)

    // Pre-seed peer store with auto-join groups
    const peerStore = await createMultiGroupPeerStore(dir)
    await peerStore.upsertGroup({
      groupKey: key1,
      signalingUrl,
      groupId: groupId1,
      supernodeEligible: false,
      autoJoin: true,
      credentialCiphertext: null
    })
    await peerStore.upsertGroup({
      groupKey: key2,
      signalingUrl,
      groupId: groupId2,
      supernodeEligible: false,
      autoJoin: true,
      credentialCiphertext: null
    })
    await peerStore.upsertGroup({
      groupKey: keyBad,
      signalingUrl,
      groupId: groupIdBad,
      supernodeEligible: false,
      autoJoin: true,
      credentialCiphertext: null
    })

    const mockEncryption = {
      isAvailable: () => true,
      encrypt: (text: string) => Buffer.from(text.split('').reverse().join(''), 'utf-8'),
      decrypt: (buf: Buffer) => buf.toString('utf-8').split('').reverse().join('')
    }

    const baseCredStore = createCredentialStore({ dataDirectory: dir, mockEncryption })
    await baseCredStore.setCredential(key1, token1)
    await baseCredStore.setCredential(key2, token2)
    // Seed bad group with wrong token
    await baseCredStore.setCredential(keyBad, Buffer.alloc(32, 99).toString('base64url'))

    // Controlled credential store wrapper with paused read for key2
    const { promise: pausePromise, resolve: unpauseKey2 } = Promise.withResolvers<void>()
    const customCredStore: CredentialStore = {
      getCredential: async (groupKey: string) => {
        if (groupKey === key2) {
          await pausePromise
        }
        return baseCredStore.getCredential(groupKey)
      },
      setCredential: (k, t) => baseCredStore.setCredential(k, t),
      deleteCredential: (k) => baseCredStore.deleteCredential(k),
      clear: () => baseCredStore.clear()
    }

    let engine: PeerEngine | null = null
    try {
      // Release key 2 read after a turn of event loop so read is delayed
      queueMicrotask(() => {
        unpauseKey2()
      })

      // 1. Construct engine - must construct without throwing
      engine = await createPeerEngine({
        dataDirectory: dir,
        credentialStore: customCredStore
      })

      // Group runtimes exist in state
      const stateInit = engine.getState()
      assert.ok(findGroup(stateInit, key1), 'Group 1 runtime must exist')
      assert.ok(findGroup(stateInit, key2), 'Group 2 runtime must exist')
      assert.ok(findGroup(stateInit, keyBad), 'Group Bad runtime must exist')

      // 2. Both valid auto-join groups eventually reach connected
      await waitForEngineState(
        engine,
        (s) =>
          findGroup(s, key1)?.network.status === 'connected' &&
          findGroup(s, key2)?.network.status === 'connected',
        15000,
        'Group 1 and Group 2 auto-join connection'
      )

      // Bad group failed without preventing the valid groups from connecting
      const stateFinal = engine.getState()
      assert.equal(findGroup(stateFinal, key1)?.network.status, 'connected')
      assert.equal(findGroup(stateFinal, key2)?.network.status, 'connected')
      assert.notEqual(findGroup(stateFinal, keyBad)?.network.status, 'connected')

      await engine.dispose()
      engine = null

      // 3. Immediate disposal check: constructing and disposing immediately does not cause uncaught error
      const engineQuick = await createPeerEngine({
        dataDirectory: dir,
        credentialStore: baseCredStore
      })
      await engineQuick.dispose()
    } finally {
      if (engine) await engine.dispose()
      await server.close()
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('correctly handles memory-only rejoining, preserves other credentials, and does not erase on auth failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'engine-remember-'))
    const groupIdA = 'group-rem-A'
    const groupIdB = 'group-rem-B'
    const tokenA = Buffer.alloc(32, 21).toString('base64url')
    const tokenB = Buffer.alloc(32, 22).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [
        { groupId: groupIdA, token: tokenA },
        { groupId: groupIdB, token: tokenB }
      ]
    })
    const signalingUrl = `ws://127.0.0.1:${server.address.port}/signal`
    const keyA = makeGroupKey(signalingUrl, groupIdA)
    const keyB = makeGroupKey(signalingUrl, groupIdB)

    const mockEncryption = {
      isAvailable: () => true,
      encrypt: (text: string) => Buffer.from(text.split('').reverse().join(''), 'utf-8'),
      decrypt: (buf: Buffer) => buf.toString('utf-8').split('').reverse().join('')
    }
    const credStore = createCredentialStore({ dataDirectory: dir, mockEncryption })

    let engine: PeerEngine | null = null
    try {
      engine = await createPeerEngine({
        dataDirectory: dir,
        credentialStore: credStore
      })

      // 1. Join group A and group B with rememberInvitation: true
      const joinA1 = await engine.joinGroup({
        invitation: { version: 2, signalingUrl, groupId: groupIdA, token: tokenA },
        displayName: 'PeerA',
        supernodeEligible: false,
        relayOnly: false,
        rememberInvitation: true,
        autoJoin: true
      })
      assert.equal(joinA1.ok, true)

      const joinB = await engine.joinGroup({
        invitation: { version: 2, signalingUrl, groupId: groupIdB, token: tokenB },
        displayName: 'PeerB',
        supernodeEligible: false,
        relayOnly: false,
        rememberInvitation: true,
        autoJoin: true
      })
      assert.equal(joinB.ok, true)

      assert.equal(findGroup(engine.getState(), keyA)?.credentialStatus, 'stored')
      assert.equal(findGroup(engine.getState(), keyB)?.credentialStatus, 'stored')
      assert.equal(await credStore.getCredential(keyA), tokenA)
      assert.equal(await credStore.getCredential(keyB), tokenB)

      // 2. Rejoin group A with rememberInvitation: false (memory-only conversion)
      const joinA2 = await engine.joinGroup({
        invitation: { version: 2, signalingUrl, groupId: groupIdA, token: tokenA },
        displayName: 'PeerA',
        supernodeEligible: false,
        relayOnly: false,
        rememberInvitation: false,
        autoJoin: false
      })
      assert.equal(joinA2.ok, true)

      assert.equal(findGroup(engine.getState(), keyA)?.credentialStatus, 'memory')
      assert.equal(findGroup(engine.getState(), keyB)?.credentialStatus, 'stored')
      assert.equal(await credStore.getCredential(keyA), null, 'Group A credential must be deleted from store')
      assert.equal(await credStore.getCredential(keyB), tokenB, 'Group B credential must be retained')

      // Dispose and restart engine on same directory
      await engine.dispose()
      engine = null

      const engine2 = await createPeerEngine({
        dataDirectory: dir,
        credentialStore: credStore
      })
      engine = engine2

      const stateRestart = engine2.getState()
      assert.equal(findGroup(stateRestart, keyA)?.credentialStatus, 'required')
      assert.equal(findGroup(stateRestart, keyA)?.network.status, 'disconnected')
      assert.equal(findGroup(stateRestart, keyB)?.credentialStatus, 'stored')

      // Resuming group A without credential fails with INVITATION_REQUIRED
      const resumeA = await engine2.resumeGroup(keyA)
      assert.equal(resumeA.ok, false)
      assert.equal(resumeA.code, 'INVITATION_REQUIRED')

      // 3. Failed authenticated join does not erase old credentials
      const joinFailB = await engine2.joinGroup({
        invitation: { version: 2, signalingUrl, groupId: groupIdB, token: Buffer.alloc(32, 99).toString('base64url') },
        displayName: 'PeerB',
        supernodeEligible: false,
        relayOnly: false,
        rememberInvitation: true,
        autoJoin: true
      })
      assert.equal(joinFailB.ok, false)
      assert.equal(joinFailB.code, 'AUTH_FAILED')

      // Previous valid token for B is still intact in credential store
      assert.equal(await credStore.getCredential(keyB), tokenB)
    } finally {
      if (engine) await engine.dispose()
      await server.close()
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('enforces live relayOnly policy on new peer connections, rejects conflicting joins, and allows switching after disconnect', async () => {
    const dir1 = await mkdtemp(join(tmpdir(), 'engine-relay-1-'))
    const dir2 = await mkdtemp(join(tmpdir(), 'engine-relay-2-'))
    const groupIdA = 'group-relay-A'
    const groupIdB = 'group-relay-B'
    const tokenA = Buffer.alloc(32, 31).toString('base64url')
    const tokenB = Buffer.alloc(32, 32).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [
        { groupId: groupIdA, token: tokenA },
        { groupId: groupIdB, token: tokenB }
      ]
    })
    const signalingUrl = `ws://127.0.0.1:${server.address.port}/signal`

    const mockEncryption = {
      isAvailable: () => true,
      encrypt: (text: string) => Buffer.from(text.split('').reverse().join(''), 'utf-8'),
      decrypt: (buf: Buffer) => buf.toString('utf-8').split('').reverse().join('')
    }

    let resolvePc1: (() => void) | null = null
    let resolvePc2: (() => void) | null = null
    const createdPcs3: RTCPeerConnection[] = []
    const recordedPolicies1: ('relay' | 'all')[] = []
    const transportFactory1 = (url: string, events: TransportEvents) =>
      new TransportManager(events, {
        connectionFactory: (config) => {
          const rtcConfig = config as RTCConfiguration
          recordedPolicies1.push(rtcConfig.iceTransportPolicy || 'all')
          if (resolvePc1) {
            resolvePc1()
            resolvePc1 = null
          }
          if (resolvePc2) {
            resolvePc2()
            resolvePc2 = null
          }
          const loopbackConfig = { ...config, iceServers: [] }
          const pc = new RTCPeerConnection(loopbackConfig as unknown as object)
          createdPcs3.push(pc)
          return pc
        }
      })
    const transportFactory2 = (url: string, events: TransportEvents) =>
      new TransportManager(events, {
        connectionFactory: (config) => {
          const loopbackConfig = { ...config, iceServers: [] }
          const pc = new RTCPeerConnection(loopbackConfig as unknown as object)
          createdPcs3.push(pc)
          return pc
        }
      })

    let engine1: PeerEngine | null = null
    let engine2: PeerEngine | null = null
    try {
      engine1 = await createPeerEngine({
        dataDirectory: dir1,
        credentialStore: createCredentialStore({ dataDirectory: dir1, mockEncryption }),
        transportFactory: transportFactory1
      })
      engine2 = await createPeerEngine({
        dataDirectory: dir2,
        credentialStore: createCredentialStore({ dataDirectory: dir2, mockEncryption }),
        transportFactory: transportFactory2
      })

      const { promise: p1Created, resolve: r1 } = Promise.withResolvers<void>()
      resolvePc1 = r1

      // 1. First join with relayOnly: true
      const join1 = await engine1.joinGroup({
        invitation: { version: 2, signalingUrl, groupId: groupIdA, token: tokenA },
        displayName: 'Peer1',
        supernodeEligible: false,
        relayOnly: true,
        rememberInvitation: false,
        autoJoin: false
      })
      assert.equal(join1.ok, true)
      assert.equal(engine1.getState().relayOnly, true)

      // Peer 2 joins group A
      await engine2.joinGroup({
        invitation: { version: 2, signalingUrl, groupId: groupIdA, token: tokenA },
        displayName: 'Peer2',
        supernodeEligible: false,
        relayOnly: true,
        rememberInvitation: false,
        autoJoin: false
      })

      // Wait for PC to be created on engine1
      await p1Created

      assert.ok(recordedPolicies1.length > 0, 'Peer connections must be created')
      assert.ok(
        recordedPolicies1.every((p: string): boolean => p === 'relay'),
        `All PCs must have iceTransportPolicy === 'relay', got: ${JSON.stringify(recordedPolicies1)}`
      )

      // 2. Conflicting join while group A is active must be rejected
      const conflictJoin = await engine1.joinGroup({
        invitation: { version: 2, signalingUrl, groupId: groupIdB, token: tokenB },
        displayName: 'Peer1',
        supernodeEligible: false,
        relayOnly: false,
        rememberInvitation: false,
        autoJoin: false
      })
      assert.equal(conflictJoin.ok, false)
      assert.equal(conflictJoin.code, 'INVALID_INPUT')
      assert.ok(conflictJoin.message?.includes('Changing relay policy requires disconnecting all groups first'))

      // 3. Disconnect all groups, switch policy, and rejoin
      await engine1.disconnectAll()
      await engine2.disconnectAll()

      const switchResult = await engine1.setRelayOnly(false)
      assert.equal(switchResult.ok, true)
      assert.equal(engine1.getState().relayOnly, false)

      const { promise: p2Created, resolve: r2 } = Promise.withResolvers<void>()
      resolvePc2 = r2
      recordedPolicies1.length = 0

      // Re-join with relayOnly: false
      await engine1.joinGroup({
        invitation: { version: 2, signalingUrl, groupId: groupIdA, token: tokenA },
        displayName: 'Peer1',
        supernodeEligible: false,
        relayOnly: false,
        rememberInvitation: false,
        autoJoin: false
      })
      await engine2.joinGroup({
        invitation: { version: 2, signalingUrl, groupId: groupIdA, token: tokenA },
        displayName: 'Peer2',
        supernodeEligible: false,
        relayOnly: false,
        rememberInvitation: false,
        autoJoin: false
      })

      await p2Created

      assert.ok(recordedPolicies1.length > 0, 'New peer connection must be created')
      assert.ok(
        recordedPolicies1.every((p: string): boolean => p === 'all'),
        `All new PCs must have iceTransportPolicy === 'all', got: ${JSON.stringify(recordedPolicies1)}`
      )
    } finally {
      if (engine1) await engine1.dispose()
      if (engine2) await engine2.dispose()
      for (const pc of createdPcs3) {
        try {
          await pc.close()
        } catch {
          // ignore
        }
      }
      await server.close()
      await rm(dir1, { recursive: true, force: true }).catch(() => {})
      await rm(dir2, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('retains authoritative managed STUN and TURN configuration across multiple groups and leaves/resumes', async () => {
    const dir1 = await mkdtemp(join(tmpdir(), 'engine-turn-1-'))
    const dir2 = await mkdtemp(join(tmpdir(), 'engine-turn-2-'))
    const groupIdA = 'group-turn-A'
    const groupIdB = 'group-turn-B'
    const tokenA = Buffer.alloc(32, 41).toString('base64url')
    const tokenB = Buffer.alloc(32, 42).toString('base64url')

    const turnServerUrl = 'turn:turn.relay.test.local:3478'
    const stunServerUrl = 'stun:stun.relay.test.local:3478'

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [
        { groupId: groupIdA, token: tokenA },
        { groupId: groupIdB, token: tokenB }
      ],
      turnUrl: turnServerUrl,
      turnUsername: 'test-turn-user',
      turnCredential: 'test-turn-password',
      stunUrl: stunServerUrl
    })
    const signalingUrl = `ws://127.0.0.1:${server.address.port}/signal`

    const mockEncryption = {
      isAvailable: () => true,
      encrypt: (text: string) => Buffer.from(text.split('').reverse().join(''), 'utf-8'),
      decrypt: (buf: Buffer) => buf.toString('utf-8').split('').reverse().join('')
    }

    let resolveTurnPc: (() => void) | null = null
    const createdPcs4: RTCPeerConnection[] = []
    const recordedConfigs1: RTCConfiguration[] = []
    const transportFactory1 = (url: string, events: TransportEvents) =>
      new TransportManager(events, {
        connectionFactory: (config) => {
          recordedConfigs1.push(config as RTCConfiguration)
          if (resolveTurnPc) {
            resolveTurnPc()
            resolveTurnPc = null
          }
          const loopbackConfig = { ...config, iceServers: [] }
          const pc = new RTCPeerConnection(loopbackConfig as unknown as object)
          createdPcs4.push(pc)
          return pc
        }
      })
    const transportFactory2 = (url: string, events: TransportEvents) =>
      new TransportManager(events, {
        connectionFactory: (config) => {
          const loopbackConfig = { ...config, iceServers: [] }
          const pc = new RTCPeerConnection(loopbackConfig as unknown as object)
          createdPcs4.push(pc)
          return pc
        }
      })

    let engine1: PeerEngine | null = null
    let engine2: PeerEngine | null = null
    try {
      engine1 = await createPeerEngine({
        dataDirectory: dir1,
        credentialStore: createCredentialStore({ dataDirectory: dir1, mockEncryption }),
        transportFactory: transportFactory1
      })
      engine2 = await createPeerEngine({
        dataDirectory: dir2,
        credentialStore: createCredentialStore({ dataDirectory: dir2, mockEncryption }),
        transportFactory: transportFactory2
      })

      const { promise: turnPcCreated, resolve: rTurn } = Promise.withResolvers<void>()
      resolveTurnPc = rTurn

      // 1. Join group A on both engines
      await engine1.joinGroup({
        invitation: { version: 2, signalingUrl, groupId: groupIdA, token: tokenA },
        displayName: 'Peer1',
        supernodeEligible: false,
        relayOnly: false,
        rememberInvitation: true,
        autoJoin: false
      })
      await engine2.joinGroup({
        invitation: { version: 2, signalingUrl, groupId: groupIdA, token: tokenA },
        displayName: 'Peer2',
        supernodeEligible: false,
        relayOnly: false,
        rememberInvitation: true,
        autoJoin: false
      })

      const keyB = makeGroupKey(signalingUrl, groupIdB)

      await turnPcCreated

      assert.ok(recordedConfigs1.length > 0)
      const initialConfig = recordedConfigs1[recordedConfigs1.length - 1]
      assert.ok(
        initialConfig.iceServers?.some(
          (s) =>
            (s.urls === turnServerUrl || (Array.isArray(s.urls) && s.urls.includes(turnServerUrl))) &&
            s.username === 'test-turn-user' &&
            s.credential === 'test-turn-password'
        ),
        'Initial PC must include managed TURN server'
      )

      // 2. Join group B on both engines
      await engine1.joinGroup({
        invitation: { version: 2, signalingUrl, groupId: groupIdB, token: tokenB },
        displayName: 'Peer1',
        supernodeEligible: false,
        relayOnly: false,
        rememberInvitation: true,
        autoJoin: false
      })
      await engine2.joinGroup({
        invitation: { version: 2, signalingUrl, groupId: groupIdB, token: tokenB },
        displayName: 'Peer2',
        supernodeEligible: false,
        relayOnly: false,
        rememberInvitation: true,
        autoJoin: false
      })

      await waitForEngineState(
        engine1,
        (s) => findGroup(s, keyB)?.network.status === 'connected',
        15000,
        'Group B connected'
      )

      // 3. Leave group B then resume group B
      await engine1.leaveGroup(keyB)
      assert.equal(findGroup(engine1.getState(), keyB)?.network.status, 'disconnected')

      await engine1.resumeGroup(keyB)
      await waitForEngineState(
        engine1,
        (s) => findGroup(s, keyB)?.network.status === 'connected',
        15000,
        'Group B resumed'
      )

      // Verify recorded configs retain the authoritative TURN configuration across each path
      for (const cfg of recordedConfigs1) {
        assert.ok(
          cfg.iceServers?.some(
            (s) =>
              (s.urls === turnServerUrl || (Array.isArray(s.urls) && s.urls.includes(turnServerUrl))) &&
              s.username === 'test-turn-user' &&
              s.credential === 'test-turn-password'
          ),
          'TURN configuration must survive across all joined/resumed groups on endpoint'
        )
      }
    } finally {
      if (engine1) await engine1.dispose()
      if (engine2) await engine2.dispose()
      for (const pc of createdPcs4) {
        try {
          await pc.close()
        } catch {
          // ignore
        }
      }
      await server.close()
      await rm(dir1, { recursive: true, force: true }).catch(() => {})
      await rm(dir2, { recursive: true, force: true }).catch(() => {})
    }
  })
  it('enforces renewable roster freshness lease, expires stale groups without disturbing other groups, and rejects stale replayed revisions', async () => {
    const dir1 = await mkdtemp(join(tmpdir(), 'engine-fresh-1-'))
    const dir2 = await mkdtemp(join(tmpdir(), 'engine-fresh-2-'))
    const groupIdA = 'group-fresh-A'
    const groupIdB = 'group-fresh-B'
    const tokenA = Buffer.alloc(32, 51).toString('base64url')
    const tokenB = Buffer.alloc(32, 52).toString('base64url')

    const server = await createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      groups: [
        { groupId: groupIdA, token: tokenA },
        { groupId: groupIdB, token: tokenB }
      ]
    })

    const suppressGroupRenewals = new Set<string>()
    const capturedLowerRevisions = new Map<string, ServerSignalingMessageV2>()
    const proxySockets = new Set<WebSocket>()
    const proxyHttp = createServer()
    const proxyWss = new WebSocketServer({ noServer: true })
    const clientSockets = new Set<WebSocket>()

    proxyHttp.on('upgrade', (req, socket, head) => {
      proxyWss.handleUpgrade(req, socket, head, (clientWs) => {
        proxySockets.add(clientWs)
        clientSockets.add(clientWs)

        const authHeader = req.headers['authorization']
        const upstreamWs = new WebSocket(`ws://127.0.0.1:${server.address.port}/signal`, {
          headers: authHeader ? { Authorization: authHeader } : undefined
        })
        proxySockets.add(upstreamWs)

        const outboundQueue: { data: unknown; isBinary: boolean }[] = []
        upstreamWs.on('open', () => {
          for (const item of outboundQueue) {
            upstreamWs.send(item.data as string | Buffer, { binary: item.isBinary })
          }
          outboundQueue.length = 0
        })

        clientWs.on('message', (data, isBinary) => {
          if (upstreamWs.readyState === WebSocket.OPEN) {
            upstreamWs.send(data, { binary: isBinary })
          } else {
            outboundQueue.push({ data, isBinary })
          }
        })
        upstreamWs.on('message', (data, isBinary) => {
          if (clientWs.readyState !== WebSocket.OPEN) return
          let parsed: unknown
          try {
            parsed = JSON.parse(data.toString('utf-8'))
          } catch {
            clientWs.send(data, { binary: isBinary })
            return
          }

          if (
            parsed &&
            typeof parsed === 'object' &&
            'v' in parsed &&
            parsed.v === 2 &&
            'type' in parsed &&
            parsed.type === 'roster' &&
            'groupId' in parsed &&
            typeof parsed.groupId === 'string'
          ) {
            const rosterMsg = parsed as ServerSignalingMessageV2
            const gid = parsed.groupId
            if (!capturedLowerRevisions.has(gid)) {
              capturedLowerRevisions.set(gid, rosterMsg)
            }
            if (suppressGroupRenewals.has(gid)) {
              // Suppress roster renewal for this group
              return
            }
          }

          clientWs.send(data, { binary: isBinary })
        })

        clientWs.on('close', () => {
          proxySockets.delete(clientWs)
          clientSockets.delete(clientWs)
          try {
            upstreamWs.terminate()
          } catch {
            // ignore
          }
        })

        upstreamWs.on('close', () => {
          proxySockets.delete(upstreamWs)
          try {
            clientWs.terminate()
          } catch {
            // ignore
          }
        })
      })
    })

    const { promise: pListen, resolve: rListen } = Promise.withResolvers<void>()
    proxyHttp.listen(0, '127.0.0.1', () => rListen())
    await pListen
    const addr = proxyHttp.address()
    const proxyPort = typeof addr === 'object' && addr ? addr.port : 0
    const proxySignalingUrl = `ws://127.0.0.1:${proxyPort}/signal`
    const keyA = makeGroupKey(proxySignalingUrl, groupIdA)
    const keyB = makeGroupKey(proxySignalingUrl, groupIdB)

    const mockEncryption = {
      isAvailable: () => true,
      encrypt: (text: string) => Buffer.from(text.split('').reverse().join(''), 'utf-8'),
      decrypt: (buf: Buffer) => buf.toString('utf-8').split('').reverse().join('')
    }

    const createdPcs5: RTCPeerConnection[] = []
    const transportFactory1 = (url: string, events: TransportEvents) =>
      new TransportManager(events, {
        connectionFactory: (config) => {
          const pc = new RTCPeerConnection({ ...config, iceServers: [] } as unknown as object)
          createdPcs5.push(pc)
          return pc
        }
      })
    const transportFactory2 = (url: string, events: TransportEvents) =>
      new TransportManager(events, {
        connectionFactory: (config) => {
          const pc = new RTCPeerConnection({ ...config, iceServers: [] } as unknown as object)
          createdPcs5.push(pc)
          return pc
        }
      })

    let engine1: PeerEngine | null = null
    let engine2: PeerEngine | null = null
    try {
      engine1 = await createPeerEngine({
        dataDirectory: dir1,
        credentialStore: createCredentialStore({ dataDirectory: dir1, mockEncryption }),
        transportFactory: transportFactory1
      })
      engine2 = await createPeerEngine({
        dataDirectory: dir2,
        credentialStore: createCredentialStore({ dataDirectory: dir2, mockEncryption }),
        transportFactory: transportFactory2
      })

      // Join group A and group B on both engines
      await engine1.joinGroup({
        invitation: { version: 2, signalingUrl: proxySignalingUrl, groupId: groupIdA, token: tokenA },
        displayName: 'Peer1',
        supernodeEligible: false,
        relayOnly: false,
        rememberInvitation: true,
        autoJoin: false
      })
      await engine2.joinGroup({
        invitation: { version: 2, signalingUrl: proxySignalingUrl, groupId: groupIdA, token: tokenA },
        displayName: 'Peer2',
        supernodeEligible: false,
        relayOnly: false,
        rememberInvitation: true,
        autoJoin: false
      })
      await engine1.joinGroup({
        invitation: { version: 2, signalingUrl: proxySignalingUrl, groupId: groupIdB, token: tokenB },
        displayName: 'Peer1',
        supernodeEligible: false,
        relayOnly: false,
        rememberInvitation: true,
        autoJoin: false
      })
      await engine2.joinGroup({
        invitation: { version: 2, signalingUrl: proxySignalingUrl, groupId: groupIdB, token: tokenB },
        displayName: 'Peer2',
        supernodeEligible: false,
        relayOnly: false,
        rememberInvitation: true,
        autoJoin: false
      })

      // Wait for both groups to connect
      await waitForEngineState(
        engine1,
        (s) =>
          findGroup(s, keyA)?.network.status === 'connected' &&
          findGroup(s, keyB)?.network.status === 'connected',
        15000,
        'Both groups connected through proxy'
      )

      // 1. Healthy idle peers for >8s stay connected because equal-revision renewals renew lease
      // DELIBERATE PLATFORM-CLOCK LEASE EXPIRY: Testing real 8.5s idle stay-connected with renewable heartbeats
      await platformDelay(8500)

      const s1 = engine1.getState()
      const s2 = engine2.getState()

      assert.equal(findGroup(s1, keyA)?.network.status, 'connected')
      assert.equal(findGroup(s1, keyB)?.network.status, 'connected')
      assert.equal(findGroup(s2, keyA)?.network.status, 'connected')
      assert.equal(findGroup(s2, keyB)?.network.status, 'connected')

      // 2. Suppress only Group A renewals for >6s while Group B continues
      suppressGroupRenewals.add(groupIdA)

      // Wait for Group A lease to expire (>6s)
      // DELIBERATE PLATFORM-CLOCK LEASE EXPIRY: Testing real 7s lease expiration after renewals withheld
      await platformDelay(7000)

      // Group A must be recovering with message 'Roster freshness expired'
      const stateExpired = engine1.getState()
      assert.equal(findGroup(stateExpired, keyA)?.network.status, 'recovering')
      assert.equal(findGroup(stateExpired, keyA)?.network.message, 'Roster freshness expired')

      // Group B continues to be healthy on the same physical link
      assert.equal(findGroup(stateExpired, keyB)?.network.status, 'connected')

      // Group A rejects new search
      const resStaleSearch = await engine1.search(keyA, 'query')
      assert.equal(resStaleSearch.ok, false)
      assert.equal(resStaleSearch.code, 'DISCONNECTED')

      // Group A rejects new download
      const resStaleDl = await engine1.download(keyA, 'some-res-id', 'dest-path')
      assert.equal(resStaleDl.ok, false)
      assert.equal(resStaleDl.code, 'DISCONNECTED')

      // 3. Replay lower revision: must not extend Group A authority
      const capturedA = capturedLowerRevisions.get(groupIdA)
      if (capturedA && capturedA.type === 'roster') {
        const lowerRevisionRoster: ServerSignalingMessageV2 = {
          ...capturedA,
          revision: Math.max(1, capturedA.revision - 1)
        }
        for (const ws of clientSockets) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(Buffer.from(JSON.stringify(lowerRevisionRoster), 'utf-8'))
          }
        }
      }
      // Give tick for message dispatch
      await platformDelay(200)
      // Authority must still be expired!
      assert.equal(findGroup(engine1.getState(), keyA)?.network.status, 'recovering')

      // 4. Restore legitimate renewals: Group A becomes connected again
      suppressGroupRenewals.delete(groupIdA)
      await waitForEngineState(
        engine1,
        (s) => findGroup(s, keyA)?.network.status === 'connected',
        10000,
        'Group A renewed and reconnected'
      )
      assert.equal(findGroup(engine1.getState(), keyA)?.network.status, 'connected')
      assert.equal(findGroup(engine1.getState(), keyB)?.network.status, 'connected')
    } finally {
      if (engine1) await engine1.dispose()
      if (engine2) await engine2.dispose()
      for (const pc of createdPcs5) {
        try {
          await pc.close()
        } catch {
          // ignore
        }
      }
      for (const ws of proxySockets) {
        try {
          ws.terminate()
        } catch {
          // ignore
        }
      }
      for (const ws of clientSockets) {
        try {
          ws.terminate()
        } catch {
          // ignore
        }
      }
      const { promise: pWssClose, resolve: rWssClose } = Promise.withResolvers<void>()
      proxyWss.close(() => rWssClose())
      await pWssClose
      if (typeof proxyHttp.closeAllConnections === 'function') {
        proxyHttp.closeAllConnections()
      }
      const { promise: pHttpClose, resolve: rHttpClose } = Promise.withResolvers<void>()
      proxyHttp.close(() => rHttpClose())
      await pHttpClose
      await server.close()
      await rm(dir1, { recursive: true, force: true }).catch(() => {})
      await rm(dir2, { recursive: true, force: true }).catch(() => {})
    }
  })

  after(async () => {
    const { promise, resolve } = Promise.withResolvers<void>()
    setImmediate(() => {
      resolve()
      process.exit(0)
    })
    await promise
  })
})
