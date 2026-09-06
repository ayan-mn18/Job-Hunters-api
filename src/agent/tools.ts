import type { Page } from 'playwright-core'
import { logger } from '../lib/logger.js'
import { sensitiveReason } from '../hunt/apply/fields.js'
import { normaliseHttpUrl } from '../hunt/apply/urls.js'
import { refSelector, type Observation } from './observe.js'

/**
 * The only things the agent can do.
 *
 * A prompt is not a fence. Anything the model must never do is refused here,
 * in code, on the argument it actually passed — not asked for politely in a
 * system message that a confused model will talk itself out of:
 *
 *  - **Navigation** is confined to the skill's own domains. An application
 *    form does not need to visit anywhere else, and an agent that follows a
 *    link off-site is an agent operating with no rules at all.
 *  - **Sensitive questions** — visa status, sponsorship, disability, gender,
 *    race, ethnicity, veteran status, sexual orientation, age — are refused
 *    for every write, using the same `sensitiveReason` list the deterministic
 *    tier uses. Inferring an answer to those is not a capability worth having.
 *  - **Submitting** does not exist in a dry run. Not discouraged: absent from
 *    the tool list, and refused again in the executor if the model invents it.
 */

export interface ToolContext {
  page: Page
  /** Hostnames the agent may reach, from the site skill's manifest. */
  allowedDomains: string[]
  dryRun: boolean
  /** Local paths the agent may upload, by keyword: `resume`, `cover-letter`. */
  files: Record<string, string>
  /** Refreshed by the loop after each action. */
  observation: Observation
  /**
   * Puts a question to the person watching, and waits for their answer.
   *
   * Present only when somebody is actually watching — a batch run has nobody
   * to ask, and offering the tool there would strand the agent waiting for a
   * reply that cannot come. Returns null when nobody answered in time.
   */
  onAsk?: (question: string) => Promise<string | null>
}

export interface ToolResult {
  ok: boolean
  message: string
  /** Set by `done`, which ends the loop. */
  finished?: AgentReport
}

export interface AgentReport {
  reachedForm: boolean
  submitted: boolean
  filled: string[]
  blocked: string[]
  note: string
}

/* --------------------------------------------------------------- definitions */

const BASE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'click',
      description:
        'Click an element by its reference number. Use for buttons, links, checkboxes and radios.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'integer', description: 'The [n] shown beside the element.' },
          why: { type: 'string', description: 'One short sentence on what this should achieve.' },
        },
        required: ['ref', 'why'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fill',
      description: 'Type a value into a text field or textarea, replacing whatever is there.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'integer' },
          value: { type: 'string' },
        },
        required: ['ref', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select',
      description: 'Choose an option in a dropdown, by its visible text.',
      parameters: {
        type: 'object',
        properties: { ref: { type: 'integer' }, option: { type: 'string' } },
        required: ['ref', 'option'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'upload',
      description:
        'Attach a prepared file to a file input. `name` is a keyword such as "resume", not a path.',
      parameters: {
        type: 'object',
        properties: { ref: { type: 'integer' }, name: { type: 'string' } },
        required: ['ref', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'goto',
      description: 'Navigate to a URL on this site.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description: 'Scroll the page to reveal more of it.',
      parameters: {
        type: 'object',
        properties: { direction: { type: 'string', enum: ['up', 'down'] } },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description:
        'Look at the page as an image. Use only when the element list is empty or an action had no visible effect — it is far more expensive than reading the list.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description:
        'Stop, and report what happened. Call this when the form is complete, or when you cannot make further progress.',
      parameters: {
        type: 'object',
        properties: {
          reachedForm: { type: 'boolean' },
          submitted: { type: 'boolean' },
          filled: { type: 'array', items: { type: 'string' }, description: 'Labels you filled.' },
          blocked: {
            type: 'array',
            items: { type: 'string' },
            description: 'Labels you could not answer, and left alone.',
          },
          note: { type: 'string' },
        },
        required: ['reachedForm', 'submitted', 'filled', 'blocked', 'note'],
      },
    },
  },
] as const

/**
 * Asking, rather than guessing.
 *
 * The failure this replaces is an agent inventing a notice period or a salary
 * because the form demanded one. A wrong answer on somebody's application is
 * not a bug you can apologise for afterwards, so when the facts do not contain
 * something, the correct move is to stop and ask the person whose application
 * it is.
 */
const ASK_TOOL = {
  type: 'function',
  function: {
    name: 'ask',
    description:
      'Ask the person watching for something the facts do not contain — a number, a date, a decision. '
      + 'Use this instead of guessing. Do not use it for questions about visa status, demographics or '
      + 'disability: those are never answered, by anyone, and belong in "blocked".',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'One plain question. Say which field it is for and why you cannot fill it.',
        },
      },
      required: ['question'],
    },
  },
} as const

const SUBMIT_TOOL = {
  type: 'function',
  function: {
    name: 'submit',
    description:
      'Send the completed application. Only once every required field is filled and correct.',
    parameters: {
      type: 'object',
      properties: { ref: { type: 'integer', description: 'The submit control.' } },
      required: ['ref'],
    },
  },
} as const

/**
 * The tool list for this run.
 *
 * In a dry run, submitting is not offered. Asking is only offered when there is
 * somebody to ask.
 */
export function toolsFor(dryRun: boolean, canAsk = false): unknown[] {
  return [...BASE_TOOLS, ...(canAsk ? [ASK_TOOL] : []), ...(dryRun ? [] : [SUBMIT_TOOL])]
}

/* ------------------------------------------------------------------ helpers */

function hostAllowed(url: string, allowed: string[]): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return allowed.some((domain) => {
    const clean = domain.replace(/^\*\./, '').toLowerCase()
    return host === clean || host.endsWith(`.${clean}`)
  })
}

function elementFor(context: ToolContext, ref: unknown) {
  const number = Number(ref)
  const element = context.observation.elements.find((item) => item.ref === number)
  return element ?? null
}

/* ----------------------------------------------------------------- execution */

export async function runTool(
  context: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const { page } = context

  switch (name) {
    case 'click': {
      const element = elementFor(context, args.ref)
      if (!element) return { ok: false, message: `No element numbered ${String(args.ref)}.` }
      if (context.dryRun && element.submits) {
        return {
          ok: false,
          message:
            'This is a submit control and this is a dry run. Fill the form and call done; do not submit.',
        }
      }
      await page.click(refSelector(element.ref), { timeout: 15_000 })
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined)
      if (!hostAllowed(page.url(), context.allowedDomains)) {
        // Following a link off-site is how an agent ends up somewhere nobody
        // reviewed. Go back rather than continue.
        await page.goBack({ timeout: 15_000 }).catch(() => undefined)
        return { ok: false, message: 'That led off this site. Went back.' }
      }
      return { ok: true, message: `Clicked "${element.label}".` }
    }

    case 'fill': {
      const element = elementFor(context, args.ref)
      if (!element) return { ok: false, message: `No element numbered ${String(args.ref)}.` }
      if (sensitiveReason(element.label)) {
        return {
          ok: false,
          message: `"${element.label}" is a question this system never answers on someone's behalf. Leave it blank and list it in "blocked".`,
        }
      }
      await page.fill(refSelector(element.ref), String(args.value ?? ''), { timeout: 15_000 })
      return { ok: true, message: `Filled "${element.label}".` }
    }

    case 'select': {
      const element = elementFor(context, args.ref)
      if (!element) return { ok: false, message: `No element numbered ${String(args.ref)}.` }
      if (sensitiveReason(element.label)) {
        return {
          ok: false,
          message: `"${element.label}" is a question this system never answers on someone's behalf. Leave it and list it in "blocked".`,
        }
      }
      await page.selectOption(refSelector(element.ref), { label: String(args.option ?? '') }, { timeout: 15_000 })
      return { ok: true, message: `Selected "${String(args.option)}" for "${element.label}".` }
    }

    case 'upload': {
      const element = elementFor(context, args.ref)
      if (!element) return { ok: false, message: `No element numbered ${String(args.ref)}.` }
      const path = context.files[String(args.name ?? '').toLowerCase()]
      if (!path) {
        return {
          ok: false,
          message: `No prepared file called "${String(args.name)}". Available: ${Object.keys(context.files).join(', ') || 'none'}.`,
        }
      }
      await page.setInputFiles(refSelector(element.ref), path, { timeout: 20_000 })
      return { ok: true, message: `Attached ${String(args.name)} to "${element.label}".` }
    }

    case 'goto': {
      const url = normaliseHttpUrl(String(args.url ?? ''))
      if (!hostAllowed(url, context.allowedDomains)) {
        return {
          ok: false,
          message: `Not allowed to leave this site. Permitted: ${context.allowedDomains.join(', ')}.`,
        }
      }
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      return { ok: true, message: `Opened ${url}.` }
    }

    case 'scroll': {
      const down = String(args.direction ?? 'down') !== 'up'
      await page.mouse.wheel(0, down ? 700 : -700)
      await page.waitForTimeout(400)
      return { ok: true, message: `Scrolled ${down ? 'down' : 'up'}.` }
    }

    case 'screenshot':
      // Handled by the loop, which has to attach the image to the next
      // message rather than describe it in a tool result.
      return { ok: true, message: 'Taking a picture of the page.' }

    case 'submit': {
      if (context.dryRun) {
        return { ok: false, message: 'This is a dry run. Nothing is submitted. Call done instead.' }
      }
      const element = elementFor(context, args.ref)
      if (!element) return { ok: false, message: `No element numbered ${String(args.ref)}.` }
      await page.click(refSelector(element.ref), { timeout: 20_000 })
      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined)
      return { ok: true, message: `Submitted via "${element.label}".` }
    }

    case 'ask': {
      const question = String(args.question ?? '').trim()
      if (!question) return { ok: false, message: 'Ask an actual question.' }
      if (!context.onAsk) {
        return {
          ok: false,
          message: 'Nobody is watching this run. Leave the field blank and report it in "blocked".',
        }
      }
      // A refusal must not be routed around by asking the user to supply the
      // answer instead. The list is the list.
      if (sensitiveReason(question)) {
        return {
          ok: false,
          message:
            'That is a question this system never answers, however it is asked. Leave it blank and report it in "blocked".',
        }
      }
      const answer = await context.onAsk(question)
      return answer
        ? { ok: true, message: `They said: ${answer}` }
        : {
            ok: false,
            message: 'Nobody answered. Leave the field blank and report it in "blocked".',
          }
    }

    case 'done': {
      const asArray = (value: unknown): string[] =>
        Array.isArray(value) ? value.map((item) => String(item)) : []
      return {
        ok: true,
        message: 'Finished.',
        finished: {
          reachedForm: Boolean(args.reachedForm),
          submitted: Boolean(args.submitted) && !context.dryRun,
          filled: asArray(args.filled),
          blocked: asArray(args.blocked),
          note: String(args.note ?? ''),
        },
      }
    }

    default:
      logger.debug({ name }, 'agent called an unknown tool')
      return { ok: false, message: `There is no tool called "${name}".` }
  }
}
