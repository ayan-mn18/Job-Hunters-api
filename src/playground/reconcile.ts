import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { playgroundRuns } from '../db/schema.js'
import { logger } from '../lib/logger.js'
import { stopBrowser } from '../browser/client.js'
import { clearReplies } from './replies.js'
import { say, setState } from './store.js'

/**
 * Cleaning up after a runner that died mid-run.
 *
 * `session.close()` lives in a `finally`, which covers every way a run can end
 * except the process going away underneath it. When that happens the hosted
 * browser is not stopped by anything — it keeps running, and keeps billing,
 * until its own timeout expires. That is not theoretical: it happened during
 * development, and cost two tenths of a cent before it was noticed.
 *
 * A run left in a live status when the process that owned it is gone cannot be
 * resumed — the browser it was driving is mid-form and nothing remembers where
 * — so this stops the browser and marks the run failed rather than pretending
 * it can be picked back up.
 */

/** Statuses that mean a run believed it was still in progress. */
const LIVE = ['queued', 'launching', 'searching', 'shortlisted', 'applying', 'blocked'] as const

export async function reconcileInterruptedPlaygroundRuns(): Promise<void> {
  const stranded = await db
    .select()
    .from(playgroundRuns)
    .where(and(inArray(playgroundRuns.status, [...LIVE]), isNotNull(playgroundRuns.browserSessionId)))

  if (stranded.length === 0) return
  logger.warn({ count: stranded.length }, 'stopping browsers left behind by an interrupted runner')

  for (const run of stranded) {
    if (run.browserSessionId) {
      await stopBrowser(run.browserSessionId).catch((error: unknown) => {
        logger.error(
          { err: error, sessionId: run.browserSessionId },
          'could not stop an abandoned browser — it will bill until its timeout',
        )
      })
    }
    await clearReplies(run.id)

    const ref = { id: run.id, userId: run.userId }
    await say(ref, 'huntly', 'The server restarted while this was running, so it stopped.').catch(
      () => undefined,
    )
    await setState(ref, {
      status: 'failed',
      error: 'The server restarted while this run was in progress.',
      completedAt: new Date(),
    }).catch(() => undefined)
  }
}
