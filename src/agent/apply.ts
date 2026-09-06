import { runAgent } from './loop.js'
import { sensitiveReason } from '../hunt/apply/fields.js'
import { normaliseHttpUrl } from '../hunt/apply/urls.js'
import type { AgentSession } from '../browser/session.js'
import type { PortalProfile } from '../hunt/portal-profile.js'
import type { ApplyOutcome } from '../skills/types.js'

/**
 * Applying to a site no skill covers.
 *
 * Most application forms are a Greenhouse or an Ashby with a different logo on
 * it, and the deterministic ladder handles those without a model at all. This
 * is for what is left: an aggregator listing with the real form one link away,
 * a portal with no recipe, a multi-step flow. Those were half the attempts on
 * the last live run.
 *
 * It runs *after* the ladder, never instead of it.
 */

/** Everywhere an application can legitimately continue. */
const ATS_DOMAINS = [
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'workable.com',
  'smartrecruiters.com',
  'myworkdayjobs.com',
  'icims.com',
  'jobvite.com',
  'bamboohr.com',
  'breezy.hr',
  'teamtailor.com',
  'recruitee.com',
  'personio.com',
  'workday.com',
]

/**
 * Only what a form legitimately asks for.
 *
 * Everything on the never-auto list is absent from this object rather than
 * present-and-forbidden, because a fact the agent does not have is a fact it
 * cannot be argued into using.
 */
export function factsForAgent(profile: PortalProfile): Record<string, unknown> {
  return {
    fullName: profile.fullName,
    email: profile.email,
    phone: profile.phone,
    headline: profile.headline,
    location: `${profile.address.city}, ${profile.address.country}`.replace(/^, |, $/, ''),
    links: profile.links,
    noticePeriod: profile.noticePeriod,
    willingToRelocate: profile.willingToRelocate,
    skills: profile.skills.slice(0, 40),
    experience: profile.experience?.slice(0, 5) ?? [],
  }
}

export function domainsForApplyUrl(applyUrl: string): string[] {
  let host = ''
  try {
    host = new URL(applyUrl).hostname.toLowerCase()
  } catch {
    return ATS_DOMAINS
  }
  // The posting's own site, plus the ATS families a form legitimately hands
  // off to. Anything else is off-limits — see `runTool`, which enforces it.
  const parts = host.split('.')
  const registrable = parts.length > 2 ? parts.slice(-2).join('.') : host
  return [...new Set([host, registrable, ...ATS_DOMAINS])]
}

export async function applyWithAgent(params: {
  session: AgentSession
  userId: string
  applyUrl: string
  dryRun: boolean
  profile: PortalProfile
  resumePath: string
  job?: { title?: string; company?: string }
  onStep?: (step: { index: number; tool: string; result: string; ok: boolean }) => void | Promise<void>
}): Promise<ApplyOutcome> {
  const { session, dryRun } = params
  const applyUrl = normaliseHttpUrl(params.applyUrl)
  const page = session.page

  let initialNavigationError: string | undefined
  if (page.url() !== applyUrl) {
    try {
      await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    } catch (error) {
      initialNavigationError = error instanceof Error ? error.message : String(error)
    }
  }

  const result = await runAgent({
    page,
    userId: params.userId,
    goal: [
      `Start from this application URL: ${applyUrl}. If this page is a job listing rather than an application form, follow the apply`,
      'link to the form. Then fill in every field you can from the facts.',
      dryRun
        ? 'Stop when the form is filled. Do not submit.'
        : 'Submit once every required field is filled.',
    ].join(' '),
    facts: { candidate: factsForAgent(params.profile), job: params.job ?? {} },
    allowedDomains: domainsForApplyUrl(applyUrl),
    dryRun,
    files: { resume: params.resumePath },
    initialNavigationError,
    ...(params.onStep
      ? {
          onStep: (step: { index: number; tool: string; result: string; ok: boolean }) =>
            params.onStep?.({ index: step.index, tool: step.tool, result: step.result, ok: step.ok }),
        }
      : {}),
  })

  // The agent's own account of what it filled is not trusted where the
  // never-auto list is concerned: anything it claims to have answered that
  // matches that list is recorded as blocked regardless.
  return {
    reached: result.submitted ? 'submitted' : result.reachedForm ? 'form' : 'nothing',
    filled: result.filled
      .filter((label) => !sensitiveReason(label))
      .map((label) => ({ label, value: '[agent]' })),
    blocked: [
      ...result.blocked.map((label) => ({ label, why: sensitiveReason(label) ?? 'unknown_field' })),
      ...result.filled
        .filter((label) => sensitiveReason(label))
        .map((label) => ({ label, why: sensitiveReason(label) as string })),
    ],
    note: result.note,
    steps: result.steps,
  }
}
