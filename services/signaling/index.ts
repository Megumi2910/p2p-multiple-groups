import { createSignalingServer } from './server.ts'
import { validateRoomId, validateToken } from '../../src/shared/p2p.ts'

function main(): void {
  const host =
    process.env.KAZAA_SIGNAL_HOST ||
    (process.env.RENDER || process.env.PORT ? '0.0.0.0' : '127.0.0.1')
  const rawPort = process.env.KAZAA_SIGNAL_PORT || process.env.PORT || '8787'
  const port = parseInt(rawPort, 10)
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid KAZAA_SIGNAL_PORT: ${rawPort}`)
    process.exit(1)
  }

  const rawRoomId = process.env.KAZAA_ROOM_ID || ''
  const roomCheck = validateRoomId(rawRoomId)
  if (!roomCheck.valid) {
    console.error(`Invalid KAZAA_ROOM_ID: ${roomCheck.error}`)
    process.exit(1)
  }

  const rawToken = process.env.KAZAA_ROOM_TOKEN || ''
  const tokenCheck = validateToken(rawToken)
  if (!tokenCheck.valid) {
    console.error(`Invalid KAZAA_ROOM_TOKEN: ${tokenCheck.error}`)
    process.exit(1)
  }

  const turnHost = process.env.KAZAA_TURN_HOST || ''
  const turnSecret = process.env.KAZAA_TURN_SECRET || ''

  if ((turnHost && !turnSecret) || (!turnHost && turnSecret)) {
    console.error('KAZAA_TURN_HOST and KAZAA_TURN_SECRET must be both set or both absent')
    process.exit(1)
  }

  const stunUrl = process.env.KAZAA_STUN_URL || ''
  const turnUrl = process.env.KAZAA_TURN_URL || ''
  const turnUsername = process.env.KAZAA_TURN_USERNAME || ''
  const turnCredential = process.env.KAZAA_TURN_CREDENTIAL || ''

  const hasAnyManagedTurn = Boolean(turnUrl || turnUsername || turnCredential)
  const hasAllManagedTurn = Boolean(turnUrl && turnUsername && turnCredential)
  if (hasAnyManagedTurn && !hasAllManagedTurn) {
    console.error('KAZAA_TURN_URL, KAZAA_TURN_USERNAME, and KAZAA_TURN_CREDENTIAL must all be set together')
    process.exit(1)
  }

  createSignalingServer({
    host,
    port,
    roomId: roomCheck.value,
    token: tokenCheck.value,
    turnHost: turnHost || undefined,
    turnSecret: turnSecret || undefined,
    stunUrl: stunUrl || undefined,
    turnUrl: turnUrl || undefined,
    turnUsername: turnUsername || undefined,
    turnCredential: turnCredential || undefined
  })
    .then((server) => {
      console.log(`[signaling] Server listening at ${server.address.host}:${server.address.port} for room "${roomCheck.value}"`)

      let stopping = false
      const shutdown = async (signal: string): Promise<void> => {
        if (stopping) return
        stopping = true
        console.log(`[signaling] Received ${signal}, shutting down gracefully...`)
        try {
          await server.close()
          console.log('[signaling] Shutdown complete.')
          process.exit(0)
        } catch (err) {
          console.error('[signaling] Error during shutdown:', err)
          process.exit(1)
        }
      }

      process.on('SIGINT', () => void shutdown('SIGINT'))
      process.on('SIGTERM', () => void shutdown('SIGTERM'))
    })
    .catch((err) => {
      console.error('[signaling] Failed to start:', err)
      process.exit(1)
    })
}

main()
