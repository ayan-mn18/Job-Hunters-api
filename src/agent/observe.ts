import type { Page } from 'playwright-core'

/**
 * What the model is allowed to see.
 *
 * The expensive way to drive a browser with a model is to send it a screenshot
 * every step. A 1280×900 PNG is thousands of tokens, it has to be re-sent as
 * the conversation grows, and almost none of it is information — a form is a
 * list of labelled fields, and that list is a few hundred tokens of text.
 *
 * So the default observation is text: every interactive element, numbered,
 * with the label a person would read. Numbering is done by stamping the DOM
 * (`data-huntly-ref`) rather than by remembering a selector, because between
 * observing and acting the page may have re-rendered and a CSS path built from
 * the old tree would point at nothing, or worse, at something else.
 *
 * A screenshot is available and is used sparingly — see `needsPicture`.
 */

const REF_ATTRIBUTE = 'data-huntly-ref'

export type ElementKind =
  | 'text'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'file'
  | 'button'
  | 'link'

export interface ObservedElement {
  ref: number
  kind: ElementKind
  /** The label a person would read: <label>, aria-label, placeholder, text. */
  label: string
  value: string
  required: boolean
  /** Choices, for a select or a radio group. Capped — some are enormous. */
  options?: string[]
  /** True for the controls that finish an application rather than advance it. */
  submits: boolean
}

export interface Observation {
  url: string
  title: string
  /** Visible headings, which is usually what identifies the step of a flow. */
  headings: string[]
  /** Validation messages and banners — the reason a step did not work. */
  notices: string[]
  elements: ObservedElement[]
}

/**
 * Controls that end an application rather than move it along.
 *
 * Deliberately narrow, and it took a live form to get it right. A first version
 * included "apply" and "apply now", which on a Greenhouse posting marked the
 * button that merely scrolls down to the form — so in a dry run the agent was
 * refused the one click it needed to reach the form at all. A word list alone
 * cannot tell those apart; being inside a `<form>` is what can.
 */
const SUBMIT_WORDS =
  /^(submit|submit application|submit your application|send application|finish|complete application|confirm and submit)$/i

/**
 * Reads the page.
 *
 * All of it runs in one `evaluate` rather than a locator per element: a form
 * with sixty fields is sixty round trips otherwise, and each one is a chance
 * for the page to change underneath us mid-read.
 */
export async function observe(page: Page, limit = 120): Promise<Observation> {
  const data = await page.evaluate(
    ({ refAttribute, maxElements, submitPattern }) => {
      const submitRe = new RegExp(submitPattern, 'i')
      const selector = [
        'input:not([type="hidden"])',
        'textarea',
        'select',
        'button',
        'a[href]',
        '[role="button"]',
        '[role="textbox"]',
        '[role="combobox"]',
        '[contenteditable="true"]',
      ].join(',')

      // Stale refs from an earlier observation would make an old number point
      // at a new element, so the slate is wiped before every read.
      for (const stale of Array.from(document.querySelectorAll(`[${refAttribute}]`))) {
        stale.removeAttribute(refAttribute)
      }

      const elements: Array<{
        ref: number
        kind: string
        label: string
        value: string
        required: boolean
        options?: string[]
        submits: boolean
      }> = []

      let ref = 0
      for (const node of Array.from(document.querySelectorAll(selector))) {
        if (elements.length >= maxElements) break

        const html = node as HTMLElement
        const box = html.getBoundingClientRect()
        if (box.width === 0 && box.height === 0) continue
        const style = window.getComputedStyle(html)
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue
        if (html.hasAttribute('disabled')) continue

        const tag = html.tagName.toLowerCase()
        const type = (html.getAttribute('type') ?? '').toLowerCase()

        let kind = 'button'
        if (tag === 'textarea' || html.getAttribute('contenteditable') === 'true') kind = 'textarea'
        else if (tag === 'select') kind = 'select'
        else if (tag === 'a') kind = 'link'
        else if (tag === 'input') {
          if (type === 'checkbox') kind = 'checkbox'
          else if (type === 'radio') kind = 'radio'
          else if (type === 'file') kind = 'file'
          else if (type === 'submit' || type === 'button') kind = 'button'
          else kind = 'text'
        } else if (html.getAttribute('role') === 'combobox') kind = 'select'
        else if (html.getAttribute('role') === 'textbox') kind = 'textarea'

        // The label a person would read, in the order a person would find it.
        // Written inline rather than as a helper: esbuild (which `tsx` uses in
        // development) injects a `__name` shim for inner function
        // declarations, and that shim does not exist inside the page —
        // `ReferenceError: __name is not defined`, in dev only.
        let label = ''
        const aria = html.getAttribute('aria-label')
        if (aria && aria.trim()) label = aria.trim()

        if (!label) {
          const labelledBy = html.getAttribute('aria-labelledby')
          if (labelledBy) {
            const parts: string[] = []
            for (const id of labelledBy.split(/\s+/)) {
              const referenced = document.getElementById(id)
              const inner = referenced?.innerText?.trim()
              if (inner) parts.push(inner)
            }
            if (parts.length) label = parts.join(' ')
          }
        }

        if (!label) {
          const id = html.getAttribute('id')
          if (id) {
            const explicit = document.querySelector(`label[for="${CSS.escape(id)}"]`) as HTMLElement | null
            const inner = explicit?.innerText?.trim()
            if (inner) label = inner
          }
        }

        if (!label) {
          const wrapping = html.closest('label') as HTMLElement | null
          const inner = wrapping?.innerText?.trim()
          if (inner) label = inner
        }

        if (!label) {
          const placeholder = html.getAttribute('placeholder')
          if (placeholder && placeholder.trim()) label = placeholder.trim()
        }

        // A button or a link says what it is. An input that reaches here does
        // not, and the nearest preceding text is what a person reads as the
        // question.
        if (!label) {
          const own = html.innerText?.trim()
          if (own) label = own.slice(0, 120)
        }

        if (!label) {
          const previous = html.previousElementSibling as HTMLElement | null
          const inner = previous?.innerText?.trim()
          if (inner) label = inner.slice(0, 120)
        }

        if (!label) label = html.getAttribute('name') ?? ''

        label = label.replace(/\s+/g, ' ').slice(0, 160)
        if (!label && kind !== 'file') continue

        ref += 1
        html.setAttribute(refAttribute, String(ref))

        let value = ''
        if (tag === 'select') value = (html as HTMLSelectElement).selectedOptions[0]?.text ?? ''
        else if (kind === 'checkbox' || kind === 'radio') value = String((html as HTMLInputElement).checked)
        else value = (html as HTMLInputElement).value ?? html.innerText ?? ''

        const entry: (typeof elements)[number] = {
          ref,
          kind,
          label,
          value: String(value).slice(0, 120),
          required: html.hasAttribute('required') || html.getAttribute('aria-required') === 'true',
          // A real submit control is one the browser itself would submit with,
          // or a button inside a form whose label says so. Anything outside a
          // form navigates, however it is labelled.
          submits:
            type === 'submit' ||
            (kind === 'button' && Boolean(html.closest('form')) && submitRe.test(label)),
        }

        if (tag === 'select') {
          const options: string[] = []
          for (const option of Array.from((html as HTMLSelectElement).options).slice(0, 40)) {
            const optionText = option.text.trim()
            if (optionText) options.push(optionText)
          }
          entry.options = options
        }

        elements.push(entry)
      }

      const headings: string[] = []
      for (const node of Array.from(document.querySelectorAll('h1,h2,h3'))) {
        if (headings.length >= 12) break
        const html = node as HTMLElement
        const box = html.getBoundingClientRect()
        if (box.width === 0 && box.height === 0) continue
        const heading = html.innerText.trim().replace(/\s+/g, ' ').slice(0, 120)
        if (heading) headings.push(heading)
      }

      const notices: string[] = []
      const noticeSelector =
        '[role="alert"], .error, .field-error, [aria-invalid="true"], [class*="error"]'
      for (const node of Array.from(document.querySelectorAll(noticeSelector))) {
        if (notices.length >= 8) break
        const html = node as HTMLElement
        const box = html.getBoundingClientRect()
        if (box.width === 0 && box.height === 0) continue
        const notice = html.innerText.trim().replace(/\s+/g, ' ').slice(0, 200)
        if (notice) notices.push(notice)
      }

      return { url: location.href, title: document.title, headings, notices, elements }
    },
    { refAttribute: REF_ATTRIBUTE, maxElements: limit, submitPattern: SUBMIT_WORDS.source },
  )

  return data as Observation
}

/** The selector an action uses. Valid only until the next `observe`. */
export function refSelector(ref: number): string {
  return `[${REF_ATTRIBUTE}="${ref}"]`
}

/**
 * When text is not enough.
 *
 * A screenshot is worth its tokens in exactly two situations: the page offered
 * nothing to interact with (so either it is still loading or it is a canvas or
 * an image-based flow), or the last action changed nothing, which usually
 * means the thing that was clicked was not the thing that was seen.
 */
export function needsPicture(observation: Observation, lastActionChangedNothing: boolean): boolean {
  return observation.elements.length === 0 || lastActionChangedNothing
}

/** The observation as the model sees it. Compact on purpose. */
export function renderObservation(observation: Observation): string {
  const lines: string[] = [
    `URL: ${observation.url}`,
    `Title: ${observation.title}`,
  ]
  if (observation.headings.length) lines.push(`Headings: ${observation.headings.join(' | ')}`)
  if (observation.notices.length) lines.push(`Notices: ${observation.notices.join(' | ')}`)

  lines.push('', 'Interactive elements:')
  if (observation.elements.length === 0) {
    lines.push('  (none found — the page may still be loading)')
  }
  for (const element of observation.elements) {
    const parts = [`[${element.ref}] ${element.kind}`, `"${element.label}"`]
    if (element.required) parts.push('required')
    if (element.value) parts.push(`current="${element.value}"`)
    if (element.options?.length) parts.push(`options=${element.options.join('/')}`)
    if (element.submits) parts.push('SUBMITS')
    lines.push(`  ${parts.join(' ')}`)
  }
  return lines.join('\n')
}
