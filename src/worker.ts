import { closeDatabase } from './db/client.js'
import { closeApplicationQueue, startApplicationWorker } from './hunt/application-queue.js'
import { logger } from './lib/logger.js'

const worker = startApplicationWorker()
logger.info('Huntly application worker started')

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  logger.info({ signal }, 'stopping Huntly application worker')
  await worker.close()
  await closeApplicationQueue()
  await closeDatabase()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
