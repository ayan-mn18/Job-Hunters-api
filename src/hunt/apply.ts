import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { and, eq, sql } from 'drizzle-orm'
import type { Locator, Page } from 'playwright-core'
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
import { badRequest, notFound } from '../lib/errors.js'
import { buildObjectKey, downloadObject, uploadObject } from '../lib/storage.js'
import { launchAutomationBrowser } from './browser.js'
import { loadPortalProfile, type PortalProfile } from './portal-profile.js'
import { provisionPortalAccount } from './portal-accounts.js'
import { createMinimalResumeVariant } from './tailoring.js'
interface FieldAudit {
  label: string
  kind: string
  value: string
}


async function setRunJobStatus(runId: string, jobId: string, status: HuntRunJob['status']): Promise<void> {
  await db
    .update(huntRunJobs)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(huntRunJobs.runId, runId), eq(huntRunJobs.jobId, jobId)))
}
async function fillFirst(locator: Locator, value: string, audit: FieldAudit[], label: string): Promise<boolean> {
  if (!value || await locator.count() === 0) return false
  const control = locator.first()
  if (!(await control.isVisible())) return false
  await control.fill(value)
  audit.push({ label, kind: 'text', value: '[provided]' })
  return true
}

function labels(page: Page, pattern: RegExp): Locator {
  return page.getByLabel(pattern).or(page.getByPlaceholder(pattern))
}

async function fillStandardFields(page: Page, profile: PortalProfile, resumePath: string): Promise<FieldAudit[]> {
  const audit: FieldAudit[] = []
  const parts = profile.fullName.trim().split(/\s+/)
  const firstName = parts[0] ?? profile.fullName
  const lastName = parts.slice(1).join(' ')

  await fillFirst(labels(page, /full name|name/i), profile.fullName, audit, 'fullName')
  await fillFirst(labels(page, /first name/i), firstName, audit, 'firstName')
  await fillFirst(labels(page, /last name|surname/i), lastName, audit, 'lastName')
  await fillFirst(labels(page, /email/i), profile.email, audit, 'email')
  await fillFirst(labels(page, /phone|mobile/i), profile.phone, audit, 'phone')
  await fillFirst(labels(page, /address/i), profile.address.line1, audit, 'address')
  await fillFirst(labels(page, /city/i), profile.address.city, audit, 'city')
  await fillFirst(labels(page, /state|province|region/i), profile.address.region, audit, 'region')
  await fillFirst(labels(page, /postal|zip|pin code/i), profile.address.postalCode, audit, 'postalCode')
  await fillFirst(labels(page, /linkedin/i), profile.links.linkedin, audit, 'linkedin')
  await fillFirst(labels(page, /github/i), profile.links.github, audit, 'github')
  await fillFirst(labels(page, /portfolio|website/i), profile.links.portfolio, audit, 'portfolio')
  await fillFirst(labels(page, /notice period|start date|availability/i), profile.noticePeriod, audit, 'noticePeriod')
  await fillFirst(labels(page, /work authori[sz]ation|sponsorship/i), profile.workAuthorization, audit, 'workAuthorization')

  const fileInputs = page.locator('input[type="file"]')
  for (let index = 0; index < await fileInputs.count(); index += 1) {
    const input = fileInputs.nth(index)
    const name = `${await input.getAttribute('name') ?? ''} ${await input.getAttribute('id') ?? ''}`
    const accept = await input.getAttribute('accept') ?? ''
    if (/resume|cv/i.test(name) || /pdf|document|word/i.test(accept) || await fileInputs.count() === 1) {
      await input.setInputFiles(resumePath)
      audit.push({ label: 'resume', kind: 'file', value: path.basename(resumePath) })
      break
    }
  }

  const country = page.getByLabel(/country/i).first()
  if (profile.address.country && await country.count() > 0 && await country.isVisible()) {
    try {
      await country.selectOption({ label: profile.address.country })
      audit.push({ label: 'country', kind: 'select', value: profile.address.country })
    } catch {
      // A required unmapped country stays visible to the unresolved-field gate.
    }
  }
  return audit
}

async function unresolvedRequired(page: Page): Promise<Array<{ label: string; type: string }>> {
  return page.locator('input[required],select[required],textarea[required]').evaluateAll((controls) =>
    controls.flatMap((control) => {
      const element = control as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      if (element.disabled || element.type === 'hidden') return []
      const empty = element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)
        ? !element.checked
        : !element.value.trim()
      if (!empty) return []
      const explicit = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent : null
      const wrapping = element.closest('label')?.textContent
      return [{
        label: (explicit || wrapping || element.getAttribute('aria-label') || element.name || element.id || 'Required field').trim(),
        type: element.type || element.tagName.toLowerCase(),
      }]
    }),
  )
}

async function persistEvidence(userId: string, attemptId: string, page: Page): Promise<string> {
  const screenshot = await page.screenshot({ fullPage: true, type: 'png' })
  const key = buildObjectKey(userId, 'application-evidence', `${attemptId}.png`)
  await uploadObject({ key, body: Buffer.from(screenshot), mimeType: 'image/png' })
  return key
}

export async function applyApprovedCandidate(userId: string, candidateId: string): Promise<void> {
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
  try {
    const resumePath = path.join(scratch, row.variant.fileName)
    await writeFile(resumePath, await downloadObject(row.variant.storagePath))
    const page = await browser.newPage()
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })

    const applyLink = page.getByRole('link', { name: /apply|apply now|apply for this job/i }).first()
    if (await applyLink.count() > 0 && await applyLink.isVisible()) {
      await applyLink.click()
      await page.waitForLoadState('domcontentloaded').catch(() => undefined)
    }

    const audit = await fillStandardFields(page, profile, resumePath)
    const unresolved = await unresolvedRequired(page)
    if (unresolved.length > 0) {
      const evidenceStoragePath = await persistEvidence(userId, attempt.id, page)
      await db.update(applyAttempts).set({
        status: 'needs_review',
        submittedFields: audit,
        unresolvedFields: unresolved,
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
      return
    }

    const submit = page.getByRole('button', { name: /submit application|submit|apply now|send application/i }).first()
    if (await submit.count() === 0 || !(await submit.isVisible())) {
      throw new Error('No visible final submit control was found.')
    }
    await submit.click()
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined)
    const body = (await page.locator('body').innerText()).toLowerCase()
    if (!/thank you|application (was )?submitted|successfully applied|we have received/.test(body)) {
      throw new Error('Portal did not show a positive submission confirmation.')
    }

    const evidenceStoragePath = await persistEvidence(userId, attempt.id, page)
    await db.update(applyAttempts).set({
      status: 'submitted',
      submittedFields: audit,
      unresolvedFields: [],
      evidenceStoragePath,
      completedAt: new Date(),
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
    await db.update(applyAttempts).set({
      status: 'unknown',
      error: error instanceof Error ? error.message : String(error),
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(applyAttempts.id, attempt.id))
    await db.update(huntCandidates).set({ status: 'needs_review', updatedAt: new Date() }).where(eq(huntCandidates.id, candidateId))
    await db.update(applications).set({ status: 'needs_review', updatedAt: new Date() }).where(eq(applications.id, application.id))
    await setRunJobStatus(row.candidate.runId, row.candidate.jobId, 'needs_review')
    throw error
  } finally {
    await browser.close()
    await rm(scratch, { recursive: true, force: true })
  }
}
