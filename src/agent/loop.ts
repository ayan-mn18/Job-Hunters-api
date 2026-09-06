import type { Page } from 'playwright-core'
import { env } from '../config/env.js'
import { logger } from '../lib/logger.js'
import { museSpark, type MuseMessage } from '../model/muse-spark.js'
import { needsPicture, observe, renderObservation, type Observation } from './observe.js'
import { runTool, toolsFor, type AgentReport, type ToolContext } from './tools.js'

/**
 * The agent.
 *
 * Muse Spark decides, Playwright acts, and this file is the loop between them.
 * It replaces Stagehand, which had to be dropped for three separate reasons:
 * it could only reason with providers on its own list, it needed a browser
 * extension that Chromium would not load headlessly — so it ran a second,
 * invisible browser and the live view went dark for the whole agent phase —
 * and it bundled a zod major version this project does not use.
 *
 * The shape here is deliberately small: one observation, one tool call, one
 * action, repeat. An earlier version handed the model a paragraph-long goal
 * and asked it to plan; it sat inside a single call for over half an hour on a
 * live run. Every step is bounded, the whole run is bounded, and the loop
 * always returns a report even when nothing worked.
 */

const SYSTEM_RULES = [
  'You are filling in a web form on behalf of a job applicant, one step at a time.',
  '',
  'Rules:',
  '- Call exactly one tool per turn. Never answer in prose alone.',
  '- Use only the facts you are given. Never invent an employer, a date, a degree or a number.',
  '- Leave blank anything the facts do not support, and report it in "blocked".',
  '- Never answer questions about visa status, sponsorship, disability, gender, race,',
  '  ethnicity, veteran status, sexual orientation or age. Report them in "blocked".',
  '- Elements are addressed by the number in brackets. The numbers change every turn;',
  '  always use the ones in the latest list.',
  '- If a tool reports an error, do not call done immediately. Diagnose it from the',
  '  latest observation, correct the URL or action, and retry. Only stop after the',
  '  same failure has repeated several times.',
  '- Prefer the element list over screenshots. A screenshot costs far more and rarely',
  '  tells you anything the list did not.',
  '- When the form is complete, or when you are stuck, call done and say what happened.',
].join('\n')

export interface AgentRunOptions {
  page: Page
  userId: string | null
  /** What this run is for, in one or two sentences. */
  goal: string
  /** The site skill's playbook, injected verbatim. */
  playbook?: string
  /** Facts the agent may use — the candidate profile, the job. */
  facts?: Record<string, unknown>
  allowedDomains: string[]
  dryRun: boolean
  /** Files the agent may attach, by keyword: `resume`, `cover-letter`. */
  files?: Record<string, string>
  /** A navigation error from the deterministic tier, if one happened first. */
  initialNavigationError?: string
  maxSteps?: number
  /**
   * Lets the agent put a question to the person watching. Absent means nobody
   * is there, and the `ask` tool is not offered at all.
   */
  onAsk?: (question: string) => Promise<string | null>
  onStep?: (step: {
    index: number
    tool: string
    args: Record<string, unknown>
    result: string
    ok: boolean
    url: string
  }) => void | Promise<void>
}

export interface AgentRunResult extends AgentReport {
  steps: number
  /** Why the loop ended: the agent said so, or it ran out of room. */
  stoppedBecause: 'done' | 'max-steps' | 'error'
}

/**
 * A ceiling on one step.
 *
 * Apply jobs are queued with `attempts: 1` and no timeout of their own, so a
 * step that never returns parks an application in `applying` forever and
 * blocks the lane behind it.
 */
async function withDeadline<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Keeps the conversation from growing without limit.
 *
 * Old observations are worthless — the page has moved on and the refs in them
 * are stale — but the system message and the goal are not, so they are pinned.
 *
 * The cut has to land on a boundary. A tool reply whose assistant message was
 * trimmed away is not merely confusing, it is a 400 from the API: *"role='tool'
 * message with tool_call_id=… has no matching assistant message with
 * tool_calls"*. That killed a live run at step six, so the cut walks backwards
 * until it is no longer separating a pair.
 */
export function trim(messages: MuseMessage[], keep = 14): MuseMessage[] {
  if (messages.length <= keep + 2) return messages
  let start = messages.length - keep
  while (start > 2 && messages[start]?.role === 'tool') start -= 1
  return [...messages.slice(0, 2), ...messages.slice(start)]
}

function fingerprint(observation: Observation): string {
  return `${observation.url}|${observation.elements.map((element) => `${element.ref}${element.label}${element.value}`).join(',')}`
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const {
    page,
    userId,
    goal,
    playbook,
    facts,
    allowedDomains,
    dryRun,
    files = {},
    maxSteps = env.APPLY_AGENT_MAX_STEPS,
  } = options

  const stepTimeout = env.APPLY_AGENT_STEP_TIMEOUT_MS
  const tools = toolsFor(dryRun, Boolean(options.onAsk))

  const system = [
    SYSTEM_RULES,
    dryRun
      ? '\nThis is a DRY RUN. There is no way to submit and you must not try. Fill the form and stop.'
      : '',
    playbook ? `\n--- What to know about this site ---\n${playbook}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const messages: MuseMessage[] = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        `Goal: ${goal}`,
        facts ? `\nFacts you may use:\n${JSON.stringify(facts)}` : '',
        Object.keys(files).length ? `\nFiles you can attach: ${Object.keys(files).join(', ')}` : '',
        options.initialNavigationError
          ? `\nThe first navigation attempt failed with: ${options.initialNavigationError}. This is recoverable: inspect the current page and try a corrected navigation or another path to the form.`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ]

  let report: AgentReport = {
    reachedForm: false,
    submitted: false,
    filled: [],
    blocked: [],
    note: 'The agent took no action.',
  }
  let stoppedBecause: AgentRunResult['stoppedBecause'] = 'max-steps'
  /**
   * What the agent actually did, as opposed to what it says it did.
   *
   * A run that hits the step ceiling never reaches `done`, and the report was
   * therefore empty — on a live Greenhouse form that meant seven filled fields,
   * a résumé and a LinkedIn URL all recorded as nothing having happened. The
   * loop watched every one of those succeed; there is no reason to depend on
   * the model to remember them.
   */
  const observed: string[] = []
  let wantPicture = false
  let previous = ''
  let steps = 0
  let lastToolError = ''
  let repeatedToolErrors = 0
  let lastObserveError = ''
  let repeatedObserveErrors = 0
  let lastModelError = ''
  let repeatedModelErrors = 0

  const errorKey = (value: unknown): string =>
    String(value)
      .toLowerCase()
      .replace(/[0-9a-f]{8,}/g, '#')
      .replace(/\d+/g, '#')
      .slice(0, 320)

  for (let step = 0; step < maxSteps; step += 1) {
    steps = step + 1

    let observation: Observation
    try {
      observation = await withDeadline('agent: observe', stepTimeout, observe(page))
    } catch (error) {
      logger.warn({ err: error }, 'agent could not read the page')
      const key = errorKey(error)
      repeatedObserveErrors = key === lastObserveError ? repeatedObserveErrors + 1 : 1
      lastObserveError = key
      if (repeatedObserveErrors >= env.APPLY_RECOVERY_ATTEMPTS) {
        stoppedBecause = 'error'
        report.note = `The page could not be read after ${repeatedObserveErrors} recovery attempts.`
        break
      }
      messages.push({
        role: 'user',
        content: `The browser could not be read (${repeatedObserveErrors}/${env.APPLY_RECOVERY_ATTEMPTS}). Reloading it; continue after the page becomes available. Error: ${String(error)}`,
      })
      await page.reload({ waitUntil: 'domcontentloaded', timeout: stepTimeout }).catch(() => undefined)
      continue
    }
    lastObserveError = ''
    repeatedObserveErrors = 0

    const unchanged = fingerprint(observation) === previous
    previous = fingerprint(observation)

    const text = renderObservation(observation)
    if (wantPicture || needsPicture(observation, unchanged && step > 0)) {
      wantPicture = false
      const shot = await page
        .screenshot({ type: 'png', fullPage: false })
        .catch(() => null)
      messages.push({
        role: 'user',
        content: shot
          ? [
              { type: 'text', text },
              {
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${shot.toString('base64')}` },
              },
            ]
          : text,
      })
    } else {
      messages.push({ role: 'user', content: text })
    }

    let result
    try {
      result = await withDeadline(
        'agent: think',
        stepTimeout,
        museSpark({
          userId,
          purpose: 'apply-agent',
          messages: trim(messages),
          tools,
          maxTokens: env.APPLY_AGENT_MAX_TOKENS,
        }),
      )
    } catch (error) {
      logger.warn({ err: error }, 'agent step failed')
      const key = errorKey(error)
      repeatedModelErrors = key === lastModelError ? repeatedModelErrors + 1 : 1
      lastModelError = key
      if (repeatedModelErrors >= env.APPLY_RECOVERY_ATTEMPTS) {
        stoppedBecause = 'error'
        report.note = `${error instanceof Error ? error.message : String(error)} after ${repeatedModelErrors} recovery attempts.`
        break
      }
      messages.push({
        role: 'user',
        content: `The model request failed (${repeatedModelErrors}/${env.APPLY_RECOVERY_ATTEMPTS}). Retry the reasoning step; do not abandon the application yet. Error: ${String(error)}`,
      })
      continue
    }
    lastModelError = ''
    repeatedModelErrors = 0

    const call = result.toolCalls[0]
    if (!call) {
      // No tool call means the model answered in prose. Say so once and give
      // it another turn; a second miss ends the run rather than burning steps
      // on a conversation.
      messages.push({ role: 'assistant', content: result.content ?? '' })
      messages.push({
        role: 'user',
        content: 'That was not a tool call. Call exactly one tool, or call done.',
      })
      if (step > 0 && !result.content) {
        stoppedBecause = 'error'
        report.note = 'The agent stopped answering.'
        break
      }
      continue
    }

    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
    } catch {
      args = {}
    }

    const context: ToolContext = {
      page,
      allowedDomains,
      dryRun,
      files,
      observation,
      ...(options.onAsk ? { onAsk: options.onAsk } : {}),
    }
    let outcome
    try {
      outcome =
        call.function.name === 'ask'
          ? // No deadline: this one is waiting for a person, and `onAsk` carries
            // its own. Capping it at the step timeout would abandon the question
            // while they were still typing.
            await runTool(context, call.function.name, args)
          : await withDeadline(
              `agent: ${call.function.name}`,
              stepTimeout,
              runTool(context, call.function.name, args),
            )
    } catch (error) {
      outcome = {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }

    if (call.function.name === 'screenshot') wantPicture = true

    if (outcome.ok && ['fill', 'select', 'upload'].includes(call.function.name)) {
      const element = observation.elements.find((item) => item.ref === Number(args.ref))
      if (element && !observed.includes(element.label)) observed.push(element.label)
    }

    await options.onStep?.({
      index: steps,
      tool: call.function.name,
      args,
      result: outcome.message,
      ok: outcome.ok,
      url: page.url(),
    })

    messages.push({
      role: 'assistant',
      content: result.content ?? '',
      tool_calls: [call],
    })
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: `${outcome.ok ? 'OK' : 'REFUSED'}: ${outcome.message}`,
    })

    const hadToolError = repeatedToolErrors > 0
    if (!outcome.ok) {
      const key = errorKey(outcome.message)
      repeatedToolErrors = key === lastToolError ? repeatedToolErrors + 1 : 1
      lastToolError = key
      if (repeatedToolErrors >= env.APPLY_RECOVERY_ATTEMPTS) {
        stoppedBecause = 'error'
        report.note = `The same browser action failed ${repeatedToolErrors} times: ${outcome.message}`
        break
      }
    } else if (call.function.name !== 'done') {
      // A successful corrective action clears the repeated-error guard. A
      // successful `done` is handled below so the model cannot use it to
      // bypass the retry budget immediately after a failed action.
      repeatedToolErrors = 0
      lastToolError = ''
    }

    if (outcome.finished && hadToolError && repeatedToolErrors > 0) {
      messages.push({
        role: 'user',
        content: `Do not call done immediately after a recoverable action error. Diagnose the last failure and try a corrected action. You have ${Math.max(0, env.APPLY_RECOVERY_ATTEMPTS - repeatedToolErrors)} recovery attempt(s) left for this repeated error.`,
      })
      continue
    }

    if (outcome.finished) {
      report = outcome.finished
      stoppedBecause = 'done'
      break
    }
  }

  if (stoppedBecause === 'max-steps' && report.note === 'The agent took no action.') {
    report.note = observed.length
      ? `Ran out of steps after ${steps}, with ${observed.length} field${observed.length === 1 ? '' : 's'} filled.`
      : `Ran out of steps after ${steps}.`
  }

  // The agent's own list wins where it exists — it knows which of its actions
  // it considers part of the answer — and the observed ones fill the gap when
  // it never got to say.
  const filled = [...report.filled]
  for (const label of observed) {
    if (!filled.includes(label)) filled.push(label)
  }

  return { ...report, filled, steps, stoppedBecause }
}
