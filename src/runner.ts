import { hasRedis, env } from './config/env.js'
import { closeDatabase } from './db/client.js'
import { closeApplicationQueue, reconcileInterruptedApplications, startApplicationWorker } from './hunt/application-queue.js'
import { logger } from './lib/logger.js'
import { closeRedis } from './lib/redis.js'
import { closeQueues, startWorker } from './queues/index.js'
import { QUEUE, type OutreachJobData, type PlaygroundJobData, type ReferralSyncJobData } from './queues/names.js'
import { registerQueueImplementations } from './queues/register.js'
import { withUserResourceLock } from './lib/locks.js'
import { syncLinkedInReferrals } from './services/linkedin-referrals.js'
import { getQueue } from './queues/index.js'
import { markSent, nextSendable, pacingDelayMs, tripBreaker } from './outreach/sequence.js'
import { CheckpointError } from './skills/linkedin/send.js'
import { send as sendOnLinkedIn } from './skills/linkedin/outreach.js'
import { NoLinkedInSessionError, openLinkedInSession } from './skills/linkedin/session.js'
import { sweepOutreachTargets } from './outreach/sweep.js'
import { executePlaygroundRun } from './playground/run.js'
import { reconcileInterruptedPlaygroundRuns } from './playground/reconcile.js'

/**
 * The runner process: everything that needs a real browser.
 *
 * Separated from the worker because this image carries Chromium and scales on
 * memory — roughly 300–500 MB per live context — while the worker scales on
 * throughput. One image doing both means paying for the browser on every
 * replica that only wanted to score a job posting.
 *
 * Every job here takes a per-user lock before it opens a page. One live
 * session per user per resource is both a correctness rule and the single most
 * important control for not looking like automation to a portal.
 */

if (!hasRedis) {
  logger.fatal('REDIS_URL is required to run the browser runner.')
  process.exit(1)
}

if (!env.PORTAL_AUTOMATION_ENABLED) {
  logger.warn(
    'PORTAL_AUTOMATION_ENABLED is false — the runner will start, but every browser job will fail fast.',
  )
}

registerQueueImplementations()

// The apply queue predates the shared registry and owns its own worker
// configuration — concurrency, portal locks and pacing that are tuned and
// tested. It keeps them.
startApplicationWorker()
logger.info({ queue: QUEUE.apply, concurrency: env.RUNNER_APPLY_CONCURRENCY }, 'worker started')

// A browser left behind by a killed runner is not stopped by anything else,
// and bills until its own timeout.
void reconcileInterruptedPlaygroundRuns().catch((error: unknown) => {
  logger.error({ err: error }, 'could not reconcile interrupted playground runs')
})

void reconcileInterruptedApplications().catch((error: unknown) => {
  logger.error({ err: error }, 'could not reconcile interrupted applications in runner')
})

startWorker<ReferralSyncJobData>(
  QUEUE.referralSync,
  async (job) => {
    const { userId, days } = job.data
    await withUserResourceLock(userId, 'linkedin', async () => {
      await syncLinkedInReferrals(userId, days)

      // Prospecting shares the lock, not the browser: the sync closes its own
      // context before this opens one, so the account never has two sessions
      // live at the same moment.
      let session: Awaited<ReturnType<typeof openLinkedInSession>> | undefined
      try {
        session = await openLinkedInSession(userId)
        const outcome = await sweepOutreachTargets(userId, session.context)
        if (outcome.companiesLookedAt > 0) {
          logger.info({ userId, ...outcome }, 'outreach prospecting finished')
        }
      } catch (error) {
        if (error instanceof CheckpointError) {
          await tripBreaker(userId, error.message)
          return
        }
        if (error instanceof NoLinkedInSessionError) return
        throw error
      } finally {
        await session?.close()
      }
    })
  },
  { concurrency: 2, lockDuration: 60_000, maxStalledCount: 1 },
)

/**
 * Outreach: one message per job, and never more than one at a time.
 *
 * Concurrency 1 globally, not just per user. This is the slowest thing in the
 * system on purpose — the pacing between sends is measured in minutes, and a
 * queue that could run two of these side by side would defeat every cap in
 * `limits.ts` the moment a second user was added.
 */
startWorker<OutreachJobData>(
  QUEUE.outreach,
  async (job) => {
    const { userId } = job.data
    await withUserResourceLock(userId, 'outreach', async () => {
      const next = await nextSendable(userId)
      if ('blocked' in next) {
        logger.info({ userId, reason: next.blocked }, 'outreach idle')
        return
      }

      const message = next.message
      let session: Awaited<ReturnType<typeof openLinkedInSession>> | undefined
      try {
        session = await openLinkedInSession(userId)
        const result = await sendOnLinkedIn(session, message)

        await markSent(userId, message, result.ok ? { ok: true } : { ok: false, error: result.error ?? 'unknown' })
        logger.info(
          { userId, kind: message.kind, to: message.name, ok: result.ok },
          'outreach message processed',
        )

        // Only queue the next one if this one actually went. A failure that
        // repeats every few minutes is a loop, not a sequence.
        if (result.ok) {
          await getQueue<OutreachJobData>(QUEUE.outreach).add(
            'send',
            { userId },
            { delay: pacingDelayMs(), jobId: `outreach-${userId}-${Date.now()}` },
          )
        }
      } catch (error) {
        if (error instanceof CheckpointError) {
          // The platform is asking whether this is a human. Stop everything on
          // this account rather than trying again more carefully.
          await tripBreaker(userId, error.message)
          return
        }
        if (error instanceof NoLinkedInSessionError) {
          logger.info({ userId }, 'outreach skipped — no LinkedIn session connected')
          return
        }
        throw error
      } finally {
        await session?.close()
      }
    })
  },
  { concurrency: 1, lockDuration: 5 * 60_000, maxStalledCount: 0 },
)

logger.info('Huntly browser runner started')

/**
 * A playground run: one job, watched, with somebody able to answer questions
 * partway through.
 *
 * No user lock, unlike every other browser job here. A run is started by a
 * person who is sitting and watching it, and making them queue behind a
 * scheduled referral sync would make the feature feel broken. The browser
 * ceiling in `openSession` is what actually bounds concurrency.
 *
 * `attempts: 1`. A run that failed halfway has already told the user what
 * happened, and silently starting a second browser to redo an application is
 * the last thing anyone wants.
 */
startWorker<PlaygroundJobData>(
  QUEUE.playground,
  async (job) => {
    await executePlaygroundRun(job.data.runId)
  },
  { concurrency: 2, lockDuration: 120_000, maxStalledCount: 1 },
)

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  logger.info({ signal }, 'stopping Huntly browser runner')

  // Browser jobs are long. Give them room to close pages and release locks
  // before the process is taken away from them.
  const force = setTimeout(() => {
    logger.error('runner shutdown timed out — forcing exit')
    process.exit(1)
  }, 60_000)
  force.unref()

  try {
    await closeQueues()
    await closeApplicationQueue()
    await closeRedis()
    await closeDatabase()
  } catch (error) {
    logger.error({ err: error }, 'error while shutting down the runner')
  }
  clearTimeout(force)
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection in runner')
})
