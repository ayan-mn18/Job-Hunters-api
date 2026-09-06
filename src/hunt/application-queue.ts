import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { Redis } from 'ioredis'
import { Queue, Worker, type Job as BullJob } from 'bullmq'
import { and, count, eq, inArray, lt, notInArray, sql } from 'drizzle-orm'
import { env, hasRedis } from '../config/env.js'
import { db } from '../db/client.js'
import { applications, applyAttempts, huntCandidates, huntRunJobs, huntRuns } from '../db/schema.js'
import { serviceUnavailable } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { stopBrowser } from '../browser/client.js'
import { applyApprovedCandidate } from './apply.js'

const QUEUE_NAME = 'hunt-apply'
const APPLY_WINDOW_MS = 11 * 60 * 60 * 1000
const MAX_DAILY_APPLICATIONS = 100
const INTERRUPTED_AFTER_MS = 3 * 60_000
const DEFAULT_PORTAL_CAP = 30
const PORTAL_CAPS: Record<string, number> = {
  greenhouse: 35,
  ashby: 30,
  lever: 30,
  wellfound: 15,
  instahyre: 15,
}

interface ApplyJobData {
  userId: string
  runId: string
  candidateId: string
  portal: string
}

let connection: Redis | undefined
let queue: Queue<ApplyJobData> | undefined

function redis(): Redis {
  if (!hasRedis || !env.REDIS_URL) throw serviceUnavailable('REDIS_URL is required for approved applications.')
  connection ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
  return connection
}

export function assertApplicationQueueConfigured(): void {
  if (!hasRedis || !env.REDIS_URL) {
    throw serviceUnavailable('REDIS_URL is required before approving application batches.')
  }
}

function applicationQueue(): Queue<ApplyJobData> {
  queue ??= new Queue<ApplyJobData>(QUEUE_NAME, { connection: redis() })
  return queue
}

function roundRobin<T extends { portal: string }>(values: T[]): T[] {
  const groups = new Map<string, T[]>()
  for (const value of values) {
    const group = groups.get(value.portal)
    if (group) group.push(value)
    else groups.set(value.portal, [value])
  }
  const ordered: T[] = []
  while (ordered.length < values.length) {
    for (const group of groups.values()) {
      const next = group.shift()
      if (next) ordered.push(next)
    }
  }
  return ordered
}

function applyPortalCaps<T extends { portal: string }>(values: T[]): T[] {
  const counts = new Map<string, number>()
  return values.filter((value) => {
    const count = counts.get(value.portal) ?? 0
    const cap = PORTAL_CAPS[value.portal] ?? DEFAULT_PORTAL_CAP
    if (count >= cap) return false
    counts.set(value.portal, count + 1)
    return true
  })
}

export function planApplicationOrder<T extends { portal: string }>(values: T[], target: number): T[] {
  return roundRobin(applyPortalCaps(values)).slice(0, Math.min(target, MAX_DAILY_APPLICATIONS))
}

async function withPortalLock<T>(data: ApplyJobData, operation: () => Promise<T>): Promise<T> {
  const key = `huntly:apply-lock:${data.userId}:${data.portal}`
  const token = crypto.randomUUID()
  const deadline = Date.now() + 15 * 60_000
  let acquired = false
  while (!acquired && Date.now() < deadline) {
    acquired = (await redis().set(key, token, 'PX', 15 * 60_000, 'NX')) === 'OK'
    if (!acquired) await sleep(5_000)
  }
  if (!acquired) throw new Error(`Portal lane ${data.portal} stayed busy for 15 minutes.`)
  try {
    return await operation()
  } finally {
    await redis().eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
      1,
      key,
      token,
    )
  }
}

export async function enqueueApprovedCandidates(
  userId: string,
  runId: string,
  selectedIds: string[],
): Promise<{ queued: number; capped: boolean }> {
  const [[run], selectedRows] = await Promise.all([
    db.select({ target: huntRuns.targetApplications })
      .from(huntRuns)
      .where(and(eq(huntRuns.id, runId), eq(huntRuns.userId, userId)))
      .limit(1),
    db.select({ id: huntCandidates.id, jobId: huntCandidates.jobId, portal: huntCandidates.sourcePortal })
      .from(huntCandidates)
      .where(and(
        eq(huntCandidates.userId, userId),
        eq(huntCandidates.runId, runId),
        inArray(huntCandidates.id, selectedIds),
      )),
  ])
  if (!run) throw serviceUnavailable('Hunt run disappeared before queueing.')
  const target = Math.min(run.target, MAX_DAILY_APPLICATIONS)
  const order = new Map(selectedIds.map((id, index) => [id, index]))
  const selected = selectedRows.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0))
  const ordered = planApplicationOrder(selected, target)
  if (ordered.length === 0) return { queued: 0, capped: selected.length > 0 }

  const spacing = Math.floor(APPLY_WINDOW_MS / ordered.length)
  await applicationQueue().addBulk(ordered.map((candidate, index) => ({
    name: 'apply-approved-candidate',
    data: { userId, runId, candidateId: candidate.id, portal: candidate.portal },
    opts: {
      jobId: `apply-${userId}-${candidate.id}`,
      delay: index * spacing,
      attempts: 1,
      removeOnComplete: { age: 7 * 86_400 },
      removeOnFail: { age: 30 * 86_400 },
    },
  })))

  await db
    .update(huntCandidates)
    .set({ status: 'queued', updatedAt: new Date() })
    .where(inArray(huntCandidates.id, ordered.map((candidate) => candidate.id)))
  await db
    .update(huntRunJobs)
    .set({ status: 'queued', updatedAt: new Date() })
    .where(and(
      eq(huntRunJobs.runId, runId),
      inArray(huntRunJobs.jobId, ordered.map((candidate) => candidate.jobId)),
    ))
  await db
    .update(huntCandidates)
    .set({ status: 'rejected', updatedAt: new Date() })
    .where(and(
      inArray(huntCandidates.id, selected.map((candidate) => candidate.id)),
      notInArray(huntCandidates.id, ordered.map((candidate) => candidate.id)),
    ))
  const rejectedJobIds = selected
    .filter((candidate) => !ordered.some((queued) => queued.id === candidate.id))
    .map((candidate) => candidate.jobId)
  if (rejectedJobIds.length > 0) {
    await db
      .update(huntRunJobs)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(and(eq(huntRunJobs.runId, runId), inArray(huntRunJobs.jobId, rejectedJobIds)))
  }
  await db
    .update(huntRuns)
    .set({
      status: 'applying',
      candidatesApproved: ordered.length,
      approvedAt: new Date(),
      progress: { stage: 'apply', queued: ordered.length, target },
      updatedAt: new Date(),
    })
    .where(and(eq(huntRuns.id, runId), eq(huntRuns.userId, userId)))

  return { queued: ordered.length, capped: selected.length > ordered.length }
}

async function finishRunWhenSettled(job: BullJob<ApplyJobData>): Promise<void> {
  const [active] = await db
    .select({ value: count() })
    .from(huntCandidates)
    .where(and(
      eq(huntCandidates.runId, job.data.runId),
      inArray(huntCandidates.status, ['approved', 'tailored', 'queued', 'applying']),
    ))
  if ((active?.value ?? 0) > 0) return
  await db
    .update(huntRuns)
    .set({ status: 'completed', finishedAt: new Date(), progress: { stage: 'completed' }, updatedAt: new Date() })
    .where(eq(huntRuns.id, job.data.runId))
}

/**
 * A queue job can disappear after its database writes have begun — for
 * example when the browser runner is killed between creating an attempt and
 * opening a session. Discovery already has this recovery path; application
 * work needs the same one or the dashboard can report "applying" forever.
 */
export async function reconcileInterruptedApplications(): Promise<number> {
  const cutoff = new Date(Date.now() - INTERRUPTED_AFTER_MS)
  const jobs = await applicationQueue().getJobs(['active', 'waiting', 'delayed'])
  const liveJobs = new Set(jobs.map((job) => `${job.data.runId}:${job.data.candidateId}`))
  const stale = await db
    .select({
      candidateId: huntCandidates.id,
      userId: huntCandidates.userId,
      runId: huntCandidates.runId,
      jobId: huntCandidates.jobId,
      candidateStatus: huntCandidates.status,
      attemptId: applyAttempts.id,
      browserSessionId: applyAttempts.browserSessionId,
    })
    .from(huntCandidates)
    .innerJoin(huntRuns, eq(huntRuns.id, huntCandidates.runId))
    .leftJoin(
      applyAttempts,
      and(
        eq(applyAttempts.candidateId, huntCandidates.id),
        inArray(applyAttempts.status, ['pending', 'submitting']),
      ),
    )
    .where(and(
      eq(huntRuns.status, 'applying'),
      inArray(huntCandidates.status, ['queued', 'applying']),
      lt(huntCandidates.updatedAt, cutoff),
    ))

  const repairedRuns = new Set<string>()
  let repaired = 0
  for (const row of stale) {
    if (liveJobs.has(`${row.runId}:${row.candidateId}`)) continue

    const [updatedCandidate] = await db
      .update(huntCandidates)
      .set({ status: 'needs_review', updatedAt: new Date() })
      .where(and(
        eq(huntCandidates.id, row.candidateId),
        inArray(huntCandidates.status, ['queued', 'applying']),
      ))
      .returning({ id: huntCandidates.id })
    if (!updatedCandidate) continue

    if (row.attemptId) {
      await db
        .update(applyAttempts)
        .set({
          status: 'unknown',
          error: 'Application worker stopped before this attempt completed.',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(applyAttempts.id, row.attemptId))
    }
    if (row.browserSessionId) {
      await stopBrowser(row.browserSessionId).catch((error: unknown) => {
        logger.warn({ err: error, sessionId: row.browserSessionId }, 'could not stop an interrupted browser session')
      })
    }
    await db
      .update(applications)
      .set({ status: 'needs_review', updatedAt: new Date() })
      .where(and(
        eq(applications.userId, row.userId),
        eq(applications.jobId, row.jobId),
        eq(applications.status, 'queued'),
      ))
    await db
      .update(huntRunJobs)
      .set({ status: 'needs_review', updatedAt: new Date() })
      .where(and(eq(huntRunJobs.runId, row.runId), eq(huntRunJobs.jobId, row.jobId)))
    await db
      .update(huntRuns)
      .set({
        applicationsNeedsReview: sql`${huntRuns.applicationsNeedsReview} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(huntRuns.id, row.runId))

    repairedRuns.add(row.runId)
    repaired += 1
    logger.warn({ runId: row.runId, candidateId: row.candidateId, candidateStatus: row.candidateStatus }, 'repaired an interrupted application')
  }

  for (const runId of repairedRuns) {
    const [active] = await db
      .select({ value: count() })
      .from(huntCandidates)
      .where(and(
        eq(huntCandidates.runId, runId),
        inArray(huntCandidates.status, ['approved', 'tailored', 'queued', 'applying']),
      ))
    if ((active?.value ?? 0) === 0) {
      await db
        .update(huntRuns)
        .set({
          status: 'failed',
          error: 'Application worker stopped before this hunt finished. Review the interrupted applications before retrying.',
          finishedAt: new Date(),
          progress: { stage: 'failed', reason: 'application_worker_interrupted' },
          updatedAt: new Date(),
        })
        .where(and(eq(huntRuns.id, runId), eq(huntRuns.status, 'applying')))
    }
  }

  return repaired
}

async function handleFailedApplicationJob(job: BullJob<ApplyJobData>, error: Error): Promise<void> {
  const [candidate] = await db
    .select({ id: huntCandidates.id, runId: huntCandidates.runId, userId: huntCandidates.userId, jobId: huntCandidates.jobId })
    .from(huntCandidates)
    .where(and(eq(huntCandidates.id, job.data.candidateId), eq(huntCandidates.userId, job.data.userId)))
    .limit(1)
  if (candidate) {
    await db
      .update(applyAttempts)
      .set({
        status: 'unknown',
        error: `Application job failed before completion: ${error.message}`,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(applyAttempts.candidateId, candidate.id),
        inArray(applyAttempts.status, ['pending', 'submitting']),
      ))
    const [updated] = await db
      .update(huntCandidates)
      .set({ status: 'needs_review', updatedAt: new Date() })
      .where(and(eq(huntCandidates.id, candidate.id), inArray(huntCandidates.status, ['queued', 'applying'])))
      .returning({ id: huntCandidates.id })
    if (updated) {
      await db
        .update(applications)
        .set({ status: 'needs_review', updatedAt: new Date() })
        .where(and(
          eq(applications.userId, candidate.userId),
          eq(applications.jobId, candidate.jobId),
          eq(applications.status, 'queued'),
        ))
      await db
        .update(huntRunJobs)
        .set({ status: 'needs_review', updatedAt: new Date() })
        .where(and(eq(huntRunJobs.runId, candidate.runId), eq(huntRunJobs.jobId, candidate.jobId)))
      await db
        .update(huntRuns)
        .set({ applicationsNeedsReview: sql`${huntRuns.applicationsNeedsReview} + 1`, updatedAt: new Date() })
        .where(eq(huntRuns.id, candidate.runId))
    }
  }
  await finishRunWhenSettled(job)
  logger.error({ err: error, jobId: job.id, candidateId: job.data.candidateId }, 'application job failed')
}

export function startApplicationWorker(): Worker<ApplyJobData> {
  const worker = new Worker<ApplyJobData>(
    QUEUE_NAME,
    async (job) => {
      await withPortalLock(job.data, () => applyApprovedCandidate(job.data.userId, job.data.candidateId))
      await finishRunWhenSettled(job)
    },
    {
      connection: redis(),
      concurrency: env.RUNNER_APPLY_CONCURRENCY,
      limiter: { max: env.RUNNER_APPLY_CONCURRENCY, duration: 60_000 },
      // Hosted browser sessions can spend several minutes opening a portal,
      // filling a form and waiting for a human takeover. The queue lock must
      // cover that window or BullMQ will mark a healthy browser job stalled.
      lockDuration: 15 * 60_000,
      maxStalledCount: 0,
    },
  )
  worker.on('failed', (job, error) => {
    if (job) void handleFailedApplicationJob(job, error).catch((recoveryError: unknown) => {
      logger.error({ err: recoveryError, jobId: job.id, candidateId: job.data.candidateId }, 'could not reconcile a failed application job')
    })
  })
  return worker
}

export async function closeApplicationQueue(): Promise<void> {
  if (queue) await queue.close()
  queue = undefined
  if (connection) await connection.quit()
  connection = undefined
}
