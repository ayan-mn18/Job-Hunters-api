import { z } from 'zod/v4'
import { hasModelAccess } from '../config/env.js'
import { logger } from '../lib/logger.js'
import { structured } from '../model/gateway.js'

/**
 * What a piece of mail is, and whether it needs a person today.
 *
 * The point of the whole inbox feature is one question: did anyone reply about
 * my applications, and does it need me now. Everything here serves that.
 */

export type EmailClass =
  | 'interview_invite'
  | 'assessment'
  | 'rejection'
  | 'recruiter_outreach'
  | 'application_ack'
  | 'other'

export type Urgency = 'now' | 'soon' | 'fyi'

export interface EmailClassification {
  classification: EmailClass
  confidence: number
  company: string | null
  role: string | null
  nextStep: string | null
  /** ISO date when the mail names one — an interview slot, a deadline. */
  happensAt: string | null
  summary: string
}

/**
 * How loudly each kind should announce itself.
 *
 * Rejections are deliberately `fyi`. They are the most common outcome of a
 * hundred applications a day, and greeting someone with a wall of them every
 * morning would make the product miserable to open — which is how the
 * interview invite three rows down gets missed.
 */
export const URGENCY_FOR: Record<EmailClass, Urgency> = {
  interview_invite: 'now',
  assessment: 'now',
  recruiter_outreach: 'soon',
  application_ack: 'fyi',
  rejection: 'fyi',
  other: 'fyi',
}

/** Cheap pass: is this even about a job application? */
const RELEVANT =
  /\b(?:application|applied|interview|assessment|coding\s+challenge|take[-\s]?home|recruit|candidat|role|position|opening|offer|hiring|shortlist|screening|next\s+steps?|unfortunately|regret)\b/i

export function mightBeJobMail(subject: string, snippet: string): boolean {
  return RELEVANT.test(`${subject}\n${snippet}`)
}

const schema = z.object({
  classification: z.enum([
    'interview_invite',
    'assessment',
    'rejection',
    'recruiter_outreach',
    'application_ack',
    'other',
  ]),
  confidence: z.number().min(0).max(1),
  company: z.string().nullable(),
  role: z.string().nullable(),
  next_step: z.string().max(200).nullable().describe('What the reader has to do, if anything'),
  happens_at: z
    .string()
    .nullable()
    .describe('ISO 8601 date or datetime, only when the mail states one explicitly'),
  summary: z.string().max(160),
})

const SYSTEM = `You classify one email about someone's job applications.

Definitions:
- interview_invite: they want to schedule or have scheduled a conversation.
- assessment: a coding challenge, take-home, or online test to complete.
- rejection: they are not moving forward.
- recruiter_outreach: someone pitching a role the reader did not apply to.
- application_ack: an automated "we received your application".
- other: anything else, including newsletters and job alerts.

Rules:
- An automated acknowledgement is not an interview invite, however warm it reads.
- Extract only what the mail states. Never infer a company, a role, or a date that is not written down.
- happens_at is only for a date the mail explicitly gives. "Soon" and "next week" are not dates.
- Be decisive on rejections. Softening one into "other" leaves it sitting in someone's queue.`

export async function classifyEmail(
  userId: string,
  email: { from: string; subject: string; snippet: string },
): Promise<EmailClassification> {
  if (!hasModelAccess) {
    // Keyword-only fallback, honest about being one.
    const text = `${email.subject}\n${email.snippet}`
    const guess: EmailClass = /\b(?:unfortunately|not\s+moving\s+forward|regret|other\s+candidates)\b/i.test(text)
      ? 'rejection'
      : /\b(?:interview|schedule\s+a\s+call|meet)\b/i.test(text)
        ? 'interview_invite'
        : /\b(?:assessment|challenge|take[-\s]?home|test)\b/i.test(text)
          ? 'assessment'
          : 'other'
    return {
      classification: guess,
      confidence: 0.4,
      company: null,
      role: null,
      nextStep: null,
      happensAt: null,
      summary: email.subject.slice(0, 160),
    }
  }

  try {
    const answer = await structured(schema, {
      purpose: 'classify-email',
      userId,
      system: SYSTEM,
      prompt: `From: ${email.from}\nSubject: ${email.subject}\n\n${email.snippet.slice(0, 2_000)}`,
      effort: 'low',
      think: false,
      maxTokens: 800,
    })

    return {
      classification: answer.classification,
      confidence: answer.confidence,
      company: answer.company,
      role: answer.role,
      nextStep: answer.next_step,
      happensAt: answer.happens_at,
      summary: answer.summary.trim(),
    }
  } catch (error) {
    logger.warn({ err: error }, 'email classification failed')
    return {
      classification: 'other',
      confidence: 0,
      company: null,
      role: null,
      nextStep: null,
      happensAt: null,
      summary: email.subject.slice(0, 160),
    }
  }
}
