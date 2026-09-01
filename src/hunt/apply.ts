import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { and, eq, sql } from 'drizzle-orm'
import type { Page } from 'playwright-core'
import { db } from '../db/client.js'
import {
  applications,
  applyAttempts,
  huntCandidates,
  huntRunJobs,
  huntRuns,
  jobSources,
  jobs,
  resumeVariants,
  type HuntRunJob,
} from '../db/schema.js'
import { env } from '../config/env.js'
import { badRequest, notFound } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { buildObjectKey, downloadObject, uploadObject } from '../lib/storage.js'
import { launchAutomationBrowser } from './browser.js'
import { loadPortalProfile } from './portal-profile.js'
import { provisionPortalAccount } from './portal-accounts.js'
import { createMinimalResumeVariant } from './tailoring.js'
import { fillForm, submitForm } from './apply/fill.js'
import { transition } from './apply/state.js'
import { awaitTakeover, isWatched, startScreencast } from './apply/screencast.js'


async function setRunJobStatus(runId: string, jobId: string, status: HuntRunJob['status']): Promise<void> {
  await db
    .update(huntRunJobs)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(huntRunJobs.runId, runId), eq(huntRunJobs.jobId, jobId)))
}




async function persistEvidence(userId: string, attemptId: string, page: Page): Promise<string> {
  const screenshot = await page.screenshot({ fullPage: true, type: 'png' })
  const key = buildObjectKey(userId, 'application-evidence', `${attemptId}.png`)
  await uploadObject({ key, body: Buffer.from(screenshot), mimeType: 'image/png' })
  return key
}

export async function applyApprovedCandidate(
  userId: string,
  candidateId: string,
  options?: { dryRun?: boolean },
): Promise<void> {
  const [candidateState] = await db
    .select({ resumeVariantId: huntCandidates.resumeVariantId, runId: huntCandidates.runId })
    .from(huntCandidates)
    .where(and(eq(huntCandidates.id, candidateId), eq(huntCandidates.userId, userId)))
    .limit(1)
  if (!candidateState) throw notFound('Approved candidate not found')
  const [runState] = await db
    .select({ status: huntRuns.status })
    .from(huntRuns)
    .where(eq(huntRuns.id, candidateState.runId))
    .limit(1)
  if (!runState || runState.status === 'stopped' || runState.status === 'failed') return
  if (!candidateState.resumeVariantId) await createMinimalResumeVariant(userId, candidateId)
  const [row] = await db
    .select({ candidate: huntCandidates, job: jobs, variant: resumeVariants })
    .from(huntCandidates)
    .innerJoin(jobs, eq(huntCandidates.jobId, jobs.id))
    .innerJoin(resumeVariants, eq(huntCandidates.resumeVariantId, resumeVariants.id))
    .where(and(eq(huntCandidates.id, candidateId), eq(huntCandidates.userId, userId)))
    .limit(1)
  if (!row) throw notFound('Approved candidate or resume variant not found')
  if (
    row.candidate.status !== 'tailored'
    && row.candidate.status !== 'queued'
    && row.candidate.status !== 'applying'
  ) {
    throw badRequest('Candidate is not approved for application.')
  }

  const [source] = await db
    .select()
    .from(jobSources)
    .where(and(eq(jobSources.jobId, row.job.id), eq(jobSources.portalId, row.candidate.sourcePortal)))
    .limit(1)
  const applyUrl = row.job.applyUrl ?? source?.applyUrl ?? row.job.canonicalUrl
  const host = new URL(applyUrl).hostname.toLowerCase()
  if (host.includes('wellfound.com') || host.includes('instahyre.com')) {
    const portal = host.includes('wellfound.com') ? 'wellfound' : 'instahyre'
    const account = await provisionPortalAccount(userId, portal)
    if (account.status !== 'ready') {
      await db
        .update(huntCandidates)
        .set({ status: 'needs_review', updatedAt: new Date() })
        .where(eq(huntCandidates.id, candidateId))
      await setRunJobStatus(row.candidate.runId, row.candidate.jobId, 'needs_review')
      await db.insert(applyAttempts).values({
        candidateId,
        userId,
        portalId: portal,
        status: 'needs_review',
        unresolvedFields: [{ label: account.actionRequired ?? 'Complete portal account verification', type: 'account' }],
        completedAt: new Date(),
      })
      return
    }
  }

  const profile = await loadPortalProfile(userId)
  let [application] = await db
    .insert(applications)
    .values({
      userId,
      jobId: row.job.id,
      role: row.job.title,
      company: row.job.company,
      location: (row.job.locations as Array<{ raw?: string }>).map((item) => item.raw).filter(Boolean).join('; '),
      jobUrl: row.job.canonicalUrl,
      jobDescription: row.job.descriptionText,
      externalJobId: source?.sourceId,
      portalId: source?.portalId ?? row.candidate.sourcePortal,
      portalName: source?.portalId ?? row.candidate.sourcePortal,
      matchScore: row.candidate.score,
      status: 'queued',
      resumeVariantName: row.variant.fileName,
      huntRunId: row.candidate.runId,
    })
    .onConflictDoNothing()
    .returning()
  if (!application) {
    ;[application] = await db
      .select()
      .from(applications)
      .where(and(eq(applications.userId, userId), eq(applications.jobId, row.job.id)))
      .limit(1)
  }
  if (!application) throw new Error('Could not create application record')
  if (application.status === 'applied' || application.status === 'viewed' || application.status === 'interview') {
    await db.update(huntCandidates).set({ status: 'applied', updatedAt: new Date() }).where(eq(huntCandidates.id, candidateId))
    return
  }

  const [attempt] = await db
    .insert(applyAttempts)
    .values({
      candidateId,
      userId,
      portalId: source?.portalId ?? row.candidate.sourcePortal,
      status: 'submitting',
      startedAt: new Date(),
    })
    .returning()
  if (!attempt) throw new Error('Could not create application intent')

  await db.update(huntCandidates).set({ status: 'applying', updatedAt: new Date() }).where(eq(huntCandidates.id, candidateId))
  await setRunJobStatus(row.candidate.runId, row.candidate.jobId, 'applying')
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'huntly-apply-'))
  const browser = await launchAutomationBrowser()
  const dryRun = options?.dryRun ?? env.APPLY_DRY_RUN
  // Declared out here so the `finally` can stop it however the attempt ends.
  let screencast: Awaited<ReturnType<typeof startScreencast>> | null = null

  try {
    await transition({ attemptId: attempt.id, userId, state: 'opening', detail: { applyUrl, dryRun } })

    const resumePath = path.join(scratch, row.variant.fileName)
    await writeFile(resumePath, await downloadObject(row.variant.storagePath))
    const page = await browser.newPage()
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })

    // Stream only when somebody has the live view open. An unwatched
    // application should cost nothing extra.
    screencast = (await isWatched(attempt.id))
      ? await startScreencast({ page, userId, attemptId: attempt.id })
      : null

    await transition({ attemptId: attempt.id, userId, state: 'filling' })
    const result = await fillForm({
      page,
      url: applyUrl,
      userId,
      attemptId: attempt.id,
      profile,
      resumePath,
    })

    const audit = result.fields.map((field) => ({
      label: field.label,
      kind: field.via,
      value: field.filled ? '[provided]' : '[blank]',
    }))

    if (result.unresolved.length > 0) {
      const evidenceStoragePath = await persistEvidence(userId, attempt.id, page)
      await transition({
        attemptId: attempt.id,
        userId,
        state: 'blocked',
        reason: result.unresolved[0]?.why ?? 'needs_input',
        detail: {
          fields: result.unresolved,
          recipe: result.recipe,
          takeoverWindowMs: env.APPLY_TAKEOVER_WINDOW_MS,
        },
      })

      // Hold the page open for a few minutes so the user can finish it in the
      // same browser. This is the difference between handing someone a broken
      // attempt afterwards and letting them rescue it while it is still live.
      if (await isWatched(attempt.id)) {
        const outcome = await awaitTakeover({
          page,
          attemptId: attempt.id,
          windowMs: env.APPLY_TAKEOVER_WINDOW_MS,
        })
        logger.info({ attemptId: attempt.id, outcome }, 'takeover window closed')
        if (outcome === 'released') {
          // They said they are done. Re-read the form and carry on from
          // wherever they left it, rather than starting over.
          const recheck = await fillForm({
            page,
            url: applyUrl,
            userId,
            attemptId: attempt.id,
            profile,
            resumePath,
          })
          if (recheck.unresolved.length === 0) {
            await transition({ attemptId: attempt.id, userId, state: 'submitting', detail: { dryRun, afterTakeover: true } })
            const retried = await submitForm({ page, url: applyUrl, dryRun })
            if (retried.submitted) {
              await transition({ attemptId: attempt.id, userId, state: 'submitted', detail: { afterTakeover: true } })
              await db.update(applyAttempts).set({
                status: 'submitted',
                evidenceStoragePath: await persistEvidence(userId, attempt.id, page),
                completedAt: new Date(),
                updatedAt: new Date(),
              }).where(eq(applyAttempts.id, attempt.id))
              await db.update(huntCandidates).set({ status: 'applied', updatedAt: new Date() }).where(eq(huntCandidates.id, candidateId))
              await db.update(applications).set({ status: 'applied', appliedAt: new Date(), updatedAt: new Date() }).where(eq(applications.id, application.id))
              await setRunJobStatus(row.candidate.runId, row.candidate.jobId, 'applied')
              return
            }
          }
        }
      }
      await db.update(applyAttempts).set({
        submittedFields: audit,
        unresolvedFields: result.unresolved,
        evidenceStoragePath,
        updatedAt: new Date(),
      }).where(eq(applyAttempts.id, attempt.id))
      await db.update(huntCandidates).set({ status: 'needs_review', updatedAt: new Date() }).where(eq(huntCandidates.id, candidateId))
      await db.update(applications).set({ status: 'needs_review', updatedAt: new Date() }).where(eq(applications.id, application.id))
      await db.update(huntRuns).set({
        applicationsNeedsReview: sql`${huntRuns.applicationsNeedsReview} + 1`,
        updatedAt: new Date(),
      }).where(eq(huntRuns.id, row.candidate.runId))
      await setRunJobStatus(row.candidate.runId, row.candidate.jobId, 'needs_review')
      return
    }

    await transition({ attemptId: attempt.id, userId, state: 'submitting', detail: { dryRun } })
    const outcome = await submitForm({ page, url: applyUrl, dryRun })
    const evidenceStoragePath = await persistEvidence(userId, attempt.id, page)

    if (!outcome.submitted) {
      // A dry run is a success, not a failure: the form was filled and the
      // screenshot proves it. Recording it as an error would make the safe
      // mode look broken and push people to turn it off.
      const heldBack = outcome.heldBack === 'dry_run' || outcome.heldBack === 'kill_switch'
      await transition({
        attemptId: attempt.id,
        userId,
        state: heldBack ? 'skipped' : 'blocked',
        ...(heldBack ? {} : { reason: 'needs_input' as const }),
        detail: { heldBack: outcome.heldBack ?? null, recipe: result.recipe },
      })
      await db.update(applyAttempts).set({
        status: heldBack ? 'pending' : 'needs_review',
        submittedFields: audit,
        unresolvedFields: heldBack ? [] : [{ label: 'Submit control', type: 'button' }],
        evidenceStoragePath,
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(applyAttempts.id, attempt.id))
      await db.update(huntCandidates).set({
        status: heldBack ? 'tailored' : 'needs_review',
        updatedAt: new Date(),
      }).where(eq(huntCandidates.id, candidateId))
      if (!heldBack) {
        await db.update(applications).set({ status: 'needs_review', updatedAt: new Date() }).where(eq(applications.id, application.id))
        await setRunJobStatus(row.candidate.runId, row.candidate.jobId, 'needs_review')
      }
      logger.info(
        { attemptId: attempt.id, heldBack: outcome.heldBack, fields: audit.length },
        heldBack ? 'application filled but not submitted' : 'application could not be submitted',
      )
      return
    }

    await transition({ attemptId: attempt.id, userId, state: 'submitted', detail: { recipe: result.recipe } })
    await db.update(applyAttempts).set({
      submittedFields: audit,
      unresolvedFields: [],
      evidenceStoragePath,
      updatedAt: new Date(),
    }).where(eq(applyAttempts.id, attempt.id))
    await db.update(huntCandidates).set({ status: 'applied', updatedAt: new Date() }).where(eq(huntCandidates.id, candidateId))
    await db.update(applications).set({ status: 'applied', appliedAt: new Date(), updatedAt: new Date() }).where(eq(applications.id, application.id))
    await db.update(huntRuns).set({
      applicationsSubmitted: sql`${huntRuns.applicationsSubmitted} + 1`,
      updatedAt: new Date(),
    }).where(eq(huntRuns.id, row.candidate.runId))
    await setRunJobStatus(row.candidate.runId, row.candidate.jobId, 'applied')
  } catch (error) {
    await transition({
      attemptId: attempt.id,
      userId,
      state: 'failed',
      detail: { message: error instanceof Error ? error.message : String(error) },
    })
    await db.update(applyAttempts).set({
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date(),
    }).where(eq(applyAttempts.id, attempt.id))
    await db.update(huntCandidates).set({ status: 'needs_review', updatedAt: new Date() }).where(eq(huntCandidates.id, candidateId))
    await db.update(applications).set({ status: 'needs_review', updatedAt: new Date() }).where(eq(applications.id, application.id))
    await setRunJobStatus(row.candidate.runId, row.candidate.jobId, 'needs_review')
    throw error
  } finally {
    await screencast?.stop().catch(() => undefined)
    await browser.close()
    await rm(scratch, { recursive: true, force: true })
  }
}