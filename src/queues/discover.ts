import { and, eq, inArray, lt } from 'drizzle-orm'
import { db } from '../db/client.js'
import { huntRuns, huntSpecs, userSchedules } from '../db/schema.js'
import { discoverForRun } from '../hunt/discovery/service.js'
import { isLocked, withUserResourceLock } from '../lib/locks.js'
import { logger } from '../lib/logger.js'
import { getRedis } from '../lib/redis.js'
import { recordActivity } from '../services/activity.js'
import type { HuntJobRequest, HuntQueue } from '../services/hunt-queue.js'
import { getQueue, startWorker } from './index.js'
import { QUEUE, type DiscoverJobData } from './names.js'

/**
 * Discovery as a durable job.
 *
 * It used to run as `void discoverForRun(...)` inside the POST handler: a
 * promise nobody held, on a process that restarts on every deploy. A scrape
 * interrupted that way left a `hunt_runs` row stuck in `running` with no way
 * back. On a queue it survives the restart and retries on its own terms.
 */

function stopKey(runId: string): string {
  return `huntly:run-stop:${runId}`
}

export async function isStopRequested(runId: string): Promise<boolean> {
  return (await getRedis().exists(stopKey(runId))) === 1
}

class BullHuntQueue implements HuntQueue {
  readonly name = 'bullmq'
  readonly isReal = true

  async enqueue(request: HuntJobRequest): Promise<{ jobId: string }> {
    const data: DiscoverJobData = {
      userId: request.userId,
      runId: request.runId,
      targetApplications: request.targetApplications,
      trigger: 'manual',
    }
    // Keyed on the run so a double-submitted form cannot start two scrapes.
    const job = await getQueue<DiscoverJobData>(QUEUE.discover).add('discover', data, {
      jobId: `discover-${request.runId}`,
    })
    return { jobId: job.id ?? `discover-${request.runId}` }
  }

  async requestStop(runId: string): Promise<void> {
    // Two mechanisms, because a run may be either waiting or already going.
    await getRedis().set(stopKey(runId), '1', 'EX', 6 * 3600)
    const job = await getQueue<DiscoverJobData>(QUEUE.discover).getJob(`discover-${runId}`)
    if (job && (await job.isWaiting())) await job.remove()
  }
}

export function createHuntQueue(): HuntQueue {
  return new BullHuntQueue()
}

/** Statuses that mean a hunt is already under way for this user. */
const ACTIVE_STATUSES = ['queued', 'running', 'awaiting_approval', 'applying'] as const

/**
 * Creates the run row for a scheduled hunt, or returns null when one is
 * already active. A daily job that fired while yesterday's run is still
 * awaiting approval should wait, not stack a second run on top of it.
 */
async function openScheduledRun(userId: string): Promise<{ id: string } | null> {
  const [active] = await db
    .select({ id: huntRuns.id })
    .from(huntRuns)
    .where(and(eq(huntRuns.userId, userId), inArray(huntRuns.status, [...ACTIVE_STATUSES])))
    .limit(1)
  if (active) {
    logger.info({ userId, runId: active.id }, 'scheduled hunt skipped — a run is already active')
    return null
  }

  const [spec] = await db
    .select({ dailyTarget: huntSpecs.dailyTarget, isActive: huntSpecs.isActive })
    .from(huntSpecs)
    .where(eq(huntSpecs.userId, userId))
    .limit(1)
  if (!spec) {
    logger.info({ userId }, 'scheduled hunt skipped — no hunt spec saved yet')
    return null
  }
  if (!spec.isActive) {
    logger.info({ userId }, 'scheduled hunt skipped — spec is paused')
    return null
  }

  const [run] = await db
    .insert(huntRuns)
    .values({
      userId,
      status: 'queued',
      targetApplications: Math.min(spec.dailyTarget, 100),
    })
    .returning({ id: huntRuns.id })
  return run ?? null
}

/**
 * How stale a `queued`/`running` run must be before boot treats it as
 * abandoned. Long enough that a slow scrape is never mistaken for a dead one —
 * and the lock check below is the real guard anyway.
 */
const ABANDONED_AFTER_MS = 3 * 60_000

/**
 * Re-queues runs that were interrupted by a restart.
 *
 * BullMQ's own stalled-job detection is a backstop, not a guarantee: it
 * depends on lock expiry and check intervals lining up, and in practice a run
 * can sit in `active` with no worker and no lock. For a product where one lost
 * run is a lost day of applications, recovery should be something we assert
 * rather than something we hope the queue does.
 *
 * The safety check is the user's discovery lock. If it is held, a worker is
 * genuinely mid-scrape and the row is simply between status writes — leave it
 * alone. If it is not held and the row has not moved in minutes, nothing is
 * working on it.
 */
export async function reconcileInterruptedRuns(): Promise<number> {
  const cutoff = new Date(Date.now() - ABANDONED_AFTER_MS)
  const stale = await db
    .select({
      id: huntRuns.id,
      userId: huntRuns.userId,
      target: huntRuns.targetApplications,
    })
    .from(huntRuns)
    .where(and(inArray(huntRuns.status, ['queued', 'running']), lt(huntRuns.updatedAt, cutoff)))

  let requeued = 0
  const queue = getQueue<DiscoverJobData>(QUEUE.discover)

  for (const run of stale) {
    if (await isLocked(run.userId, 'discover')) continue
    if (await isStopRequested(run.id)) continue

    // Clear whatever the crash left behind — an orphaned active entry keeps
    // the job id taken, so a plain re-add would be silently ignored.
    const existing = await queue.getJob(`discover-${run.id}`)
    if (existing) await existing.remove({ removeChildren: true }).catch(() => undefined)

    await queue.add(
      'discover',
      { userId: run.userId, runId: run.id, targetApplications: run.target, trigger: 'manual' },
      { jobId: `discover-${run.id}` },
    )
    requeued += 1
    logger.info({ runId: run.id, userId: run.userId }, 'requeued a run interrupted by a restart')
  }

  return requeued
}

async function failRun(runId: string, error: unknown): Promise<void> {
  await db
    .update(huntRuns)
    .set({
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(huntRuns.id, runId))
    .catch((updateError: unknown) => {
      logger.error({ err: updateError, runId }, 'could not mark run as failed')
    })
}

export function startDiscoverWorker() {
  return startWorker<DiscoverJobData>(
    QUEUE.discover,
    async (job) => {
      // A recurring sweep shares this queue rather than owning one: it needs
      // the same Redis and the same worker, and one queue is one less thing to
      // configure. It carries no payload.
      if (job.name === 'reconcile') {
        const requeued = await reconcileInterruptedRuns()
        if (requeued > 0) logger.info({ requeued }, 'reconcile sweep requeued interrupted runs')
        return
      }

      const { userId, trigger } = job.data

      const runId =
        job.data.runId ?? (trigger === 'daily' ? (await openScheduledRun(userId))?.id ?? null : null)
      if (!runId) return

      if (await isStopRequested(runId)) {
        logger.info({ runId }, 'discovery skipped — stop was requested before it started')
        return
      }

      // One discovery per user at a time. Two concurrent scrapes would race on
      // the same `hunt_runs` row and double every source's rate limit.
      await withUserResourceLock(userId, 'discover', async () => {
        try {
          const discovery = await discoverForRun(userId, runId)
          await recordActivity({
            userId,
            kind: 'jobs_scraped',
            text: `Found ${discovery.candidates.length} jobs ready for review.`,
            meta: { runId, candidates: discovery.candidates.length, trigger },
          })
          if (trigger === 'daily') {
            await db
              .update(userSchedules)
              .set({ lastDiscoverAt: new Date(), updatedAt: new Date() })
              .where(eq(userSchedules.userId, userId))
          }
        } catch (error) {
          await failRun(runId, error)
          throw error
        }
      })
    },
    {
      concurrency: 4,
      // BullMQ renews this lock automatically while the process is alive, so a
      // long duration buys nothing for long jobs — it only delays reclaiming
      // work from a worker that died. Sixty seconds means a crashed discovery
      // is picked up again within about a minute.
      lockDuration: 60_000,
      // Re-run a discovery that was interrupted. Safe because the whole
      // pipeline upserts by fingerprint: running it twice converges rather
      // than duplicating. (The apply queue sets this to 0 for the opposite
      // reason — never re-submit an application after a crash.)
      maxStalledCount: 2,
    },
  )
}
