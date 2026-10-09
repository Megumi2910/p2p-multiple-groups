import { createSignalingServer } from './server.ts'
import { loadSignalingOptions } from './config.ts'

function main(): void {
  let options
  try {
    options = loadSignalingOptions(process.env)
  } catch (err) {
    console.error(`[signaling] Configuration error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  createSignalingServer(options)
    .then((server) => {
      const groupCount = options.groups?.length || 0
      console.log(
        `[signaling] Server listening at ${server.address.host}:${server.address.port} (${groupCount} configured group${groupCount === 1 ? '' : 's'})`
      )

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
