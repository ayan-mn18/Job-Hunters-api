import type { Server } from 'node:http'
import { createApp } from './app.js'
import { env, hasDatabase, hasRedis, hasSupabaseStorage } from './config/env.js'
import { closeDatabase, pingDatabase } from './db/client.js'
import { logger } from './lib/logger.js'
import { startLinkedInReferralScheduler } from './services/linkedin-referrals.js'

const app = createApp()
const stopLinkedInReferralScheduler = startLinkedInReferralScheduler()

const server: Server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV, timezone: env.APP_TIMEZONE },
    `Job Hunters API listening on http://localhost:${env.PORT}`,
  )

  // Say plainly what is missing. A fresh checkout has none of this, and
  // guessing why requests 503 is a waste of everyone's afternoon.
  if (!hasDatabase) {
    logger.warn(
      'DATABASE_URL is not set — every data route will return 503. Copy .env.example to .env.',
    )
  }
  if (!hasSupabaseStorage) {
    logger.warn('Supabase Storage is not configured — resume upload and download are disabled.')
  }
  if (!hasRedis) {
    logger.warn('REDIS_URL is not set — approved batches cannot enter the application queue.')
  }
  if (!env.PORTAL_AUTOMATION_ENABLED) {
    logger.warn('Portal automation is disabled — discovery and approval still work safely.')
  }
  logger.warn('Stubbed: referral draft generation only. See /readyz.')

  if (hasDatabase) {
    void pingDatabase().then((result) => {
      if (result.ok) logger.info('connected to postgres')
      else logger.error({ error: result.error }, 'could not reach postgres')
    })
  }
})

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests
 * finish, drain the pool, then exit. The 10s ceiling stops a hung request from
 * blocking a deploy forever.
 */
let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  stopLinkedInReferralScheduler()
  logger.info({ signal }, 'shutting down')

  const force = setTimeout(() => {
    logger.error('shutdown timed out — forcing exit')
    process.exit(1)
  }, 10_000)
  force.unref()

  server.close(async (error) => {
    if (error) logger.error({ err: error }, 'error while closing the server')
    try {
      await closeDatabase()
    } catch (closeError) {
      logger.error({ err: closeError }, 'error while closing the database pool')
    }
    clearTimeout(force)
    process.exit(error ? 1 : 0)
  })
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection')
})

process.on('uncaughtException', (error) => {
  // An uncaught exception means the process is in an unknown state. Log it and
  // go down rather than serve requests from a corrupted runtime.
  logger.fatal({ err: error }, 'uncaught exception — exiting')
  void shutdown('uncaughtException')
})

export { app, server }
