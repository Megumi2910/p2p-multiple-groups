import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { loadSignalingOptions } from '../services/signaling/config.ts'
import WebSocket from 'ws'

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

  it('falls back to legacy KAZAA_ROOM_ID and KAZAA_ROOM_TOKEN when groups JSON is absent', () => {
    const legacyEnv: NodeJS.ProcessEnv = {
      KAZAA_ROOM_ID: 'legacy-room',
      KAZAA_ROOM_TOKEN: validToken1,
      KAZAA_SIGNAL_PORT: '8888',
      KAZAA_PUBLIC_SIGNAL_URL: 'ws://127.0.0.1:8888/signal'
    }

    const config = loadSignalingOptions(legacyEnv)
    assert.equal(config.port, 8888)
    assert.equal(config.publicSignalUrl, 'ws://127.0.0.1:8888/signal')
    assert.equal(config.groups?.length, 1)
    assert.equal(config.groups?.[0].groupId, 'legacy-room')
    assert.equal(config.groups?.[0].token, validToken1)
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
})
