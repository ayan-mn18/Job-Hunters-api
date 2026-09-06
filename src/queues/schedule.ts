import { eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { env } from '../config/env.js'
import { userSchedules, users, type UserSchedule } from '../db/schema.js'
import { logger } from '../lib/logger.js'
import { getQueue } from './index.js'
import { QUEUE, type DiscoverJobData, type InboxJobData, type ReferralSyncJobData } from './names.js'

/**
 * Daily work, as BullMQ job schedulers.
 *
 * This replaces `startLinkedInReferralScheduler()`, which was a `setInterval`
 * inside the web process: it duplicated on every replica, died with the dyno,
 * and ran on a fixed hourly tick rather than at an hour the user chose.
 *
 * Scheduler ids are deterministic — `daily-<queue>-<userId>` — so registering
 * the same schedule from three replicas produces one schedule, not three. That
 * idempotence is why no separate scheduler process is needed.
 */

function schedulerId(queue: string, userId: string): string {
  return `daily-${queue}-${userId}`
}

/** Cron for "every day at this local hour", left to BullMQ to evaluate in tz. */
function dailyAt(hour: number): string {
  const safeHour = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 7
  return `0 ${safeHour} * * *`
}

async function applyOne(
  queueName: (typeof QUEUE)[keyof typeof QUEUE],
  row: UserSchedule,
  enabled: boolean,
  payload: { name: string; data: DiscoverJobData | InboxJobData | ReferralSyncJobData },
): Promise<void> {
  const queue = getQueue(queueName)
  const id = schedulerId(queueName, row.userId)

  if (!enabled) {
    // Removing a scheduler that was never registered is a no-op, so this is
    // safe to run on every boot for every disabled row.
    await queue.removeJobScheduler(id).catch(() => undefined)
    return
  }

  await queue.upsertJobScheduler(
    id,
    { pattern: dailyAt(row.runHourLocal), tz: row.timezone },
    payload,
  )
}

/** Registers, updates or removes one user's schedules to match their row. */
export async function syncUserSchedule(row: UserSchedule): Promise<void> {
  await applyOne(QUEUE.discover, row, row.discoverEnabled, {
    name: 'discover',
    data: { userId: row.userId, runId: null, targetApplications: null, trigger: 'daily' },
  })
  await applyOne(QUEUE.inbox, row, row.inboxEnabled, {
    name: 'inbox',
    data: { userId: row.userId },
  })
  await applyOne(QUEUE.referralSync, row, row.referralEnabled, {
    name: 'referral-sync',
    data: { userId: row.userId, days: 1 },
  })
}

/**
 * Gives every onboarded user a schedule row if they lack one, defaulting to
 * the deployment timezone. Idempotent, and cheap enough to run at every boot.
 */
export async function backfillSchedules(): Promise<number> {
  // Two statements rather than an INSERT ... SELECT: drizzle's insert-select
  // requires the projection to match the table's full column list in order,
  // which would mean restating ten defaults here just to keep them.
  const missing = await db
    .select({ userId: users.id })
    .from(users)
    .leftJoin(userSchedules, eq(userSchedules.userId, users.id))
    .where(isNull(userSchedules.userId))

  if (missing.length === 0) return 0

  const inserted = await db
    .insert(userSchedules)
    .values(missing.map((row) => ({ userId: row.userId, timezone: env.APP_TIMEZONE })))
    .onConflictDoNothing()
    .returning({ userId: userSchedules.userId })
  return inserted.length
}

/**
 * Nightly: refit every active user's score weights from what they approved and
 * rejected that day. One sweep for the deployment, at a quiet hour.
 */
export async function registerLearningSweep(): Promise<void> {
  await getQueue(QUEUE.learn).upsertJobScheduler(
    'refit-weights',
    { pattern: '0 3 * * *', tz: env.APP_TIMEZONE },
    { name: 'refit', data: {} },
  )
}

/**
 * A queue-wide sweep that re-queues runs a crashed worker abandoned. Every
 * five minutes, registered once for the whole deployment rather than per user.
 */
export async function registerReconcileSweep(): Promise<void> {
  await getQueue(QUEUE.discover).upsertJobScheduler(
    'reconcile-runs',
    { every: 5 * 60_000 },
    { name: 'reconcile', data: {} },
  )
}

/** Reads every schedule row and makes Redis match it. Run at worker boot. */
export async function syncAllSchedules(): Promise<number> {
  const backfilled = await backfillSchedules()
  if (backfilled > 0) logger.info({ backfilled }, 'created default schedules')

  await registerReconcileSweep()
  await registerLearningSweep()

  const rows = await db.select().from(userSchedules)
  for (const row of rows) {
    await syncUserSchedule(row).catch((error: unknown) => {
      logger.error({ err: error, userId: row.userId }, 'could not sync a user schedule')
    })
  }
  logger.info({ users: rows.length }, 'daily schedules registered')
  return rows.length
}
