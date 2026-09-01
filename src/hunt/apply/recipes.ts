import type { Page } from 'playwright-core'
import type { FormField } from './fields.js'

/**
 * Reading a form, and the per-portal knowledge that makes it reliable.
 *
 * Generic heuristics get an application most of the way on most forms and then
 * fail on the last field, which is the same as failing entirely. The three
 * platforms below carry the majority of engineering applications and have
 * stable, documented markup — so they get real recipes, and that is where
 * submission success actually comes from.
 *
 * Everything else falls back to the generic reader, which is still better than
 * what existed before.
 */

export interface Recipe {
  id: string
  /** Hosts this recipe applies to. */
  matches: (host: string) => boolean
  /** Where the apply form lives, when it is behind a button. */
  openForm?: (page: Page) => Promise<void>
  /** Selector for the field containers, so labels pair with inputs correctly. */
  fieldContainer: string
  /** The control that submits. Never clicked in dry-run mode. */
  submit: string
  /** Text that means it worked. */
  success: RegExp
}

/**
 * The generic reader.
 *
 * Runs in the page so it can walk the DOM once rather than round-tripping per
 * element. Pairs each control with its label the way a person would: an
 * explicit `for=`, then a wrapping label, then `aria-label`, then the nearest
 * preceding text.
 */
export async function readFields(page: Page, containerSelector?: string): Promise<FormField[]> {
  // Written as one flat loop with no inner function declarations on purpose.
  // esbuild — which `tsx` uses in development — injects a `__name` helper for
  // named function expressions, and that helper does not exist inside the
  // page. The result is `ReferenceError: __name is not defined` in dev and
  // silence under `tsc`, which is the worst kind of difference to debug.
  return page.evaluate((selector) => {
    const scope: ParentNode = selector ? (document.querySelector(selector) ?? document) : document
    const controls = Array.from(scope.querySelectorAll<HTMLElement>('input, select, textarea'))
    const found: Array<{
      label: string
      type: string
      name?: string
      required: boolean
      options?: string[]
    }> = []

    for (const element of controls) {
      const input = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      const type = (input as HTMLInputElement).type || input.tagName.toLowerCase()
      if (type === 'hidden' || input.disabled) continue

      // Pair the control with its label the way a person would: an explicit
      // `for=`, then a wrapping label, then aria, then nearby text.
      let label = ''
      const id = element.getAttribute('id')
      if (id) {
        const explicit = document.querySelector(`label[for="${CSS.escape(id)}"]`)
        if (explicit && explicit.textContent && explicit.textContent.trim()) {
          label = explicit.textContent.trim()
        }
      }
      if (!label) {
        const wrapping = element.closest('label')
        if (wrapping && wrapping.textContent && wrapping.textContent.trim()) {
          label = wrapping.textContent.trim()
        }
      }
      if (!label) {
        const aria = element.getAttribute('aria-label')
        if (aria && aria.trim()) label = aria.trim()
      }
      if (!label) {
        const labelledBy = element.getAttribute('aria-labelledby')
        if (labelledBy) {
          const target = document.getElementById(labelledBy)
          if (target && target.textContent && target.textContent.trim()) {
            label = target.textContent.trim()
          }
        }
      }
      if (!label) {
        const container = element.closest('div, fieldset, li, section')
        const text = container
          ? container.querySelector('label, legend, .label, [class*="label"]')
          : null
        if (text && text.textContent && text.textContent.trim()) label = text.textContent.trim()
      }
      if (!label) {
        const placeholder = element.getAttribute('placeholder')
        label = (placeholder && placeholder.trim()) || element.getAttribute('name') || ''
      }
      if (!label) continue

      let options: string[] | undefined
      if (input instanceof HTMLSelectElement) {
        options = []
        for (const option of Array.from(input.options)) {
          options.push(option.label || option.value)
        }
      }

      const name = input.getAttribute('name') ?? undefined

      // Radio and checkbox groups are one question, not one question per
      // option. Read individually, a Lever ethnicity question arrives as
      // nineteen fields labelled "White: Irish", "Asian/Asian British:
      // Indian" — none of which look demographic on their own, which is
      // exactly how a demographic question slips past a refusal list.
      if ((type === 'radio' || type === 'checkbox') && name) {
        const existing = found.find((entry) => entry.name === name && entry.type === type)
        if (existing) {
          existing.options = existing.options ?? []
          existing.options.push(label.replace(/\s+/g, ' ').slice(0, 120))
          continue
        }
        // Prefer the group's own question — a fieldset legend or the
        // application-question wrapper — over the first option's label.
        const group = element.closest('fieldset, .application-question, [role="radiogroup"], .field')
        const legend = group
          ? group.querySelector('legend, .application-label, label:not([for]), .text')
          : null
        const groupLabel =
          legend && legend.textContent && legend.textContent.trim()
            ? legend.textContent.trim()
            : label
        found.push({
          label: groupLabel.replace(/\s+/g, ' ').slice(0, 200),
          type,
          name,
          required: input.required || element.getAttribute('aria-required') === 'true',
          options: [label.replace(/\s+/g, ' ').slice(0, 120)],
        })
        continue
      }

      found.push({
        label: label.replace(/\s+/g, ' ').slice(0, 200),
        type,
        name,
        required: input.required || element.getAttribute('aria-required') === 'true',
        options,
      })
    }

    return found
  }, containerSelector ?? null)
}

/**
 * Greenhouse. The most common destination by a wide margin, and the most
 * stable markup — the form is server-rendered and the ids have not moved in
 * years.
 */
const greenhouse: Recipe = {
  id: 'greenhouse',
  matches: (host) => host.includes('greenhouse.io') || host.includes('boards.greenhouse.io'),
  fieldContainer: '#application_form, form#application-form, form',
  submit: '#submit_app, input[type="submit"], button[type="submit"]',
  success: /thank you|application (?:was )?submitted|received your application/i,
}

/** Lever. Also server-rendered; the apply form sits behind an "Apply" link. */
const lever: Recipe = {
  id: 'lever',
  matches: (host) => host.includes('lever.co'),
  async openForm(page) {
    const apply = page.getByRole('link', { name: /apply for this job|apply/i }).first()
    if ((await apply.count()) > 0 && (await apply.isVisible())) {
      await apply.click()
      await page.waitForLoadState('domcontentloaded').catch(() => undefined)
    }
  },
  fieldContainer: '.application-form, form[action*="apply"], form',
  submit: 'button[type="submit"], .postings-btn[type="submit"]',
  success: /thank you|application (?:was )?submitted|we have received/i,
}

/**
 * Ashby. A React application, so the form appears after hydration rather than
 * in the initial HTML — reading fields too early returns an empty list, which
 * looks exactly like a form with no fields.
 */
const ashby: Recipe = {
  id: 'ashby',
  matches: (host) => host.includes('ashbyhq.com'),
  async openForm(page) {
    // "Apply for this Job" is an anchor, not a button, and the form lives on
    // its own route — the job page itself renders zero inputs, so looking for
    // a button here found nothing and the reader saw an empty form.
    const apply = page
      .getByRole('link', { name: /apply for this job|apply/i })
      .or(page.getByRole('button', { name: /apply for this job|apply/i }))
      .first()
    if ((await apply.count()) > 0 && (await apply.isVisible().catch(() => false))) {
      await apply.click().catch(() => undefined)
    } else if (!page.url().includes('/application')) {
      // Ashby also serves the form directly at /application.
      await page.goto(`${page.url().replace(/\/$/, '')}/application`, {
        waitUntil: 'domcontentloaded',
        timeout: 20_000,
      }).catch(() => undefined)
    }
    // Wait for a real input rather than a fixed delay — this is a React app,
    // so the markup arrives after hydration.
    await page
      .waitForSelector('form input, form textarea, input[type="file"]', { timeout: 15_000 })
      .catch(() => undefined)
  },
  fieldContainer: 'form',
  submit: 'button[type="submit"]',
  success: /thank you|submitted|received/i,
}

const RECIPES: Recipe[] = [greenhouse, lever, ashby]

export function recipeFor(url: string): Recipe | null {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return RECIPES.find((recipe) => recipe.matches(host)) ?? null
  } catch {
    return null
  }
}

/** Generic fallback for every other portal. */
export const GENERIC: Omit<Recipe, 'id' | 'matches'> = {
  fieldContainer: 'form',
  submit:
    'button[type="submit"], input[type="submit"], button:has-text("Submit application"), button:has-text("Submit")',
  success: /thank you|application (?:was )?submitted|successfully applied|we have received/i,
}
