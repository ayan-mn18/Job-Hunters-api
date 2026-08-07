import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { huntCandidates, huntRunJobs, huntRuns } from '../db/schema.js'
import { badRequest, notFound } from '../lib/errors.js'
import { assertApplicationQueueConfigured, enqueueApprovedCandidates } from './application-queue.js'

export async function approveDailyBatch(userId: string, runId: string, selectedIds: string[]) {
  assertApplicationQueueConfigured()
  const uniqueIds = [...new Set(selectedIds)].slice(0, 100)
  if (uniqueIds.length === 0) throw badRequest('Select at least one job to approve.')

  const [run] = await db
    .select()
    .from(huntRuns)
    .where(and(eq(huntRuns.id, runId), eq(huntRuns.userId, userId)))
    .limit(1)
  if (!run) throw notFound('Hunt run not found')
  if (run.status !== 'awaiting_approval') throw badRequest('This hunt is not awaiting approval.')

  const reviewable = await db
    .select({ id: huntCandidates.id, jobId: huntCandidates.jobId })
    .from(huntCandidates)
    .where(and(
      eq(huntCandidates.userId, userId),
      eq(huntCandidates.runId, runId),
      eq(huntCandidates.status, 'discovered'),
    ))
  const selectedSet = new Set(uniqueIds)
  const selected = reviewable.filter((candidate) => selectedSet.has(candidate.id))
  if (selected.length !== uniqueIds.length) throw badRequest('One or more selected jobs are unavailable.')
  const rejected = reviewable.filter((candidate) => !selectedSet.has(candidate.id))

  if (rejected.length > 0) {
    await db
      .update(huntCandidates)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(inArray(huntCandidates.id, rejected.map((candidate) => candidate.id)))
    await db
      .update(huntRunJobs)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(and(
        eq(huntRunJobs.runId, runId),
        inArray(huntRunJobs.jobId, rejected.map((candidate) => candidate.jobId)),
      ))
  }
  await db
    .update(huntCandidates)
    .set({ status: 'approved', updatedAt: new Date() })
    .where(inArray(huntCandidates.id, uniqueIds))
  await db
    .update(huntRunJobs)
    .set({ status: 'approved', updatedAt: new Date() })
    .where(and(
      eq(huntRunJobs.runId, runId),
      inArray(huntRunJobs.jobId, selected.map((candidate) => candidate.jobId)),
    ))

  const queued = await enqueueApprovedCandidates(userId, runId, uniqueIds)
  return { selected: uniqueIds.length, ...queued }
}
