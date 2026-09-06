import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Page } from 'playwright-core'
import { runTool, toolsFor, type ToolContext } from './tools.js'
import type { Observation, ObservedElement } from './observe.js'

/**
 * These are the rules that cannot live in a prompt.
 *
 * Every case here is something a confused or coaxed model will eventually try,
 * and the test is that the executor refuses it on the arguments it was given
 * rather than relying on having asked nicely in a system message.
 */

interface Calls {
  clicked: string[]
  filled: Array<[string, string]>
  navigated: string[]
  wentBack: number
}

function stubPage(url = 'https://example.com/apply'): { page: Page; calls: Calls } {
  const calls: Calls = { clicked: [], filled: [], navigated: [], wentBack: 0 }
  let current = url
  const page = {
    url: () => current,
    click: async (selector: string) => {
      calls.clicked.push(selector)
    },
    fill: async (selector: string, value: string) => {
      calls.filled.push([selector, value])
    },
    selectOption: async () => undefined,
    setInputFiles: async () => undefined,
    goto: async (target: string) => {
      calls.navigated.push(target)
      current = target
    },
    goBack: async () => {
      calls.wentBack += 1
    },
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
    mouse: { wheel: async () => undefined },
  } as unknown as Page
  return { page, calls }
}

function element(overrides: Partial<ObservedElement> & { ref: number }): ObservedElement {
  return {
    kind: 'text',
    label: 'Full name',
    value: '',
    required: false,
    submits: false,
    ...overrides,
  }
}

function contextWith(elements: ObservedElement[], dryRun: boolean, page: Page): ToolContext {
  const observation: Observation = {
    url: page.url(),
    title: 'Apply',
    headings: [],
    notices: [],
    elements,
  }
  return {
    page,
    allowedDomains: ['example.com'],
    dryRun,
    files: { resume: '/tmp/resume.pdf' },
    observation,
  }
}

describe('agent tools', () => {
  it('does not offer a submit tool in a dry run', () => {
    const names = (tools: unknown[]) =>
      tools.map((tool) => (tool as { function: { name: string } }).function.name)
    assert.ok(!names(toolsFor(true)).includes('submit'))
    assert.ok(names(toolsFor(false)).includes('submit'))
  })

  it('refuses submit even when the model invents the tool in a dry run', async () => {
    const { page, calls } = stubPage()
    const context = contextWith([element({ ref: 1, kind: 'button', label: 'Submit', submits: true })], true, page)
    const result = await runTool(context, 'submit', { ref: 1 })
    assert.equal(result.ok, false)
    assert.equal(calls.clicked.length, 0)
  })

  it('refuses to click a submit control in a dry run', async () => {
    const { page, calls } = stubPage()
    const context = contextWith(
      [element({ ref: 1, kind: 'button', label: 'Submit application', submits: true })],
      true,
      page,
    )
    const result = await runTool(context, 'click', { ref: 1, why: 'finish' })
    assert.equal(result.ok, false)
    assert.match(result.message, /dry run/i)
    assert.equal(calls.clicked.length, 0)
  })

  it('refuses to answer a question on the never-auto list', async () => {
    const { page, calls } = stubPage()
    const context = contextWith(
      [element({ ref: 4, label: 'Do you require visa sponsorship?' })],
      true,
      page,
    )
    const result = await runTool(context, 'fill', { ref: 4, value: 'No' })
    assert.equal(result.ok, false)
    assert.equal(calls.filled.length, 0)
  })

  it('fills an ordinary field', async () => {
    const { page, calls } = stubPage()
    const context = contextWith([element({ ref: 2, label: 'Full name' })], true, page)
    const result = await runTool(context, 'fill', { ref: 2, value: 'Ada Lovelace' })
    assert.equal(result.ok, true)
    assert.deepEqual(calls.filled, [['[data-huntly-ref="2"]', 'Ada Lovelace']])
  })

  it('refuses to navigate off the allowed domains', async () => {
    const { page, calls } = stubPage()
    const context = contextWith([], true, page)
    const result = await runTool(context, 'goto', { url: 'https://evil.test/steal' })
    assert.equal(result.ok, false)
    assert.equal(calls.navigated.length, 0)
  })

  it('allows navigation within an allowed domain, including subdomains', async () => {
    const { page, calls } = stubPage()
    const context = contextWith([], true, page)
    const result = await runTool(context, 'goto', { url: 'https://jobs.example.com/apply/2' })
    assert.equal(result.ok, true)
    assert.deepEqual(calls.navigated, ['https://jobs.example.com/apply/2'])
  })

  it('repairs a missing URL scheme before navigating', async () => {
    const { page, calls } = stubPage()
    const context = contextWith([], true, page)
    const result = await runTool(context, 'goto', { url: 'jobs.example.com/apply/2' })
    assert.equal(result.ok, true)
    assert.deepEqual(calls.navigated, ['https://jobs.example.com/apply/2'])
  })

  it('goes back when a click leads off the allowed domains', async () => {
    const { page, calls } = stubPage()
    const context = contextWith([element({ ref: 1, kind: 'link', label: 'Sponsored' })], true, page)
    // The stub click does not navigate, so point the page off-site first to
    // stand in for a link that did.
    await page.goto('https://elsewhere.test/landing')
    const result = await runTool(context, 'click', { ref: 1, why: 'looked relevant' })
    assert.equal(result.ok, false)
    assert.equal(calls.wentBack, 1)
  })

  it('refers to a prepared file by keyword, never by path', async () => {
    const { page } = stubPage()
    const context = contextWith([element({ ref: 3, kind: 'file', label: 'Resume' })], true, page)
    assert.equal((await runTool(context, 'upload', { ref: 3, name: 'resume' })).ok, true)
    assert.equal((await runTool(context, 'upload', { ref: 3, name: '/etc/passwd' })).ok, false)
  })

  it('rejects an element number that is not in the current observation', async () => {
    const { page } = stubPage()
    const context = contextWith([element({ ref: 1 })], true, page)
    assert.equal((await runTool(context, 'click', { ref: 99, why: 'guess' })).ok, false)
  })

  it('never reports a submission from a dry run, whatever the agent claims', async () => {
    const { page } = stubPage()
    const context = contextWith([], true, page)
    const result = await runTool(context, 'done', {
      reachedForm: true,
      submitted: true,
      filled: ['Full name'],
      blocked: [],
      note: 'sent it',
    })
    assert.equal(result.finished?.submitted, false)
  })
})

/**
 * The dry-run guard has to hold at the point of the click, not at the point
 * some other process decided this run was live. A live run reaching a runner
 * configured for dry runs must stay dry.
 */
describe('submit guard', () => {
  it('refuses to submit when the run itself is a dry run', async () => {
    const { page, calls } = stubPage()
    const context = contextWith(
      [element({ ref: 1, kind: 'button', label: 'Submit application', submits: true })],
      true,
      page,
    )
    const result = await runTool(context, 'submit', { ref: 1 })
    assert.equal(result.ok, false)
    assert.equal(calls.clicked.length, 0)
  })
})
