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
import { env, hasApplyAgent } from '../config/env.js'
import { badRequest, notFound } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { buildObjectKey, downloadObject, uploadObject } from '../lib/storage.js'
import { openSession } from '../browser/session.js'
import { profileFor } from '../browser/profiles.js'
import { applyWithAgent } from '../agent/apply.js'
import { factsForAgent } from '../agent/apply.js'
import { skillForUrl } from '../skills/registry.js'
import { normaliseLabel } from './apply/fields.js'
import { normaliseHttpUrl } from './apply/urls.js'
import { loadPortalProfile } from './portal-profile.js'
import { provisionPortalAccount } from './portal-accounts.js'
import { createMinimalResumeVariant } from './tailoring.js'
import { fillForm, hasSubmitControl, submitForm } from './apply/fill.js'
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
  const applyUrl = normaliseHttpUrl(row.job.applyUrl ?? source?.applyUrl ?? row.job.canonicalUrl)
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
  const dryRun = options?.dryRun ?? env.APPLY_DRY_RUN

  // What this project knows about the site being applied to: where it may
  // navigate, whether it needs a signed-in profile, whether it is worth paying
  // for a residential exit. Null is fine and common — most ATS forms are
  // generic and need none of it.
  const skill = skillForUrl(applyUrl)
  const profileId =
    skill?.manifest.authMode === 'profile' ? await profileFor(userId, skill.manifest.id) : null

  let session: Awaited<ReturnType<typeof openSession>> | null = null
  // Declared out here so the `finally` can stop it however the attempt ends.
  let screencast: Awaited<ReturnType<typeof startScreencast>> | null = null

  try {
    session = await openSession({
      userId,
      label: `apply:${skill?.manifest.id ?? 'generic'}`,
      profileId,
      proxyCountry: skill?.manifest.proxyCountry ?? null,
    })
    await transition({ attemptId: attempt.id, userId, state: 'opening', detail: { applyUrl, dryRun } })

    const resumePath = path.join(scratch, row.variant.fileName)
    await writeFile(resumePath, await downloadObject(row.variant.storagePath))
    const page = session.page
    try {
      await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    } catch (error) {
      // A transient navigation issue should reach the model-assisted tier so
      // it can inspect the page and choose a recovery path. Only repeated
      // failures in that bounded tier become an error/review outcome.
      logger.warn({ err: error, applyUrl, attemptId: attempt.id }, 'initial application navigation failed')
    }

    // A hosted session publishes its own live URL, which is a real browser the
    // user can click in rather than a stream of frames they can only watch.
    // Frame streaming stays for the local provider, and only while somebody is
    // actually watching — an unwatched application should cost nothing extra.
    if (session.liveUrl || session.sessionId) {
      await db
        .update(applyAttempts)
        .set({ liveUrl: session.liveUrl, browserSessionId: session.sessionId, updatedAt: new Date() })
        .where(eq(applyAttempts.id, attempt.id))
    }
    screencast =
      !session.liveUrl && (await isWatched(attempt.id))
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

    let audit = result.fields.map((field) => ({
      label: field.label,
      kind: field.via,
      value: field.filled ? '[provided]' : '[blank]',
    }))
    let unresolved = result.unresolved
    let agentSubmitted = false
    const submitControlAvailable = await hasSubmitControl({ page, url: applyUrl })
    const needsAgent = result.fields.length === 0 || unresolved.length > 0 || !submitControlAvailable

    // The agent tier, second and only when the deterministic one fell short:
    // either it never found a form to fill (an aggregator listing, a portal
    // with no recipe) or it filled what it could and left required questions
    // behind. Recipes stay first because they are faster, cheaper and exact
    // where they apply.
    if (hasApplyAgent && needsAgent) {
      await transition({
        attemptId: attempt.id,
        userId,
        state: 'filling',
        detail: {
          tier: 'agent',
          reason:
            result.fields.length === 0
              ? 'no_form_found'
              : unresolved.length > 0
                ? 'unresolved_fields'
                : 'no_submit_control',
        },
      })
      try {
        // A site skill knows things the generic path cannot: that Work at a
        // Startup's application *is* a message to the founders, for instance.
        // Without one, the generic agent runs on the same session.
        const agent = skill?.apply
          ? await skill.apply({
              session,
              userId,
              applyUrl,
              dryRun,
              facts: {
                candidate: factsForAgent(profile),
                job: {
                  title: row.job.title,
                  company: row.job.company,
                  description: row.job.descriptionText ?? '',
                },
              },
              files: { resume: resumePath },
            })
          : await applyWithAgent({
              session,
              userId,
              applyUrl,
              dryRun,
              profile,
              resumePath,
              job: { title: row.job.title, company: row.job.company },
            })
        logger.info(
          { attemptId: attempt.id, skill: skill?.manifest.id ?? null, reached: agent.reached, filled: agent.filled.length, blocked: agent.blocked.length },
          'agent tier finished',
        )
        agentSubmitted = agent.reached === 'submitted'
        if (agent.reached !== 'nothing') {
          audit = [
            ...audit,
            ...agent.filled.map((field) => ({
              label: field.label,
              kind: 'agent' as const,
              value: '[provided]',
            })),
          ]

          // The agent's self-report can add blockers but not wish them away.
          //
          // Replacing the list outright is what the first version did, and on
          // a real Anthropic form it turned seven genuinely unanswered
          // required questions — including "Why Anthropic?" — into a clean
          // record with zero blockers, because the agent said it had reached
          // the form and listed nothing as blocked. An application that is
          // silently recorded as complete when it is not is worse than one
          // correctly parked for review, so a blocker the ladder *measured*
          // clears only when the agent names that exact field as filled.
          const agentFilled = new Set(agent.filled.map((field) => normaliseLabel(field.label)))
          const stillBlocked = unresolved.filter(
            (field) => !agentFilled.has(normaliseLabel(field.label)),
          )
          const known = new Set(stillBlocked.map((field) => normaliseLabel(field.label)))
          unresolved = [
            ...stillBlocked,
            ...agent.blocked
              .filter((field) => !known.has(normaliseLabel(field.label)))
              .map((field) => ({ label: field.label, type: 'text', why: field.why as never })),
          ]
          if (agentSubmitted) unresolved = []
        }
      } catch (error) {
        // A failed agent must not lose the deterministic tier's work — the
        // attempt falls through to review with whatever the ladder managed.
        logger.warn({ err: error, attemptId: attempt.id }, 'agent tier failed; keeping ladder result')
      }
    }

    if (unresolved.length > 0) {
      const evidenceStoragePath = await persistEvidence(userId, attempt.id, page)
      await transition({
        attemptId: attempt.id,
        userId,
        state: 'blocked',
        reason: unresolved[0]?.why ?? 'needs_input',
        detail: {
          fields: unresolved,
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
        unresolvedFields: unresolved,
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
    const outcome = agentSubmitted
      ? { submitted: true as const }
      : await submitForm({ page, url: applyUrl, dryRun })
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
      // `pending` is the attempt's own starting state — reusing it here left a
      // completed dry run indistinguishable from one that had not started,
      // and downstream (applications, hunt_run_jobs, the run counters) never
      // heard the attempt had finished at all. `unknown` is the honest label:
      // filled correctly, outcome deliberately never determined.
      await db.update(applyAttempts).set({
        status: heldBack ? 'unknown' : 'needs_review',
        submittedFields: audit,
        unresolvedFields: heldBack ? [] : [{ label: 'Submit control', type: 'button' }],
        evidenceStoragePath,
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(applyAttempts.id, attempt.id))
      await db.update(huntCandidates).set({ status: 'needs_review', updatedAt: new Date() }).where(eq(huntCandidates.id, candidateId))
      await db.update(applications).set({ status: 'needs_review', updatedAt: new Date() }).where(eq(applications.id, application.id))
      await db.update(huntRuns).set({
        applicationsNeedsReview: sql`${huntRuns.applicationsNeedsReview} + 1`,
        updatedAt: new Date(),
      }).where(eq(huntRuns.id, row.candidate.runId))
      await setRunJobStatus(row.candidate.runId, row.candidate.jobId, 'needs_review')
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
    // Closing the session also stops the hosted browser. Skipping that would
    // leave it billing until its own timeout expires.
    await session?.close()
    await rm(scratch, { recursive: true, force: true })
  }
}
