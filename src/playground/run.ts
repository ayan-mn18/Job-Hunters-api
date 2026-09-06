import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { z } from 'zod/v4'
import { db } from '../db/client.js'
import { applications, playgroundRuns } from '../db/schema.js'
import { logger } from '../lib/logger.js'
import { downloadObject } from '../lib/storage.js'
import { structured } from '../model/gateway.js'
import { openSession, type AgentSession } from '../browser/session.js'
import { profileFor } from '../browser/profiles.js'
import { applyWithAgent, factsForAgent } from '../agent/apply.js'
import { toDiscoveryAdapter } from '../hunt/discovery/runner.js'
import { loadPortalProfile } from '../hunt/portal-profile.js'
import { allSkills, skillById, skillForUrl, skillsWith } from '../skills/registry.js'
import type { SiteSkill } from '../skills/types.js'
import type { ScrapedJob } from '../hunt/discovery/types.js'
import { awaitReply, clearReplies } from './replies.js'
import { loadRunUnscoped, publishStep, say, setState } from './store.js'
import { sendRunConfirmation } from './confirmation.js'

/**
 * One job, from a sentence to a confirmation email.
 *
 * The batch hunt and this share every underlying part — the same hosted
 * browser, the same site skills, the same agent, the same never-auto list —
 * and differ in one respect: this one stops and asks. A hunt parks a blocked
 * application for review because there are ninety-nine more behind it. Here
 * there is one, somebody is watching it, and the right move when the form asks
 * for a number nobody has is to ask them for it.
 *
 * That difference is the whole feature, and it is why this is a separate
 * orchestrator rather than a flag on `applyApprovedCandidate`.
 */

/** How long the run waits on a person before giving up and closing the browser. */
const APPROVAL_WAIT_MS = 15 * 60_000
const ANSWER_WAIT_MS = 10 * 60_000

/** Postings read per run. Small: each detail page is a Firecrawl credit. */
const SHORTLIST_POOL = 8
const SHORTLIST_SHOWN = 4

const planSchema = z.object({
  site: z
    .string()
    .describe('The job site the user named, as a bare hostname, or an empty string.'),
  keywords: z.array(z.string()).describe('Role keywords to search for.'),
  locations: z.array(z.string()).describe('Locations named, or an empty array.'),
  summary: z.string().describe('One sentence back to the user about what you are doing.'),
})

const rankingSchema = z.object({
  ranked: z.array(
    z.object({
      url: z.string(),
      score: z.number().describe('0-100, how well this fits the candidate.'),
      reasons: z.array(z.string()).describe('Two or three short, concrete reasons.'),
    }),
  ),
})

export interface ShortlistEntry {
  url: string
  title: string
  company: string
  location: string
  salary: string | null
  experience: string | null
  score: number
  reasons: string[]
}

/** Reads the prompt. Falls back to a plain search rather than failing a run. */
async function planFrom(prompt: string, userId: string) {
  try {
    return await structured(planSchema, {
      purpose: 'rerank',
      userId,
      system:
        'You turn a job-hunting instruction into a plan. Name the site only if the user named one. '
        + 'Keep keywords to the role itself, not the seniority adjectives.',
      prompt,
    })
  } catch (error) {
    logger.warn({ err: error }, 'could not read the playground prompt; searching plainly')
    return { site: '', keywords: [prompt.slice(0, 60)], locations: [], summary: `Searching for: ${prompt}` }
  }
}

/** The site skill this run should use. */
function resolveSkill(site: string): SiteSkill | null {
  if (site) {
    const bySite = skillForUrl(site.startsWith('http') ? site : `https://${site}`)
    if (bySite?.source) return bySite
    const byId = skillById(site.replace(/\..*$/, ''))
    if (byId?.source) return byId
  }
  // Only one site is searchable today. When there are several, the plan's
  // `site` is what picks between them, and this is the fallback.
  return skillsWith('search')[0] ?? null
}

function toEntry(job: ScrapedJob, score: number, reasons: string[]): ShortlistEntry {
  return {
    url: job.url,
    title: job.title,
    company: job.company,
    location: job.locations.map((item) => item.raw).filter(Boolean).join(' / '),
    salary: job.salary.text,
    experience: job.experience.text,
    score,
    reasons,
  }
}

async function shortlistFor(
  run: { id: string; userId: string },
  skill: SiteSkill,
  plan: { keywords: string[]; locations: string[] },
  profile: Awaited<ReturnType<typeof loadPortalProfile>>,
): Promise<{ entries: ShortlistEntry[]; jobs: Map<string, ScrapedJob> }> {
  const adapter = toDiscoveryAdapter(skill.source as NonNullable<SiteSkill['source']>)
  const now = new Date()
  const result = await adapter.fetchRecent({
    since: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
    now,
    maxItems: SHORTLIST_POOL,
    softwareOnly: false,
  })

  const jobs = new Map(result.jobs.map((job) => [job.url, job]))
  if (result.jobs.length === 0) return { entries: [], jobs }

  await say(run, 'agent', `Read ${result.seen} postings and kept ${result.jobs.length} worth scoring.`)

  let ranked: z.infer<typeof rankingSchema>['ranked'] = []
  try {
    const answer = await structured(rankingSchema, {
      purpose: 'rerank',
      userId: run.userId,
      system:
        'You score how well each posting fits one candidate. Be specific and be honest — a low score '
        + 'with a real reason is more useful than a high one with a vague one. Score every posting given.',
      prompt: [
        `Looking for: ${plan.keywords.join(', ') || 'anything suitable'}`,
        plan.locations.length ? `Near: ${plan.locations.join(', ')}` : '',
        '',
        'Candidate:',
        JSON.stringify(factsForAgent(profile)),
        '',
        'Postings:',
        JSON.stringify(
          result.jobs.map((job) => ({
            url: job.url,
            title: job.title,
            company: job.company,
            location: job.locations.map((item) => item.raw).join(' / '),
            experience: job.experience.text,
            salary: job.salary.text,
            description: (job.descriptionText ?? '').slice(0, 1_500),
          })),
        ),
      ]
        .filter(Boolean)
        .join('\n'),
      maxTokens: 20_000,
    })
    ranked = answer.ranked
  } catch (error) {
    // A ranking that failed should not lose the postings. Unscored is worse
    // than scored, and far better than an empty panel.
    logger.warn({ err: error }, 'playground ranking failed; showing postings unscored')
    ranked = result.jobs.map((job) => ({ url: job.url, score: 50, reasons: ['Not scored.'] }))
  }

  const entries = ranked
    .flatMap((row) => {
      const job = jobs.get(row.url)
      return job ? [toEntry(job, Math.round(row.score), row.reasons.slice(0, 3))] : []
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, SHORTLIST_SHOWN)

  return { entries, jobs }
}

/** Everything the run needs to close, however it ends. */
interface Teardown {
  session: AgentSession | null
  scratch: string | null
}

async function teardown(state: Teardown, runId: string): Promise<void> {
  if (state.session) await state.session.close()
  if (state.scratch) await rm(state.scratch, { recursive: true, force: true })
  await clearReplies(runId)
}

/**
 * Filling the form, submitting it, and telling the user.
 *
 * Shared by both ways in: a posting found by searching, and one the user named
 * outright. Everything from here on is identical, and duplicating it was how
 * the direct path would have quietly missed the confirmation email.
 */
async function finishApplication(
  ref: { id: string; userId: string },
  run: { id: string; userId: string; dryRun: boolean; prompt: string },
  chosen: ShortlistEntry,
  job: ScrapedJob | null,
  profile: Awaited<ReturnType<typeof loadPortalProfile>>,
  state: Teardown,
  skill: SiteSkill | null,
): Promise<void> {
    await setState(ref, {
    status: 'applying',
    chosenJobUrl: chosen.url,
    chosenJobTitle: chosen.title,
    chosenJobCompany: chosen.company,
  })
  await say(ref, 'agent', `Opening ${chosen.title} at ${chosen.company}.`)

  state.scratch = await mkdtemp(path.join(os.tmpdir(), 'huntly-playground-'))
  const resumePath = path.join(state.scratch, profile.baseResume.fileName)
  await writeFile(resumePath, await downloadObject(profile.baseResume.storagePath))

  /**
   * The agent asking a person something.
   *
   * The run goes to `blocked`, the question is stored so it survives a
   * closed tab, and the answer comes back through Redis from whichever
   * process the user happened to reach.
   */
  const onAsk = async (question: string): Promise<string | null> => {
    // Nothing already queued can be an answer to a question that has not
    // been asked yet. Without this, an instruction typed three minutes ago
    // while the form was filling gets popped as the reply to this.
    await clearReplies(run.id)
    await setState(ref, { status: 'blocked', pendingQuestion: question }, { question })
    await say(ref, 'agent', question, 'stuck')
    // An instruction typed at the moment of being asked is the answer.
    const reply = await awaitReply(run.id, ANSWER_WAIT_MS, ['answer', 'instruct', 'cancel'])
    await setState(ref, { status: 'applying', pendingQuestion: null })
    if (!reply) {
      await say(ref, 'huntly', 'Nobody answered, so I left it blank.')
      return null
    }
    if (reply.kind === 'cancel') return null
    await say(ref, 'user', reply.text)
    return reply.text
  }

  const applyUrl = job?.applyUrl ?? chosen.url

  /**
   * Which skill fills the form, decided by the form's own URL.
   *
   * Not the skill that found the posting. A board can hand off to an ATS it
   * has nothing to do with — Work at a Startup's apply link goes through
   * Y Combinator's sign-in, and other boards link straight out to Greenhouse
   * — and using the finder's apply steps on somebody else's form is how an
   * agent ends up following a playbook for a page it is not on.
   */
  const applySkill = skillForUrl(applyUrl) ?? (skillForUrl(chosen.url) === skill ? skill : null)
  if (applySkill && applySkill !== skill) {
    logger.info(
      { runId: run.id, found: skill?.manifest.id ?? null, applying: applySkill.manifest.id },
      'playground apply handed to a different skill',
    )
  }

  const attemptApply = async () =>
    applySkill?.apply
      ? applySkill.apply({
          session: state.session as AgentSession,
          userId: run.userId,
          applyUrl,
          dryRun: run.dryRun,
          facts: {
            candidate: factsForAgent(profile),
            job: {
              title: chosen.title,
              company: chosen.company,
              description: (job?.descriptionText ?? '').slice(0, 6_000),
            },
          },
          files: { resume: resumePath },
          onAsk,
          onStep: (step) => publishStep(ref, step),
        })
      : applyWithAgent({
          session: state.session as AgentSession,
          userId: run.userId,
          applyUrl,
          dryRun: run.dryRun,
          profile,
          resumePath,
          job: { title: chosen.title, company: chosen.company },
          onAsk,
          onStep: (step) => publishStep(ref, step),
        })

  let outcome = await attemptApply()

  /**
   * A sign-in wall is a question, not a failure.
   *
   * The site wants an account this browser is not signed into. That is
   * something only the person can fix, and they already have the browser
   * embedded in front of them — so the run stops, says so, and waits while
   * they sign in, rather than throwing the session away and making them
   * start over. Their cookies land in the profile and the next run has them.
   */
  if (outcome.blocked.some((field) => field.why === 'needs_account')) {
    await say(ref, 'agent', outcome.note, 'stuck')
    await say(
      ref,
      'llm',
      'Sign in yourself in the browser on the left — it is the real thing, so click straight into it. '
        + 'Tell me when you are done and I will carry on from there. I will not type a password.',
    )
    const signedIn = await onAsk('Signed in? Say "done" and I will carry on.')
    if (signedIn) {
      await say(ref, 'agent', 'Carrying on.')
      outcome = await attemptApply()
    }
  }

  for (const blocked of outcome.blocked) {
    if (blocked.why === 'sensitive_field') {
      await say(
        ref,
        'llm',
        `Left "${blocked.label}" blank on purpose. Huntly never answers visa, demographic or disability questions for you.`,
        'refused',
      )
    }
  }

  // A dry run that reached a filled form is a success, not a failure. Saying
  // otherwise is what makes people turn the safe mode off.
  const succeeded = outcome.reached === 'submitted' || (run.dryRun && outcome.reached === 'form')
  if (!succeeded) {
    await say(ref, 'huntly', outcome.note || 'Could not complete this application.')
    await setState(ref, {
      status: 'failed',
      error: outcome.note,
      filledFields: outcome.filled,
      blockedFields: outcome.blocked,
      completedAt: new Date(),
    })
    return
  }

  const [application] = await db
    .insert(applications)
    .values({
      userId: run.userId,
      role: chosen.title,
      company: chosen.company,
      location: chosen.location,
      jobUrl: chosen.url,
      // The site the form was actually on, which is not always the one that
      // listed the job.
      portalId: applySkill?.manifest.id ?? hostOf(chosen.url),
      portalName: applySkill?.manifest.label ?? hostOf(chosen.url),
      status: run.dryRun ? 'needs_review' : 'applied',
      ...(run.dryRun ? {} : { appliedAt: new Date() }),
    })
    .returning()

  await say(
    ref,
    'agent',
    run.dryRun ? 'Filled the form and stopped — this was a dry run.' : 'Submitted.',
    'success',
  )

  const confirmation = await sendRunConfirmation({
    to: profile.email,
    run: { id: run.id, prompt: run.prompt },
    job: chosen,
    filled: outcome.filled,
    blocked: outcome.blocked,
    dryRun: run.dryRun,
  })

  await setState(
    ref,
    {
      status: 'submitted',
      applicationId: application?.id ?? null,
      filledFields: outcome.filled,
      blockedFields: outcome.blocked,
      ...(confirmation.sent ? { emailSentAt: new Date() } : {}),
      completedAt: new Date(),
    },
    { emailSent: confirmation.sent, to: profile.email },
  )

  await say(
    ref,
    'huntly',
    confirmation.sent
      ? `Confirmation email sent to ${profile.email}.`
      : `Applied. The confirmation email could not go out: ${confirmation.error}`,
    confirmation.sent ? 'success' : undefined,
  )
}

/** The bare hostname, for a site no skill covers. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'unknown'
  }
}

/** A posting the user named outright: one entry, approved the same way. */
async function directRun(
  ref: { id: string; userId: string },
  run: { id: string; userId: string; dryRun: boolean; prompt: string },
  url: string,
  profile: Awaited<ReturnType<typeof loadPortalProfile>>,
  state: Teardown,
): Promise<void> {
  const skill = skillForUrl(url)
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return url
    }
  })()

  const profileId =
    skill?.manifest.authMode === 'profile' ? await profileFor(run.userId, skill.manifest.id) : null

  state.session = await openSession({
    userId: run.userId,
    label: `playground:${run.id}`,
    profileId,
    proxyCountry: skill?.manifest.proxyCountry ?? null,
    timeoutMinutes: 45,
  })

  const entry: ShortlistEntry = {
    url,
    title: 'The posting you named',
    company: host,
    location: '',
    salary: null,
    experience: null,
    score: 100,
    reasons: ['You asked for this one specifically.'],
  }

  await setState(
    ref,
    {
      status: 'shortlisted',
      skillId: skill?.manifest.id ?? null,
      liveUrl: state.session.liveUrl,
      browserSessionId: state.session.sessionId,
      shortlist: [entry],
    },
    { liveUrl: state.session.liveUrl, shortlist: [entry] },
  )
  await state.session.page
    .goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    .catch(() => undefined)
  await say(ref, 'huntly', `Opened ${host}. Press Apply and I will fill it in.`)

  const approval = await awaitReply(run.id, APPROVAL_WAIT_MS, ['approve', 'cancel'])
  if (!approval || approval.kind === 'cancel') {
    await say(ref, 'huntly', 'Stopped. Nothing was sent.')
    await setState(ref, { status: 'cancelled', completedAt: new Date() })
    return
  }

  await finishApplication(ref, run, entry, null, profile, state, skill)
}

export async function executePlaygroundRun(runId: string): Promise<void> {
  const run = await loadRunUnscoped(runId)
  if (!run) return
  if (run.status === 'cancelled') return

  const state: Teardown = { session: null, scratch: null }
  const ref = { id: run.id, userId: run.userId }

  try {
    const profile = await loadPortalProfile(run.userId)

    await setState(ref, { status: 'launching', startedAt: new Date() })
    await say(ref, 'huntly', 'Starting a browser and reading your prompt.')

    /**
     * A prompt naming one posting skips the search entirely.
     *
     * "Apply to <url>" is a thing people ask for, and it is also the only way
     * to exercise this engine against a site that needs no login — the boards
     * it can search do.
     */
    const direct = /https?:\/\/[^\s)]+/.exec(run.prompt)?.[0]?.replace(/[.,]$/, '')
    if (direct) {
      await directRun(ref, run, direct, profile, state)
      return
    }

    const plan = await planFrom(run.prompt, run.userId)
    const skill = resolveSkill(plan.site)
    if (!skill?.source) {
      throw new Error(
        `Nothing here knows how to search ${plan.site || 'that'}. Sites Huntly can search: `
          + allSkills()
            .filter((item) => item.manifest.capabilities.search)
            .map((item) => item.manifest.label)
            .join(', '),
      )
    }

    const profileId =
      skill.manifest.authMode === 'profile' ? await profileFor(run.userId, skill.manifest.id) : null

    state.session = await openSession({
      userId: run.userId,
      label: `playground:${run.id}`,
      profileId,
      proxyCountry: skill.manifest.proxyCountry,
      // A run that stops to ask a question is waiting on a human, and humans
      // are slower than a form. The session has to outlive the conversation.
      timeoutMinutes: 45,
    })

    await setState(
      ref,
      {
        status: 'searching',
        skillId: skill.manifest.id,
        liveUrl: state.session.liveUrl,
        browserSessionId: state.session.sessionId,
      },
      { liveUrl: state.session.liveUrl },
    )
    await say(ref, 'llm', plan.summary)

    // Put the listing on screen while the search runs, so the browser panel
    // shows the site being worked on rather than a blank page.
    const listingUrl = `https://${skill.manifest.domains[0]}`
    await state.session.page
      .goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      .catch(() => undefined)

    const { entries, jobs } = await shortlistFor(ref, skill, plan, profile)
    if (entries.length === 0) {
      await say(ref, 'huntly', 'Nothing came back from that search. Try different words.')
      await setState(ref, { status: 'failed', error: 'No postings found.', completedAt: new Date() })
      return
    }

    const best = entries[0] as ShortlistEntry
    await setState(ref, { status: 'shortlisted', shortlist: entries }, { shortlist: entries })
    await say(ref, 'llm', `Best match is ${best.title} at ${best.company} — ${best.score}/100.`)
    await say(ref, 'llm', best.reasons.map((reason) => `· ${reason}`).join('\n'))
    await say(ref, 'huntly', 'Press Apply when you want me to go ahead. Nothing is sent until you do.')

    const approval = await awaitReply(run.id, APPROVAL_WAIT_MS, ['approve', 'cancel'])
    if (!approval || approval.kind === 'cancel') {
      await say(ref, 'huntly', approval ? 'Stopped. Nothing was sent.' : 'Nobody pressed Apply, so I stopped.')
      await setState(ref, { status: 'cancelled', completedAt: new Date() })
      return
    }

    const chosen = entries.find((entry) => entry.url === approval.text) ?? best
    const job = jobs.get(chosen.url)

    await finishApplication(ref, run, chosen, job ?? null, profile, state, skill)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error({ err: error, runId }, 'playground run failed')
    await say(ref, 'huntly', message).catch(() => undefined)
    await db
      .update(playgroundRuns)
      .set({ status: 'failed', error: message, completedAt: new Date(), updatedAt: new Date() })
      .where(eq(playgroundRuns.id, runId))
      .catch(() => undefined)
  } finally {
    await teardown(state, runId)
  }
}
