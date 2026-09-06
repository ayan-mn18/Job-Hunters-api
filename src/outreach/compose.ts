import { z } from 'zod/v4'
import { hasModelAccess } from '../config/env.js'
import { structured } from '../model/gateway.js'
import type { RankedProspect } from './rank.js'

/**
 * Writing the ask.
 *
 * A LinkedIn invitation note is capped near 300 characters, which is a useful
 * constraint rather than an annoying one: it forces the specific over the
 * generic. Every draft must name one true, checkable thing — the school
 * shared, the mutual's name, the team, the requisition — because a generic
 * "connect and refer me" sent fifteen times a day is the LazyApply failure
 * mode in a different medium, and it is the user's own name attached to it.
 */

export const INVITE_LIMIT = 280

export interface ComposeContext {
  userId: string
  /** How the candidate would describe themselves in one line. */
  headline: string
  yearsExperience: number
  topSkills: string[]
  company: string
  targetRole: string | null
  /** Requisition id or job title, when the ask is about a specific posting. */
  jobTitle: string | null
}

const draftSchema = z.object({
  invite: z
    .string()
    .max(INVITE_LIMIT)
    .describe('The connection note. Under 280 characters. Names one specific shared fact.'),
  ask: z
    .string()
    .max(900)
    .describe('The follow-up message sent only after they accept, asking for the referral'),
})

const SYSTEM = `You write short, specific outreach messages asking someone for a job referral.

The person sending this is a real candidate and their name is on it. Write as them, in first person, plainly.

Rules:
- Name one true, specific thing from the context you are given — the shared employer, the school, the team, the role. Never invent one.
- If the context gives you nothing specific to name, say plainly why you are reaching out and keep it short. A short honest note beats a padded one.
- No flattery, no "I hope this finds you well", no describing yourself as passionate or a rockstar.
- The invite is under 280 characters. It asks to connect, not for the referral — the referral comes after they accept.
- The follow-up asks directly and makes it easy to say no.
- Never claim a qualification the context does not state.`

function specificsFor(prospect: RankedProspect, context: ComposeContext): string {
  const specifics: string[] = []
  if (prospect.relationship === 'first_degree') specifics.push('We are already connected on LinkedIn.')
  if (prospect.relationship === 'alumni') specifics.push('We went to the same university.')
  if (prospect.relationship === 'ex_colleague') specifics.push('We both worked at the same company previously.')
  if (prospect.relationship === 'strong_mutual') specifics.push('We have mutual connections.')
  if (prospect.sharedEmployer) specifics.push('We overlapped at a previous employer.')
  if (prospect.sharedSchool) specifics.push('We share a university.')
  if (prospect.sharedCity) specifics.push('We are both in the same city.')
  if (prospect.skillOverlap > 0) {
    specifics.push(`We work with ${prospect.skillOverlap} of the same technologies.`)
  }
  if (prospect.mutualConnections > 0) {
    specifics.push(`${prospect.mutualConnections} mutual connection${prospect.mutualConnections === 1 ? '' : 's'}.`)
  }
  if (prospect.title) specifics.push(`They are a ${prospect.title} at ${context.company}.`)
  return specifics.length > 0 ? specifics.join('\n') : 'Nothing specific is known beyond their role and company.'
}

export interface Draft {
  invite: string
  ask: string
}

/**
 * The deterministic fallback, used when no model is configured.
 *
 * Deliberately plain rather than clever. A template that tries to sound warm
 * without knowing anything reads worse than one that simply says what it
 * wants.
 */
export function fallbackDraft(prospect: RankedProspect, context: ComposeContext): Draft {
  const role = context.targetRole ?? 'engineering'
  const firstName = prospect.name.split(/\s+/)[0] ?? prospect.name
  const invite =
    `Hi ${firstName} — I am a ${context.headline} looking at ${role} roles at ${context.company}. ` +
    `Would you be open to connecting?`
  const ask =
    `Thanks for connecting, ${firstName}.\n\n` +
    `I am applying for ${context.jobTitle ?? `${role} roles`} at ${context.company}. ` +
    `I have ${context.yearsExperience} years of experience, mostly with ${context.topSkills.slice(0, 3).join(', ')}.\n\n` +
    `If you think it is a reasonable fit, would you be willing to refer me? ` +
    `Completely fine if not — I know referrals are a big ask.`
  return { invite: invite.slice(0, INVITE_LIMIT), ask }
}

export async function composeOutreach(
  prospect: RankedProspect,
  context: ComposeContext,
): Promise<Draft> {
  if (!hasModelAccess) return fallbackDraft(prospect, context)

  try {
    const draft = await structured(draftSchema, {
      purpose: 'draft-outreach',
      userId: context.userId,
      system: SYSTEM,
      effort: 'low',
      maxTokens: 2_000,
      prompt: `CANDIDATE
Headline: ${context.headline}
Years of experience: ${context.yearsExperience}
Skills: ${context.topSkills.slice(0, 12).join(', ')}

TARGET
Company: ${context.company}
Role they want: ${context.targetRole ?? 'not specified'}
${context.jobTitle ? `Specific posting: ${context.jobTitle}` : ''}

PERSON
Name: ${prospect.name}
Title: ${prospect.title ?? 'unknown'}
Relationship: ${prospect.relationship}

WHAT IS ACTUALLY SHARED
${specificsFor(prospect, context)}`,
    })

    // The model is told the limit and usually respects it; truncating on a
    // word boundary is better than letting LinkedIn silently cut mid-sentence.
    const invite =
      draft.invite.length <= INVITE_LIMIT
        ? draft.invite
        : `${draft.invite.slice(0, INVITE_LIMIT - 1).replace(/\s+\S*$/, '')}…`

    return { invite: invite.trim(), ask: draft.ask.trim() }
  } catch {
    return fallbackDraft(prospect, context)
  }
}
