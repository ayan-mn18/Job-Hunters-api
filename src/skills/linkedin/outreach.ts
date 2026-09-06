import { runAgent } from '../../agent/loop.js'
import { logger } from '../../lib/logger.js'
import type { AgentSession } from '../../browser/session.js'
import type { SendableMessage } from '../../outreach/sequence.js'
import { CheckpointError, sendInvite, sendMessage, type SendResult } from './send.js'
import { linkedinManifest } from './manifest.js'
import { linkedinPlaybook } from './playbook.js'

/**
 * Sending, with a fallback that is deliberately narrow.
 *
 * The hand-written path in `send.ts` clicks what a person would click, in the
 * order a person would click it, and gives up rather than trying a second
 * route. That is the right default and stays the first attempt: it is
 * predictable, it is cheap, and it cannot be talked into doing something else.
 *
 * It has one failure mode worth covering — LinkedIn moves its markup and the
 * button is no longer where the selector says. That is what the agent is for,
 * and only that. It is given the message already written, told to paste it
 * verbatim, and confined to linkedin.com. It never composes, never chooses a
 * recipient, and never runs after a checkpoint.
 */

/** Failures worth a second attempt: the control was not found, not refused. */
const MARKUP_DRIFT = /no (connect|send|message|withdraw) (button|control)|did not open|not available/i

export async function send(
  session: AgentSession,
  message: SendableMessage,
  options: { dryRun?: boolean } = {},
): Promise<SendResult> {
  const first =
    message.kind === 'invite'
      ? await sendInvite(session.context, message)
      : await sendMessage(session.context, message)

  if (first.ok || !MARKUP_DRIFT.test(first.error ?? '')) return first
  if (options.dryRun) return first

  logger.info(
    { to: message.name, kind: message.kind, error: first.error },
    'linkedin markup moved — retrying the send with the agent',
  )

  try {
    const page = session.page
    await page.goto(message.profileUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })

    const result = await runAgent({
      page,
      userId: null,
      goal:
        message.kind === 'invite'
          ? 'Send this person a connection invitation with the prepared note attached. Paste the note verbatim.'
          : 'Open the message composer for this person and send the prepared message. Paste it verbatim.',
      playbook: await linkedinPlaybook(),
      facts: { recipient: message.name, message: message.body },
      allowedDomains: linkedinManifest.allowedDomains,
      dryRun: false,
      // Half the usual ceiling. This is one interaction on someone's real
      // account, not a form with forty fields.
      maxSteps: 8,
    })

    return result.submitted
      ? { ok: true }
      : { ok: false, error: result.note || 'The agent could not complete the send.' }
  } catch (error) {
    if (error instanceof CheckpointError) throw error
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
