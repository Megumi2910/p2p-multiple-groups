import { createPeerEngine, type PeerEngine } from '../../src/main/p2p/engine.ts'
import type { P2pState } from '../../src/shared/p2p.ts'

function getArg(prefix: string): string | null {
  const match = process.argv.find((a) => a.startsWith(prefix))
  return match ? match.slice(prefix.length) : null
}

async function main(): Promise<void> {
  const dataDir = getArg('--data-dir=')
  const signalingUrl = getArg('--signaling-url=')
  const roomId = getArg('--room-id=')
  const token = getArg('--token=')
  const name = getArg('--name=') || `Peer-${process.pid}`
  const notEligible = process.argv.includes('--not-eligible')

  if (!dataDir || !signalingUrl || !roomId || !token) {
    console.error('Missing required arguments in peer-process')
    process.exit(1)
  }

  let engine: PeerEngine | null = null

  try {
    engine = await createPeerEngine({ dataDirectory: dataDir })

    engine.subscribe((state: P2pState) => {
      if (process.send) {
        process.send({ type: 'state', state })
      }
    })

    await engine.connect({
      signalingUrl,
      roomId,
      token,
      displayName: name,
      supernodeEligible: !notEligible,
      relayOnly: false
    })

    if (process.send) {
      process.send({ type: 'ready', state: engine.getState() })
    }

    process.on('message', async (cmd: unknown) => {
      if (!cmd || typeof cmd !== 'object' || !engine) return
      const c = cmd as Record<string, unknown>

      switch (c.type) {
        case 'set-eligible': {
          await engine.setSupernodeEligible(Boolean(c.eligible))
          break
        }
        case 'disconnect': {
          await engine.disconnect()
          break
        }
        case 'get-state': {
          if (process.send) {
            process.send({ type: 'state', state: engine.getState() })
          }
          break
        }
        case 'exit': {
          await engine.dispose()
          process.exit(0)
          break
        }
      }
    })
  } catch (err) {
    console.error('peer-process error:', err)
    if (process.send) {
      process.send({ type: 'error', error: err instanceof Error ? err.message : String(err) })
    }
    process.exit(1)
  }
}

void main()
