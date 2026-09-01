import { hasModelAccess } from '../config/env.js'
import { logger } from '../lib/logger.js'
import { modelFor, text as generateText } from '../model/gateway.js'
import type {
  ReferralDraft,
  ReferralDraftGenerator,
  ReferralDraftRequest,
} from './referral-draft.js'

/**
 * The real referral drafter.
 *
 * The one rule that matters: **no claim that is not in the source documents.**
 * This text goes out under the user's name to a colleague at their own
 * company. A flattering invention — "consistently exceeded targets", a project
 * nobody worked on — is a reputational hazard for the person sending it, and
 * they may not notice before they hit send.
 *
 * So the prompt is built to make omission the safe default: with thin source
 * material the draft should be short and hedged rather than padded.
 */

const SYSTEM = `You write a short internal referral note, in the first person, as the person doing the referring.

Hard rules:
- Every specific claim must be supported by the résumé or the job description you were given. If you cannot point to where a fact came from, leave it out.
- With little to go on, write less. A three-line honest note is far better than a paragraph of invention.
- Never invent metrics, employers, tenure, or achievements. Never say you have worked with them unless the input says so.
- No superlatives you cannot support. "Strong background in X" is fine when the résumé shows X; "exceptional engineer" is not.

Style: plain, direct, the way a person messages a colleague. No greeting, no sign-off — the product adds those. Two to five sentences.`

function promptFor(request: ReferralDraftRequest): string {
  const parts = [
    `You are ${request.referrerName}, referring ${request.requesterName}.`,
    request.targetRole ? `Role: ${request.targetRole}` : null,
    request.jobRequisitionId ? `Requisition: ${request.jobRequisitionId}` : null,
    request.requesterHeadline ? `Their headline: ${request.requesterHeadline}` : null,
    request.note ? `\nWhat they wrote to you:\n${request.note.slice(0, 1_200)}` : null,
    request.resumeText ? `\nTheir résumé:\n${request.resumeText.slice(0, 4_000)}` : null,
    request.jobDescription ? `\nThe job description:\n${request.jobDescription.slice(0, 2_500)}` : null,
    request.instructions ? `\nHow they want it written: ${request.instructions}` : null,
  ].filter(Boolean)

  if (!request.resumeText && !request.requesterHeadline) {
    parts.push(
      '\nYou have almost nothing about this person beyond their message. Keep the note to two sentences and do not characterise their experience.',
    )
  }

  return parts.join('\n')
}

class ModelReferralDraftGenerator implements ReferralDraftGenerator {
  readonly name = 'anthropic'
  readonly isReal = true

  async generate(request: ReferralDraftRequest): Promise<ReferralDraft> {
    const model = modelFor('draft-referral')
    const body = await generateText({
      purpose: 'draft-referral',
      // Drafts are attributed to the referrer, so the cost is theirs.
      userId: null,
      system: SYSTEM,
      prompt: promptFor(request),
      effort: 'low',
      maxTokens: 800,
    })

    // The product owns the sign-off so every draft ends the same way and the
    // model has one less thing to get wrong.
    const withSignature = `${body.trim()}\n\n— ${request.referrerName}`
    return { text: withSignature, model, generatedAt: new Date() }
  }
}

/**
 * Registers the real drafter when a model is configured.
 *
 * Without a key the template stub stays, which is the right degradation: a
 * serviceable skeleton the user can edit beats an error where a draft should
 * be.
 */
export function registerReferralDraftGenerator(
  set: (generator: ReferralDraftGenerator) => void,
): void {
  if (!hasModelAccess) {
    logger.warn('No model configured — referral drafts stay templated.')
    return
  }
  set(new ModelReferralDraftGenerator())
}
