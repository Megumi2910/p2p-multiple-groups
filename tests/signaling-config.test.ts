import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadSignalingOptions } from '../services/signaling/config.ts'
import type { ServerSignalingMessageV2 } from '../src/shared/p2p-wire.ts'
import WebSocket from 'ws'

type WelcomeMessageV2 = Extract<ServerSignalingMessageV2, { type: 'welcome' }>

async function getFreePort(): Promise<number> {
  const srv = createServer()
  const { promise, resolve, reject } = Promise.withResolvers<number>()
  srv.listen(0, '127.0.0.1', () => {
    const addr = srv.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    srv.close(() => resolve(port))
  })
  srv.on('error', reject)
  return promise
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  // Real-time safety deadline: bounding subprocess network probe across external processes
  setTimeout(resolve, ms)
  return promise
}

describe('Signaling Configuration & CLI Parser', () => {
  const validToken1 = Buffer.alloc(32, 1).toString('base64url')
  const validToken2 = Buffer.alloc(32, 2).toString('base64url')

  it('parses valid multi-group JSON registry with distinct groups and tokens', () => {
    const env: NodeJS.ProcessEnv = {
      P2P_MULTIPLE_GROUPS_GROUPS_JSON: JSON.stringify([
        { groupId: 'group-alpha', token: validToken1 },
        { groupId: 'group-beta', token: validToken2 }
      ]),
      P2P_MULTIPLE_GROUPS_SIGNAL_HOST: '127.0.0.1',
      P2P_MULTIPLE_GROUPS_SIGNAL_PORT: '9000',
      P2P_MULTIPLE_GROUPS_PUBLIC_SIGNAL_URL: 'wss://example.com/signal'
    }

    const config = loadSignalingOptions(env)
    assert.equal(config.host, '127.0.0.1')
    assert.equal(config.port, 9000)
    assert.equal(config.publicSignalUrl, 'wss://example.com/signal')
    assert.equal(config.groups?.length, 2)
    assert.equal(config.groups?.[0].groupId, 'group-alpha')
    assert.equal(config.groups?.[1].groupId, 'group-beta')
  })

  it('rejects duplicate group IDs and duplicate tokens without leaking secrets', () => {
    // Duplicate group ID
    const duplicateGroupEnv: NodeJS.ProcessEnv = {
      P2P_MULTIPLE_GROUPS_GROUPS_JSON: JSON.stringify([
        { groupId: 'grp-1', token: validToken1 },
        { groupId: 'grp-1', token: validToken2 }
      ])
    }
    assert.throws(
      () => loadSignalingOptions(duplicateGroupEnv),
      (err: Error) => {
        assert.ok(err.message.includes('Duplicate groupId'))
        assert.ok(!err.message.includes(validToken1))
        return true
      }
    )

    // Duplicate token
    const duplicateTokenEnv: NodeJS.ProcessEnv = {
      P2P_MULTIPLE_GROUPS_GROUPS_JSON: JSON.stringify([
        { groupId: 'grp-1', token: validToken1 },
        { groupId: 'grp-2', token: validToken1 }
      ])
    }
    assert.throws(
      () => loadSignalingOptions(duplicateTokenEnv),
      (err: Error) => {
        assert.ok(err.message.includes('Duplicate token'))
        assert.ok(!err.message.includes(validToken1))
        return true
      }
    )
  })

  it('starts cleanly with empty groups when P2P_MULTIPLE_GROUPS_GROUPS_JSON is absent or empty', () => {
    const dynamicEnv: NodeJS.ProcessEnv = {
      P2P_MULTIPLE_GROUPS_SIGNAL_PORT: '8888',
      P2P_MULTIPLE_GROUPS_PUBLIC_SIGNAL_URL: 'ws://127.0.0.1:8888/signal'
    }

    const config = loadSignalingOptions(dynamicEnv)
    assert.equal(config.port, 8888)
    assert.equal(config.publicSignalUrl, 'ws://127.0.0.1:8888/signal')
    assert.deepEqual(config.groups, [])
  })

  it('enforces TURN pairing and all-or-none validation', () => {
    const baseEnv: NodeJS.ProcessEnv = {
      P2P_MULTIPLE_GROUPS_GROUPS_JSON: JSON.stringify([{ groupId: 'grp', token: validToken1 }])
    }

    // HMAC TURN incomplete
    assert.throws(
      () => loadSignalingOptions({ ...baseEnv, P2P_MULTIPLE_GROUPS_TURN_HOST: 'turn.example.com' }),
      (err: Error) => err.message.includes('TURN_HOST and TURN_SECRET must be both set')
    )

    // Managed TURN incomplete
    assert.throws(
      () => loadSignalingOptions({ ...baseEnv, P2P_MULTIPLE_GROUPS_TURN_URL: 'turns:turn.metered.ca:443' }),
      (err: Error) => err.message.includes('TURN_URL, TURN_USERNAME, and TURN_CREDENTIAL')
    )
  })

  it('invokes scripts/create-invite.ts to output valid version-2 invitation', async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      P2P_MULTIPLE_GROUPS_GROUPS_JSON: JSON.stringify([
        { groupId: 'alpha', token: validToken1 },
        { groupId: 'beta', token: validToken2 }
      ]),
      P2P_MULTIPLE_GROUPS_PUBLIC_SIGNAL_URL: 'wss://signal.example.com/signal'
    }

    // Export specific group alpha
    const { promise, resolve, reject } = Promise.withResolvers<string>()
    const child = spawn(process.execPath, ['scripts/create-invite.ts', '--group-id=alpha'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`Exit code ${code}: ${stderr}`))
    })

    const output = await promise
    const parsed = JSON.parse(output.trim())
    assert.equal(parsed.version, 2)
    assert.equal(parsed.groupId, 'alpha')
    assert.equal(parsed.signalingUrl, 'wss://signal.example.com/signal')
    assert.equal(parsed.token, validToken1)
  })

  it('scripts/create-invite.ts fails when multiple groups exist but no group-id is specified', async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      P2P_MULTIPLE_GROUPS_GROUPS_JSON: JSON.stringify([
        { groupId: 'alpha', token: validToken1 },
        { groupId: 'beta', token: validToken2 }
      ]),
      P2P_MULTIPLE_GROUPS_PUBLIC_SIGNAL_URL: 'wss://signal.example.com/signal'
    }

    const { promise, resolve } = Promise.withResolvers<number | null>()
    const child = spawn(process.execPath, ['scripts/create-invite.ts'], {
      env,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    child.on('exit', (code) => resolve(code))

    const exitCode = await promise
    assert.notEqual(exitCode, 0)
  })

  it('starts services/signaling/index.ts, verifies /healthz and websocket, and cleanly stops with SIGTERM', async () => {
    const port = await getFreePort()
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      P2P_MULTIPLE_GROUPS_SIGNAL_HOST: '127.0.0.1',
      P2P_MULTIPLE_GROUPS_SIGNAL_PORT: String(port),
      P2P_MULTIPLE_GROUPS_GROUPS_JSON: JSON.stringify([{ groupId: 'smoke-group', token: validToken1 }])
    }

    const child = spawn(process.execPath, ['services/signaling/index.ts'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    try {
      // Wait for healthz
      let healthy = false
      for (let i = 0; i < 30; i++) {
        await delay(100)
        try {
          const res = await fetch(`http://127.0.0.1:${port}/healthz`)
          if (res.ok) {
            const body = await res.json()
            if (body.ok === true) {
              healthy = true
              break
            }
          }
        } catch {
          // retry
        }
      }
      assert.equal(healthy, true, 'Server must serve /healthz with { ok: true }')

      // Connect WebSocket with valid token
      const ws = new WebSocket(`ws://127.0.0.1:${port}/signal`, {
        headers: { Authorization: `Bearer ${validToken1}` }
      })

      const { promise: openPromise, resolve: resolveOpen } = Promise.withResolvers<void>()
      ws.on('open', () => resolveOpen())
      await openPromise
      ws.close()
    } finally {
      const { promise: exitPromise, resolve: resolveExit } = Promise.withResolvers<{ code: number | null; signal: string | null }>()
      child.on('exit', (code, signal) => resolveExit({ code, signal }))
      child.kill('SIGTERM')
      const result = await exitPromise
      assert.ok(result.code === 0 || result.signal === 'SIGTERM')
    }
  })
  it('verifies shipped deployment templates advertise canonical keys and pass end-to-end runtime lifecycle', async () => {
    // 1. Read shipped templates from disk
    const renderYamlContent = await readFile(join(process.cwd(), 'render.yaml'), 'utf-8')
    const azureEnvContent = await readFile(join(process.cwd(), 'ops', 'azure', 'signaling.env.example'), 'utf-8')
    const envExampleContent = await readFile(join(process.cwd(), '.env.example'), 'utf-8')
    const dockerfileContent = await readFile(join(process.cwd(), 'Dockerfile'), 'utf-8')
    const composeContent = await readFile(join(process.cwd(), 'docker-compose.yml'), 'utf-8')

    // Assert .env.example, Dockerfile, and docker-compose.yml use canonical keys with zero legacy KAZAA or roomId
    assert.ok(envExampleContent.includes('P2P_MULTIPLE_GROUPS_SIGNAL_HOST='))
    assert.ok(!envExampleContent.includes('KAZAA_'))
    assert.ok(!envExampleContent.includes('roomId'))

    assert.ok(dockerfileContent.includes('P2P_MULTIPLE_GROUPS_SIGNAL_PORT'))
    assert.ok(!dockerfileContent.includes('KAZAA_'))
    assert.ok(!dockerfileContent.includes('roomId'))

    assert.ok(composeContent.includes('p2p-multiple-groups-signaling'))
    assert.ok(!composeContent.includes('KAZAA_'))
    assert.ok(!composeContent.includes('roomId'))

    // Assert render.yaml uses canonical P2P_MULTIPLE_GROUPS_* keys and no deprecated short names
    assert.ok(renderYamlContent.includes('key: P2P_MULTIPLE_GROUPS_GROUPS_JSON'), 'render.yaml must use P2P_MULTIPLE_GROUPS_GROUPS_JSON')
    assert.ok(renderYamlContent.includes('key: P2P_MULTIPLE_GROUPS_STUN_URL'), 'render.yaml must use P2P_MULTIPLE_GROUPS_STUN_URL')
    assert.ok(renderYamlContent.includes('key: P2P_MULTIPLE_GROUPS_TURN_URL'), 'render.yaml must use P2P_MULTIPLE_GROUPS_TURN_URL')
    assert.ok(renderYamlContent.includes('key: P2P_MULTIPLE_GROUPS_TURN_USERNAME'), 'render.yaml must use P2P_MULTIPLE_GROUPS_TURN_USERNAME')
    assert.ok(renderYamlContent.includes('key: P2P_MULTIPLE_GROUPS_TURN_CREDENTIAL'), 'render.yaml must use P2P_MULTIPLE_GROUPS_TURN_CREDENTIAL')

    assert.ok(!renderYamlContent.includes('key: P2P_GROUPS_JSON'), 'render.yaml must not use short P2P_GROUPS_JSON')
    assert.ok(!renderYamlContent.includes('key: P2P_STUN_URL'), 'render.yaml must not use short P2P_STUN_URL')
    assert.ok(!renderYamlContent.includes('key: P2P_TURN_URL'), 'render.yaml must not use short P2P_TURN_URL')
    assert.ok(!renderYamlContent.includes('key: P2P_TURN_USERNAME'), 'render.yaml must not use short P2P_TURN_USERNAME')
    assert.ok(!renderYamlContent.includes('key: P2P_TURN_CREDENTIAL'), 'render.yaml must not use short P2P_TURN_CREDENTIAL')
    assert.ok(!renderYamlContent.includes('KAZAA_'), 'render.yaml must not contain KAZAA_')
    assert.ok(!renderYamlContent.includes('roomId'), 'render.yaml must not contain roomId')

    // Assert azure template uses canonical P2P_MULTIPLE_GROUPS_* keys
    assert.ok(azureEnvContent.includes('P2P_MULTIPLE_GROUPS_SIGNAL_HOST='), 'azure template must use P2P_MULTIPLE_GROUPS_SIGNAL_HOST')
    assert.ok(azureEnvContent.includes('P2P_MULTIPLE_GROUPS_SIGNAL_PORT='), 'azure template must use P2P_MULTIPLE_GROUPS_SIGNAL_PORT')
    assert.ok(azureEnvContent.includes('P2P_MULTIPLE_GROUPS_GROUPS_JSON='), 'azure template must use P2P_MULTIPLE_GROUPS_GROUPS_JSON')
    assert.ok(azureEnvContent.includes('P2P_MULTIPLE_GROUPS_TURN_HOST='), 'azure template must use P2P_MULTIPLE_GROUPS_TURN_HOST')
    assert.ok(azureEnvContent.includes('P2P_MULTIPLE_GROUPS_TURN_SECRET='), 'azure template must use P2P_MULTIPLE_GROUPS_TURN_SECRET')

    assert.ok(!/^P2P_SIGNAL_HOST=/m.test(azureEnvContent), 'azure template must not use short P2P_SIGNAL_HOST')
    assert.ok(!/^P2P_SIGNAL_PORT=/m.test(azureEnvContent), 'azure template must not use short P2P_SIGNAL_PORT')
    assert.ok(!/^P2P_GROUPS_JSON=/m.test(azureEnvContent), 'azure template must not use short P2P_GROUPS_JSON')
    assert.ok(!/^P2P_TURN_HOST=/m.test(azureEnvContent), 'azure template must not use short P2P_TURN_HOST')
    assert.ok(!/^P2P_TURN_SECRET=/m.test(azureEnvContent), 'azure template must not use short P2P_TURN_SECRET')
    assert.ok(!azureEnvContent.includes('KAZAA_'), 'azure template must not contain KAZAA_')
    assert.ok(!azureEnvContent.includes('roomId'), 'azure template must not contain roomId')
    // 2. Render-derived environment test
    const renderPort = await getFreePort()
    const renderEnv: NodeJS.ProcessEnv = {
      ...process.env,
      P2P_MULTIPLE_GROUPS_SIGNAL_HOST: '127.0.0.1',
      P2P_MULTIPLE_GROUPS_SIGNAL_PORT: String(renderPort),
      P2P_MULTIPLE_GROUPS_GROUPS_JSON: JSON.stringify([
        { groupId: 'render-alpha', token: validToken1, name: 'Render Alpha' },
        { groupId: 'render-beta', token: validToken2, name: 'Render Beta' }
      ]),
      P2P_MULTIPLE_GROUPS_STUN_URL: 'stun:stun.relay.metered.ca:80',
      P2P_MULTIPLE_GROUPS_TURN_URL: 'turns:global.relay.metered.ca:443?transport=tcp',
      P2P_MULTIPLE_GROUPS_TURN_USERNAME: 'metered-user-test',
      P2P_MULTIPLE_GROUPS_TURN_CREDENTIAL: 'metered-cred-test',
      P2P_MULTIPLE_GROUPS_PUBLIC_SIGNAL_URL: `ws://127.0.0.1:${renderPort}/signal`
    }

    const renderConfig = loadSignalingOptions(renderEnv)
    assert.equal(renderConfig.host, '127.0.0.1')
    assert.equal(renderConfig.port, renderPort)
    assert.equal(renderConfig.groups?.length, 2)
    assert.equal(renderConfig.groups?.[0].groupId, 'render-alpha')
    assert.equal(renderConfig.groups?.[1].groupId, 'render-beta')
    assert.equal(renderConfig.stunUrl, 'stun:stun.relay.metered.ca:80')
    assert.equal(renderConfig.turnUrl, 'turns:global.relay.metered.ca:443?transport=tcp')
    assert.equal(renderConfig.turnUsername, 'metered-user-test')
    assert.equal(renderConfig.turnCredential, 'metered-cred-test')

    // Spawn services/signaling/index.ts under Render-derived environment
    const renderChild = spawn(process.execPath, ['services/signaling/index.ts'], {
      env: renderEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    try {
      let healthy = false
      for (let i = 0; i < 30; i++) {
        await delay(100)
        try {
          const res = await fetch(`http://127.0.0.1:${renderPort}/healthz`)
          if (res.ok && (await res.json()).ok === true) {
            healthy = true
            break
          }
        } catch {
          // retry
        }
      }
      assert.equal(healthy, true, 'Render-derived server must serve /healthz')

      // Connect local client and inspect welcome ICE configuration
      const ws = new WebSocket(`ws://127.0.0.1:${renderPort}/signal`, {
        headers: { Authorization: `Bearer ${validToken1}` }
      })
      const { promise: welcomePromise, resolve: resolveWelcome } = Promise.withResolvers<WelcomeMessageV2>()
      ws.on('open', () => {
        ws.send(JSON.stringify({
          v: 2,
          type: 'register',
          peerId: randomUUID(),
          displayName: 'RenderTester'
        }))
      })
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'welcome') resolveWelcome(msg)
      })

      const welcomeMsg = await welcomePromise
      assert.ok(welcomeMsg.iceConfig)
      assert.ok(welcomeMsg.iceConfig.servers.length >= 2)
      const serverUrls = welcomeMsg.iceConfig.servers.flatMap((s: { urls: string | string[] }) => Array.isArray(s.urls) ? s.urls : [s.urls])
      assert.ok(serverUrls.includes('stun:stun.relay.metered.ca:80'), 'STUN url must be in ICE config')
      assert.ok(serverUrls.includes('turns:global.relay.metered.ca:443?transport=tcp'), 'TURN url must be in ICE config')
      ws.close()
    } finally {
      const { promise: exitP, resolve: resolveExit } = Promise.withResolvers<void>()
      renderChild.on('exit', () => resolveExit())
      renderChild.kill('SIGTERM')
      await exitP
    }

    // Assert create-invite under Render environment outputs valid v2 invitation
    const { promise: renderInviteP, resolve: resolveRenderInvite, reject: rejectRenderInvite } = Promise.withResolvers<string>()
    const renderInviteChild = spawn(process.execPath, ['scripts/create-invite.ts', '--group-id=render-alpha'], {
      env: renderEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let renderInviteOut = ''
    renderInviteChild.stdout.on('data', (d) => (renderInviteOut += d.toString()))
    renderInviteChild.on('exit', (c) => {
      if (c === 0) resolveRenderInvite(renderInviteOut)
      else rejectRenderInvite(new Error(`Exit code ${c}`))
    })
    const renderInviteRes = JSON.parse((await renderInviteP).trim())
    assert.equal(renderInviteRes.version, 2)
    assert.equal(renderInviteRes.groupId, 'render-alpha')
    assert.equal(renderInviteRes.token, validToken1)
    assert.equal(renderInviteRes.signalingUrl, `ws://127.0.0.1:${renderPort}/signal`)

    // 3. Azure-derived environment test
    const azurePort = await getFreePort()
    const azureTurnSecret = Buffer.alloc(32, 77).toString('base64url')
    const azureEnv: NodeJS.ProcessEnv = {
      ...process.env,
      P2P_MULTIPLE_GROUPS_SIGNAL_HOST: '127.0.0.1',
      P2P_MULTIPLE_GROUPS_SIGNAL_PORT: String(azurePort),
      P2P_MULTIPLE_GROUPS_GROUPS_JSON: JSON.stringify([
        { groupId: 'azure-alpha', token: validToken1, name: 'Azure Alpha' },
        { groupId: 'azure-beta', token: validToken2, name: 'Azure Beta' }
      ]),
      P2P_MULTIPLE_GROUPS_TURN_HOST: '127.0.0.1',
      P2P_MULTIPLE_GROUPS_TURN_SECRET: azureTurnSecret,
      P2P_MULTIPLE_GROUPS_PUBLIC_SIGNAL_URL: `ws://127.0.0.1:${azurePort}/signal`
    }

    const azureConfig = loadSignalingOptions(azureEnv)
    assert.equal(azureConfig.host, '127.0.0.1')
    assert.equal(azureConfig.port, azurePort)
    assert.equal(azureConfig.groups?.length, 2)
    assert.equal(azureConfig.turnHost, '127.0.0.1')
    assert.equal(azureConfig.turnSecret, azureTurnSecret)

    // Spawn services/signaling/index.ts under Azure-derived environment
    const azureChild = spawn(process.execPath, ['services/signaling/index.ts'], {
      env: azureEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    try {
      let healthy = false
      for (let i = 0; i < 30; i++) {
        await delay(100)
        try {
          const res = await fetch(`http://127.0.0.1:${azurePort}/healthz`)
          if (res.ok && (await res.json()).ok === true) {
            healthy = true
            break
          }
        } catch {
          // retry
        }
      }
      assert.equal(healthy, true, 'Azure-derived server must serve /healthz')

      // Connect local client and inspect dynamic HMAC TURN credentials
      const ws = new WebSocket(`ws://127.0.0.1:${azurePort}/signal`, {
        headers: { Authorization: `Bearer ${validToken1}` }
      })
      const { promise: welcomePromise, resolve: resolveWelcome } = Promise.withResolvers<WelcomeMessageV2>()
      ws.on('open', () => {
        ws.send(JSON.stringify({
          v: 2,
          type: 'register',
          peerId: randomUUID(),
          displayName: 'AzureTester'
        }))
      })
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString('utf-8')) as ServerSignalingMessageV2
        if (msg.type === 'welcome') resolveWelcome(msg)
      })

      const welcomeMsg = await welcomePromise
      assert.ok(welcomeMsg.iceConfig)
      assert.ok(welcomeMsg.iceConfig.servers.length >= 2)
      const turnServer = welcomeMsg.iceConfig.servers.find((s: { username?: string; credential?: string }) => Boolean(s.username && s.credential))
      assert.ok(turnServer, 'Dynamic HMAC TURN server entry must be present')
      assert.ok(typeof turnServer.username === 'string' && turnServer.username.length > 0)
      assert.ok(typeof turnServer.credential === 'string' && turnServer.credential.length > 0)
      ws.close()
    } finally {
      const { promise: exitP, resolve: resolveExit } = Promise.withResolvers<void>()
      azureChild.on('exit', () => resolveExit())
      azureChild.kill('SIGTERM')
      await exitP
    }

    // Assert create-invite under Azure environment outputs valid v2 invitation
    const { promise: azureInviteP, resolve: resolveAzureInvite, reject: rejectAzureInvite } = Promise.withResolvers<string>()
    const azureInviteChild = spawn(process.execPath, ['scripts/create-invite.ts', '--group-id=azure-beta'], {
      env: azureEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let azureInviteOut = ''
    azureInviteChild.stdout.on('data', (d) => (azureInviteOut += d.toString()))
    azureInviteChild.on('exit', (c) => {
      if (c === 0) resolveAzureInvite(azureInviteOut)
      else rejectAzureInvite(new Error(`Exit code ${c}`))
    })
    const azureInviteRes = JSON.parse((await azureInviteP).trim())
    assert.equal(azureInviteRes.version, 2)
    assert.equal(azureInviteRes.groupId, 'azure-beta')
    assert.equal(azureInviteRes.token, validToken2)
    assert.equal(azureInviteRes.signalingUrl, `ws://127.0.0.1:${azurePort}/signal`)
  })
})
