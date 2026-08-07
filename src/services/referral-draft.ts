import { logger } from '../lib/logger.js'

/**
 * ============================ STUBBED WORKSTREAM ============================
 * Writing the actual recommendation from someone's resume + the job
 * description is a generation task owned elsewhere. This is the seam.
 *
 * TODO(generation-workstream): register a real generator via
 * `setReferralDraftGenerator()` at boot. See docs/.
 * ===========================================================================
 */

export interface ReferralDraftRequest {
  referralId: string
  requesterName: string
  requesterHeadline?: string | null
  targetRole?: string | null
  jobRequisitionId?: string | null
  jobDescription?: string | null
  /** Their original message, verbatim. */
  note?: string | null
  resumeName?: string | null
  resumeText?: string | null
  /** Who is doing the referring — used for the first-person voice. */
  referrerName: string
  /** Free-form steer, e.g. "keep it short", "mention the payments project". */
  instructions?: string | null
}

export interface ReferralDraft {
  text: string
  /** Model identifier, or `stub` while unimplemented. Stored for audit. */
  model: string
  generatedAt: Date
}

export interface ReferralDraftGenerator {
  readonly name: string
  readonly isReal: boolean
  generate(request: ReferralDraftRequest): Promise<ReferralDraft>
}

/**
 * Assembles a serviceable skeleton from the facts already on the row. It says
 * only things we actually know — no invented achievements. The user can send
 * it as-is or edit it; either beats a blank box.
 */
class StubReferralDraftGenerator implements ReferralDraftGenerator {
  readonly name = 'stub'
  readonly isReal = false

  async generate(request: ReferralDraftRequest): Promise<ReferralDraft> {
    logger.warn(
      { referralId: request.referralId },
      'referral draft generator is stubbed — assembling a template',
    )

    const role = request.targetRole ?? 'the open role'
    const requisition = request.jobRequisitionId ? ` (${request.jobRequisitionId})` : ''
    const headline = request.requesterHeadline
      ? ` Their background: ${request.requesterHeadline}.`
      : ''
    const attachment = request.resumeName ? ` Resume attached: ${request.resumeName}.` : ''

    const text = [
      `Happy to refer ${request.requesterName} for ${role}${requisition}.`,
      headline.trim(),
      'I have looked over their experience and think it lines up well with what this team needs.',
      attachment.trim(),
      'Glad to answer anything else.',
      '',
      `— ${request.referrerName}`,
      '',
      '[Draft written by a placeholder. Wire up the real generator to get a',
      'recommendation built from their resume and the job description.]',
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/ +\n/g, '\n')

    return { text, model: 'stub', generatedAt: new Date() }
  }
}

let generator: ReferralDraftGenerator = new StubReferralDraftGenerator()

export function getReferralDraftGenerator(): ReferralDraftGenerator {
  return generator
}

export function setReferralDraftGenerator(next: ReferralDraftGenerator): void {
  generator = next
  logger.info({ generator: next.name, isReal: next.isReal }, 'referral draft generator registered')
}
