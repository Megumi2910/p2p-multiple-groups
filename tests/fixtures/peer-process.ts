import { createPeerEngine, type PeerEngine } from '../../src/main/p2p/engine.ts'
import type { GroupInvitation, GroupKey, JoinGroupOptions, MultiGroupP2pState } from '../../src/shared/p2p.ts'

function getArg(prefix: string): string | null {
  const match = process.argv.find((a) => a.startsWith(prefix))
  return match ? match.slice(prefix.length) : null
}

async function main(): Promise<void> {
  const dataDir = getArg('--data-dir=')
  const signalingUrl = getArg('--signaling-url=')
  const groupId = getArg('--group-id=')
  const token = getArg('--token=')
  const name = getArg('--name=') || `Peer-${process.pid}`
  const notEligible = process.argv.includes('--not-eligible')

  if (!dataDir) {
    console.error('Missing required --data-dir argument in peer-process')
    process.exit(1)
  }

  let engine: PeerEngine | null = null

  try {
    engine = await createPeerEngine({ dataDirectory: dataDir })

    engine.subscribe((state: MultiGroupP2pState) => {
      if (process.send) {
        process.send({ type: 'state', state })
      }
    })

    if (signalingUrl && groupId && token) {
      await engine.joinGroup({
        invitation: {
          version: 2,
          signalingUrl,
          groupId,
          token
        },
        displayName: name,
        supernodeEligible: !notEligible,
        relayOnly: false,
        rememberInvitation: false
      })
    }

    if (process.send) {
      process.send({ type: 'ready', state: engine.getState() })
    }

    process.on('message', async (cmd: unknown) => {
      if (!cmd || typeof cmd !== 'object' || !engine) return
      const c = cmd as Record<string, unknown>

      try {
        switch (c.type) {
          case 'join-group': {
            const inv = c.invitation as GroupInvitation
            const joinOpts: JoinGroupOptions = {
              invitation: inv,
              displayName: name,
              supernodeEligible: c.eligible !== undefined ? Boolean(c.eligible) : !notEligible,
              relayOnly: false,
              rememberInvitation: false
            }
            await engine.joinGroup(joinOpts)
            break
          }
          case 'resume': {
            await engine.resumeGroup(c.groupKey as GroupKey)
            break
          }
          case 'leave': {
            await engine.leaveGroup(c.groupKey as GroupKey)
            break
          }
          case 'forget': {
            await engine.forgetGroup(c.groupKey as GroupKey)
            break
          }
          case 'set-eligible': {
            const gk = (c.groupKey as GroupKey) || engine.getState().groups[0]?.groupKey
            if (gk) {
              await engine.setSupernodeEligible(gk, Boolean(c.eligible))
            }
            break
          }
          case 'search': {
            const gk = (c.groupKey as GroupKey) || engine.getState().groups[0]?.groupKey
            if (gk) {
              await engine.search(gk, String(c.query))
            }
            break
          }
          case 'add-files': {
            const gk = (c.groupKey as GroupKey) || engine.getState().groups[0]?.groupKey || null
            await engine.addFiles(gk, c.paths as readonly string[])
            break
          }
          case 'disconnect': {
            await engine.disconnectAll()
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
      } catch (cmdErr) {
        if (process.send) {
          process.send({ type: 'command-error', error: cmdErr instanceof Error ? cmdErr.message : String(cmdErr) })
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
