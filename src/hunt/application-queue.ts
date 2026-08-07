import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { Redis } from 'ioredis'
import { Queue, Worker, type Job as BullJob } from 'bullmq'
import { and, count, eq, inArray, notInArray } from 'drizzle-orm'
import { env, hasRedis } from '../config/env.js'
import { db } from '../db/client.js'
import { huntCandidates, huntRunJobs, huntRuns } from '../db/schema.js'
import { serviceUnavailable } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { applyApprovedCandidate } from './apply.js'

const QUEUE_NAME = 'hunt-apply'
const APPLY_WINDOW_MS = 11 * 60 * 60 * 1000
const MAX_DAILY_APPLICATIONS = 100
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

export function startApplicationWorker(): Worker<ApplyJobData> {
  const worker = new Worker<ApplyJobData>(
    QUEUE_NAME,
    async (job) => {
      await withPortalLock(job.data, () => applyApprovedCandidate(job.data.userId, job.data.candidateId))
      await finishRunWhenSettled(job)
    },
    {
      connection: redis(),
      concurrency: 3,
      limiter: { max: 3, duration: 60_000 },
      lockDuration: 120_000,
      maxStalledCount: 0,
    },
  )
  worker.on('failed', (job, error) => {
    logger.error({ err: error, jobId: job?.id, candidateId: job?.data.candidateId }, 'application job failed')
  })
  return worker
}

export async function closeApplicationQueue(): Promise<void> {
  if (queue) await queue.close()
  queue = undefined
  if (connection) await connection.quit()
  connection = undefined
}
