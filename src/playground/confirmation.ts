import { sendMail } from '../lib/mailer.js'
import type { ApplyOutcome } from '../skills/types.js'

/**
 * The receipt.
 *
 * The last thing a run produces is the only thing anyone reads a week later,
 * and "applied ✅" in a table is not evidence — it does not say what went in,
 * what was deliberately left out, or where to look when a founder replies.
 *
 * Its contents are read off the outcome rather than written as fixed copy. An
 * earlier draft listed every field as sent regardless, which on a run where
 * something had been left blank was simply untrue, and an untrue receipt is
 * worse than none.
 */

export interface ConfirmationInput {
  to: string
  run: { id: string; prompt: string }
  job: { title: string; company: string; location: string; url: string }
  filled: ApplyOutcome['filled']
  blocked: ApplyOutcome['blocked']
  dryRun: boolean
}

function readable(label: string): string {
  return label.replace(/\s*\*$/, '').trim().toLowerCase()
}

export function confirmationBody(input: ConfirmationInput): { subject: string; text: string } {
  const { job, filled, blocked, dryRun } = input
  const sent = filled.map((field) => readable(field.label))
  const left = blocked.map((field) => readable(field.label))
  const refused = blocked.some((field) => field.why === 'sensitive_field')

  const subject = dryRun
    ? `Dry run: ${job.title} at ${job.company}`
    : `Applied: ${job.title} at ${job.company}`

  const text = [
    dryRun
      ? `Filled the application for ${job.title} at ${job.company} and stopped before submitting.`
      : `Your application for ${job.title} at ${job.company} has gone in.`,
    '',
    `Where: ${job.location || 'not stated'}`,
    `Posting: ${job.url}`,
    '',
    sent.length ? `Sent: ${sent.join(', ')}.` : 'Nothing was filled.',
    left.length ? `Left blank: ${left.join(', ')}.` : '',
    refused
      ? 'Visa, demographic and disability questions are never answered on your behalf.'
      : '',
    '',
    dryRun
      ? 'Nothing was submitted. Turn off APPLY_DRY_RUN to send applications for real.'
      : 'If they reply, it will land in this inbox.',
    '',
    '— Hunty',
  ]
    .filter((line) => line !== '')
    .join('\n')

  return { subject, text }
}

export async function sendRunConfirmation(
  input: ConfirmationInput,
): Promise<{ sent: boolean; error?: string }> {
  const { subject, text } = confirmationBody(input)
  return sendMail({ to: input.to, subject, text })
}
