import { z } from 'zod/v4'
import { hasModelAccess } from '../config/env.js'
import { logger } from '../lib/logger.js'
import { structured } from '../model/gateway.js'

/**
 * Deciding whether a thread is somebody asking to be referred.
 *
 * Two stages, because one cannot do both jobs. A regex is free and catches
 * almost every real request, but it also catches "I got a referral last year"
 * and misses anyone who phrased it politely enough. A model reads the thread
 * and knows the difference, but is too expensive to run over an entire inbox.
 *
 * So: the regex decides what to *look at*, and the model decides what it *is*.
 * The prefilter is deliberately loose — a missed referral request is worse
 * than one extra card to dismiss, and a false positive here only costs a
 * classification.
 */

/**
 * The cheap pass. Widened from the original four patterns, which required the
 * word "refer" close to a request and so missed most polite phrasings.
 */
const PREFILTER = [
  /\brefer(?:ral|rals|ring|red)?\b/i,
  /\b(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+)?(?:help|refer|put\s+in)/i,
  /\bput\s+in\s+a\s+(?:good\s+)?word\b/i,
  /\b(?:vouch|recommend)\s+(?:for\s+)?me\b/i,
  /\bapplied\s+(?:to|for)\b[\s\S]{0,80}\b(?:your\s+company|at\s+your|position|role|opening)\b/i,
  /\b(?:opening|opportunit(?:y|ies)|position|vacanc(?:y|ies))\b[\s\S]{0,60}\b(?:your\s+(?:company|team|org))\b/i,
  /\bjob\s*id\b|\brequisition\b|\breq\s*id\b/i,
]

/** True when a thread is worth spending a classification on. */
export function mightBeReferralRequest(text: string): boolean {
  return PREFILTER.some((pattern) => pattern.test(text))
}

export type ReferralVerdict = 'request' | 'not_request' | 'unclear'

export interface ReferralClassification {
  verdict: ReferralVerdict
  confidence: number
  targetRole: string | null
  company: string | null
  requisitionId: string | null
  /** How well they seem to know the user, in their own words. */
  relationship: string | null
  urgency: 'low' | 'normal' | 'high' | null
  /** One line, for the card. */
  summary: string
}

const schema = z.object({
  verdict: z
    .enum(['request', 'not_request', 'unclear'])
    .describe('Is this person asking to be referred, right now, by the reader?'),
  confidence: z.number().min(0).max(1),
  target_role: z.string().nullable(),
  company: z.string().nullable(),
  requisition_id: z.string().nullable(),
  relationship: z.string().nullable().describe('How they seem to know the reader, if the thread says'),
  urgency: z.enum(['low', 'normal', 'high']).nullable(),
  summary: z.string().max(200),
})

const SYSTEM = `You read a LinkedIn conversation and decide whether the other person is asking the reader for a job referral.

A referral request is someone asking the reader to refer, recommend, or put in a word for them — now, at the reader's company.

These are NOT requests:
- Mentioning a referral they already received, or gave
- Asking about the company generally, or about interviews
- Offering to refer the reader
- Recruiters pitching a role to the reader
- A thread where the reader already handled it and the person said thanks

Read the whole thread, not one message. A request routinely spans three: a greeting, some context, then the ask.

Use "unclear" when the thread is genuinely ambiguous — a missed request is worse than one extra card for someone to dismiss, so an honest "unclear" is more useful than a confident guess.

Extract only what the thread states. Never infer a company or a requisition id that is not written down.`

export interface ThreadMessage {
  senderName: string
  body: string
  outbound: boolean
  sentAt?: string | null
}

function renderThread(messages: ThreadMessage[]): string {
  return messages
    .slice(-14)
    .map((message) => {
      const who = message.outbound ? 'READER' : message.senderName || 'THEM'
      return `${who}: ${message.body.slice(0, 800)}`
    })
    .join('\n\n')
}

/**
 * Classifies a whole thread.
 *
 * Falls back to the prefilter's opinion when no model is configured — the
 * feature degrades to what it did before rather than disappearing.
 */
export async function classifyThread(
  userId: string,
  messages: ThreadMessage[],
): Promise<ReferralClassification> {
  const inbound = messages.filter((message) => !message.outbound)
  const text = inbound.map((message) => message.body).join('\n')

  if (!hasModelAccess) {
    const guess = mightBeReferralRequest(text)
    return {
      verdict: guess ? 'request' : 'not_request',
      // Say plainly that this is a keyword match, not a judgement.
      confidence: guess ? 0.5 : 0.2,
      targetRole: null,
      company: null,
      requisitionId: null,
      relationship: null,
      urgency: null,
      summary: guess ? 'Mentions a referral.' : 'No referral language found.',
    }
  }

  try {
    const answer = await structured(schema, {
      purpose: 'classify-referral',
      userId,
      system: SYSTEM,
      prompt: renderThread(messages),
      effort: 'low',
      think: false,
      maxTokens: 1_000,
    })

    return {
      verdict: answer.verdict,
      confidence: answer.confidence,
      targetRole: answer.target_role,
      company: answer.company,
      requisitionId: answer.requisition_id,
      relationship: answer.relationship,
      urgency: answer.urgency,
      summary: answer.summary.trim(),
    }
  } catch (error) {
    logger.warn({ err: error }, 'referral classification failed; falling back to the prefilter')
    const guess = mightBeReferralRequest(text)
    return {
      verdict: guess ? 'unclear' : 'not_request',
      confidence: 0.4,
      targetRole: null,
      company: null,
      requisitionId: null,
      relationship: null,
      urgency: null,
      summary: 'Could not be classified.',
    }
  }
}

/** Above this a thread goes straight to the pile. */
export const CONFIDENT = 0.75
/** Between this and CONFIDENT it goes to "maybe" rather than being dropped. */
export const MAYBE = 0.4

export type Bucket = 'referral' | 'maybe' | 'ignored'

/**
 * Where a classified thread belongs.
 *
 * The middle bucket exists because the alternative is silently discarding
 * anything the model was unsure about — and the cost of dropping a real
 * referral request is much higher than the cost of one extra card.
 */
export function bucketFor(classification: ReferralClassification): Bucket {
  if (classification.verdict === 'not_request') return 'ignored'
  if (classification.verdict === 'request' && classification.confidence >= CONFIDENT) return 'referral'
  if (classification.confidence >= MAYBE) return 'maybe'
  return 'ignored'
}
