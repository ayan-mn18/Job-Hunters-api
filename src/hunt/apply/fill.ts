import type { Page } from 'playwright-core'
import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import type { PortalProfile } from '../portal-profile.js'
import { publishAttemptEvent } from './events.js'
import { normaliseLabel, resolveField, type FormField, type Rung } from './fields.js'
import { GENERIC, readFields, recipeFor, type Recipe } from './recipes.js'
import type { BlockedReason } from './state.js'

/**
 * Filling one application form.
 *
 * Separated from the surrounding bookkeeping so it can be reasoned about — and
 * tested — on its own: given a page and a profile, what got filled, what did
 * not, and is there anything a human has to deal with.
 */

export interface FilledField {
  label: string
  via: Rung
  filled: boolean
}

export interface FillResult {
  fields: FilledField[]
  /** Required fields nobody could answer. Non-empty means blocked. */
  unresolved: Array<{ label: string; type: string; why: BlockedReason }>
  recipe: string
}

/**
 * Escapes a value for use inside an attribute selector.
 *
 * `CSS.escape` lives here in Node, not the browser, so calling it threw
 * "CSS is not defined" and broke every Lever application outright — the
 * platform whose forms name their controls rather than labelling them.
 * Only the quote and the backslash can break out of `[name="..."]`.
 */
function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Locates a control by its label, the way the reader paired them. */
function controlFor(page: Page, field: FormField) {
  // Match on the normalised label, not the raw one. The DOM label carries the
  // required marker ("First Name*") because it comes from a sibling span, but
  // the *accessible* name usually does not — so a regex built from the raw
  // text matched nothing and the candidate's own name went unfilled.
  const escaped = normaliseLabel(field.label)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .slice(0, 60)
  const byLabel = page.getByLabel(new RegExp(escaped, 'i')).first()
  if (field.name) {
    return byLabel.or(page.locator(`[name="${escapeAttributeValue(field.name)}"]`).first())
  }
  return byLabel
}

async function setValue(page: Page, field: FormField, value: string): Promise<boolean> {
  const control = controlFor(page, field)
  if ((await control.count()) === 0) return false
  if (!(await control.isVisible().catch(() => false))) return false

  try {
    if (field.type === 'select-one' || field.type === 'select') {
      // Try the label first, then the value — forms disagree about which the
      // visible text corresponds to.
      await control.selectOption({ label: value }).catch(async () => {
        await control.selectOption(value)
      })
      return true
    }
    if (field.type === 'checkbox' || field.type === 'radio') {
      await control.check()
      return true
    }
    await control.fill(value)
    return true
  } catch (error) {
    logger.debug({ err: error, label: field.label }, 'could not set a field')
    return false
  }
}

/** Attaches the résumé to whichever file input is asking for one. */
async function attachResume(page: Page, resumePath: string): Promise<boolean> {
  const inputs = page.locator('input[type="file"]')
  const count = await inputs.count()
  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index)
    const name = `${(await input.getAttribute('name')) ?? ''} ${(await input.getAttribute('id')) ?? ''}`
    const accept = (await input.getAttribute('accept')) ?? ''
    // A single file input on an application form is the résumé. With several,
    // only take the one that says so — the others are cover letters and
    // portfolios, and attaching a CV to those looks careless.
    if (/resume|cv/i.test(name) || /pdf|document|word/i.test(accept) || count === 1) {
      await input.setInputFiles(resumePath).catch(() => undefined)
      return true
    }
  }
  return false
}

export async function fillForm(params: {
  page: Page
  url: string
  userId: string
  attemptId: string
  profile: PortalProfile
  resumePath: string
}): Promise<FillResult> {
  const { page, url, userId, attemptId, profile, resumePath } = params

  const recipe: Recipe | null = recipeFor(url)
  const plan = recipe ?? { ...GENERIC, id: 'generic', matches: () => true }

  if (recipe?.openForm) await recipe.openForm(page)

  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase()
    } catch {
      return 'unknown'
    }
  })()

  const fields = await readFields(page, plan.fieldContainer).catch(() => [] as FormField[])
  const filled: FilledField[] = []
  const unresolved: FillResult['unresolved'] = []

  for (const field of fields) {
    if (field.type === 'file') continue

    const resolved = await resolveField(field, { userId, host, profile })

    if (resolved.blocked) {
      // Only required fields stop an application. An optional question we
      // cannot answer is one we simply leave blank, as a person would.
      if (field.required) {
        unresolved.push({ label: field.label, type: field.type, why: resolved.blocked })
      }
      filled.push({ label: field.label, via: 'skipped', filled: false })
      publishAttemptEvent(userId, {
        type: 'field',
        attemptId,
        label: field.label,
        via: 'skipped',
        filled: false,
      })
      continue
    }

    const ok = resolved.value ? await setValue(page, field, resolved.value) : false
    if (!ok && field.required) {
      unresolved.push({ label: field.label, type: field.type, why: 'needs_input' })
    }

    filled.push({ label: field.label, via: resolved.via, filled: ok })
    // The label and how it was resolved, never the value — a form field can
    // hold a phone number, and this goes over a socket.
    publishAttemptEvent(userId, {
      type: 'field',
      attemptId,
      label: field.label,
      via: resolved.via,
      filled: ok,
    })
  }

  await attachResume(page, resumePath)

  return { fields: filled, unresolved, recipe: plan.id }
}

/**
 * A posting that has been taken down since it was scraped.
 *
 * Found by the first live dry run: a stored Ashby job answered with "Job not
 * found", the runtime reported `no_submit_control`, and the user would have
 * seen a confusing failure. It is not a failure — the job is simply gone, and
 * it should cost neither a slot in the daily budget nor a place in the review
 * queue.
 */
const POSTING_GONE =
  /\bjob\s+not\s+found\b|\bposition\s+(?:is\s+)?(?:no\s+longer|has\s+been)\s+(?:available|filled|closed)\b|\bno\s+longer\s+accepting\s+applications\b|\bthis\s+job\s+(?:posting\s+)?(?:is\s+)?(?:closed|expired)\b|\bposting\s+(?:is\s+)?closed\b/i

/** True when the page says the posting is gone rather than showing a form. */
export async function postingIsClosed(page: Page): Promise<boolean> {
  const body = await page.locator('body').innerText().catch(() => '')
  // Only trust it on a page with no form at all: a live posting can mention
  // "no longer accepting applications" about some *other* role in a sidebar.
  if (!POSTING_GONE.test(body)) return false
  const inputs = await page.locator('input:not([type="hidden"]), textarea, select').count().catch(() => 0)
  return inputs === 0
}

export interface SubmitResult {
  submitted: boolean
  /** Set when we deliberately did not submit. */
  heldBack?: 'dry_run' | 'kill_switch' | 'no_submit_control' | 'posting_closed'
  confirmation?: string
}

/** Whether the current recipe can see a usable submit control. */
export async function hasSubmitControl(params: { page: Page; url: string }): Promise<boolean> {
  const recipe = recipeFor(params.url)
  const plan = recipe ?? { ...GENERIC, id: 'generic', matches: () => true }
  const submit = params.page.locator(plan.submit).first()
  return (await submit.count()) > 0 && (await submit.isVisible().catch(() => false))
}

/**
 * The last step, and the only irreversible one.
 *
 * Dry run is the default, and the check happens *here* rather than at the
 * caller — one place, immediately before the click, so no future code path can
 * route around it.
 */
export async function submitForm(params: {
  page: Page
  url: string
  dryRun: boolean
}): Promise<SubmitResult> {
  const { page, url, dryRun } = params
  const recipe = recipeFor(url)
  const plan = recipe ?? { ...GENERIC, id: 'generic', matches: () => true }

  if (env.APPLY_KILL_SWITCH) return { submitted: false, heldBack: 'kill_switch' }

  // Checked before looking for a submit control, so a dead posting reads as
  // "this job is gone" rather than "we could not find the button".
  if (await postingIsClosed(page)) return { submitted: false, heldBack: 'posting_closed' }

  const submit = page.locator(plan.submit).first()
  if (!(await hasSubmitControl({ page, url }))) {
    return { submitted: false, heldBack: 'no_submit_control' }
  }

  if (dryRun) return { submitted: false, heldBack: 'dry_run' }

  await submit.click()
  await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined)

  const body = await page.locator('body').innerText().catch(() => '')
  if (!plan.success.test(body)) {
    return { submitted: false, confirmation: body.slice(0, 200) }
  }
  return { submitted: true, confirmation: body.slice(0, 200) }
}
