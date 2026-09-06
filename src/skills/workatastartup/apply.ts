import { runAgent } from '../../agent/loop.js'
import { logger } from '../../lib/logger.js'
import { text as generateText } from '../../model/gateway.js'
import { sensitiveReason } from '../../hunt/apply/fields.js'
import type { ApplyOutcome, ApplyParams } from '../types.js'
import { workAtAStartupManifest } from './manifest.js'
import { workAtAStartupPlaybook } from './playbook.js'

/**
 * Applying on Work at a Startup.
 *
 * This board is not an ATS. The application is a short message to the founders
 * and almost nothing else, which changes where the work is: composing is the
 * hard part and placing the text is the easy part. So the two are split —
 * Muse Spark writes the note in one call with the whole candidate in front of
 * it, and the agent's only job is to get it into the right box.
 *
 * Writing the note inside the agent loop was the obvious first design and it
 * is worse: the model sees the page but only a trimmed conversation, so the
 * note comes out generic exactly when specificity is the whole value.
 */

const SIGN_IN = /account\.ycombinator\.com|\/authenticate/

async function composeNote(params: ApplyParams): Promise<string> {
  const facts = params.facts as {
    job?: { title?: string; company?: string; description?: string }
    candidate?: unknown
  }

  return generateText({
    purpose: 'draft-outreach',
    userId: params.userId,
    system: [
      'You write a short application note from a job applicant to the founders of a',
      'Y Combinator startup. Founders read these themselves.',
      '',
      'Three to six sentences. Name what the company builds and the closest thing the',
      'applicant has actually built. Plain, direct, first person. No salutation block,',
      'no "I am writing to express my interest", no bullet points, no sign-off.',
      'Use only the facts given. Never claim a technology, employer or number that is',
      'not in them.',
    ].join('\n'),
    prompt: [
      `Role: ${facts.job?.title ?? 'unknown'} at ${facts.job?.company ?? 'this company'}`,
      '',
      'Posting:',
      (facts.job?.description ?? '').slice(0, 4_000),
      '',
      'Applicant:',
      JSON.stringify(facts.candidate ?? {}),
    ].join('\n'),
    maxTokens: 6_000,
  })
}

export async function applyOnWorkAtAStartup(params: ApplyParams): Promise<ApplyOutcome> {
  const { session, applyUrl, dryRun } = params
  const page = session.page

  await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })

  // A redirect to YC's sign-in means this user's profile has no live session.
  // That is a thing only they can fix, and guessing at credentials here would
  // be both useless and wrong.
  if (SIGN_IN.test(page.url())) {
    return {
      reached: 'nothing',
      filled: [],
      blocked: [{ label: 'Y Combinator sign-in', why: 'needs_account' }],
      note: 'Work at a Startup asked for a sign-in. Connect the YC account and try again.',
      steps: 0,
    }
  }

  let note: string
  try {
    note = await composeNote(params)
  } catch (error) {
    logger.warn({ err: error }, 'could not compose the founder note')
    return {
      reached: 'nothing',
      filled: [],
      blocked: [{ label: 'Message to founders', why: 'no_draft' }],
      note: 'The application note could not be written, and this board is the note.',
      steps: 0,
    }
  }

  const result = await runAgent({
    page,
    userId: params.userId,
    goal: [
      'Open the application form for this posting and complete it.',
      'The message to the founders is already written — paste it verbatim into the',
      'message or cover-letter field. Do not rewrite it, shorten it or add to it.',
      dryRun
        ? 'Stop once every field is filled. Do not submit.'
        : 'Submit once every required field is filled.',
    ].join(' '),
    playbook: await workAtAStartupPlaybook(),
    facts: { ...params.facts, messageToFounders: note },
    allowedDomains: workAtAStartupManifest.allowedDomains,
    dryRun,
    files: params.files,
    onStep: params.onStep
      ? (step) => params.onStep?.({ index: step.index, tool: step.tool, result: step.result, ok: step.ok })
      : undefined,
  })

  return {
    reached: result.submitted ? 'submitted' : result.reachedForm ? 'form' : 'nothing',
    // The agent is not trusted to have honoured the sensitive-question rule.
    // Anything it claims to have filled that matches the never-auto list is
    // reported as blocked regardless of what it says it did.
    filled: result.filled
      .filter((label) => !sensitiveReason(label))
      .map((label) => ({ label, value: '[agent]' })),
    blocked: [
      ...result.blocked.map((label) => ({
        label,
        why: sensitiveReason(label) ?? 'unknown_field',
      })),
      ...result.filled
        .filter((label) => sensitiveReason(label))
        .map((label) => ({ label, why: sensitiveReason(label) as string })),
    ],
    note: result.note,
    steps: result.steps,
  }
}
