import { closeDatabase } from './db/client.js'
import { hasRedis } from './config/env.js'
import { logger } from './lib/logger.js'
import { closeRedis } from './lib/redis.js'
import { withUserResourceLock } from './lib/locks.js'
import { reconcileInterruptedRuns, startDiscoverWorker } from './queues/discover.js'
import { closeQueues, startWorker } from './queues/index.js'
import { QUEUE } from './queues/names.js'
import { refitAllWeights } from './persona/learn.js'
import { registerQueueImplementations } from './queues/register.js'
import { syncAllSchedules } from './queues/schedule.js'
import { type InboxJobData } from './queues/names.js'
import { sweepInbox } from './inbox/ingest.js'
import { sourceFor } from './inbox/registry.js'
import { db } from './db/client.js'
import { userSchedules } from './db/schema.js'
import { eq } from 'drizzle-orm'

/**
 * The worker process: queues that need CPU and network but not a browser.
 *
 * Browser work lives in `runner.ts` instead, because a Playwright image is an
 * order of magnitude larger than this one and scales on memory rather than
 * throughput. Keeping them apart means discovery can scale without paying for
 * Chromium, and vice versa.
 *
 * Schedules are registered here. BullMQ job schedulers are keyed and
 * idempotent, so every replica may register the same schedule and exactly one
 * fires — which is why there is no separate scheduler process.
 */

if (!hasRedis) {
  logger.fatal('REDIS_URL is required to run the worker.')
  process.exit(1)
}

registerQueueImplementations()
startDiscoverWorker()

// Learning runs on its own queue so a long refit cannot delay a scrape.
startWorker(
  QUEUE.learn,
  async () => {
    const changed = await refitAllWeights()
    logger.info({ changed }, 'nightly weight refit finished')
  },
  { concurrency: 1, lockDuration: 60_000 },
)

void syncAllSchedules().catch((error: unknown) => {
  logger.error({ err: error }, 'could not register daily schedules')
})

// Pick up anything a previous process was in the middle of when it went away.
void reconcileInterruptedRuns()
  .then((requeued) => {
    if (requeued > 0) logger.info({ requeued }, 'requeued runs interrupted by a restart')
  })
  .catch((error: unknown) => {
    logger.error({ err: error }, 'could not reconcile interrupted runs')
  })

/**
 * The daily inbox sweep.
 *
 * On the worker rather than the runner: reading mail is an HTTP call, not a
 * browser session, and it has no business paying for a Chromium image.
 */
startWorker<InboxJobData>(
  QUEUE.inbox,
  async (job) => {
    const { userId } = job.data
    await withUserResourceLock(userId, 'inbox', async () => {
      const source = await sourceFor(userId)
      if (!source) {
        logger.info({ userId }, 'inbox sweep skipped — no mail source connected')
        return
      }
      const result = await sweepInbox(userId, source)
      logger.info({ userId, ...result }, 'inbox swept')
      await db
        .update(userSchedules)
        .set({ lastInboxAt: new Date(), updatedAt: new Date() })
        .where(eq(userSchedules.userId, userId))
    })
  },
  { concurrency: 4, lockDuration: 60_000, maxStalledCount: 1 },
)

logger.info('Huntly worker started')

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  logger.info({ signal }, 'stopping Huntly worker')

  const force = setTimeout(() => {
    logger.error('worker shutdown timed out — forcing exit')
    process.exit(1)
  }, 30_000)
  force.unref()

  try {
    await closeQueues()
    await closeRedis()
    await closeDatabase()
  } catch (error) {
    logger.error({ err: error }, 'error while shutting down the worker')
  }
  clearTimeout(force)
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection in worker')
})
