import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { runAgent } from '../agent/loop.js'
import { observe, renderObservation } from '../agent/observe.js'
import { domainsForApplyUrl } from '../agent/apply.js'
import { getBrowser } from '../browser/client.js'
import { openSession } from '../browser/session.js'
import { closeDatabase } from '../db/client.js'

/**
 * Drives a real application form, end to end, and submits nothing.
 *
 * Everything in the new stack is exercised here at once: a hosted browser over
 * CDP, the text observer, Muse Spark choosing each step, the tool guardrails,
 * and the dry-run rule that the submit tool does not exist. It uses a synthetic
 * candidate rather than a database row so it can be run against any form
 * without setting up an account first.
 *
 *   npx tsx src/scripts/verify-agent.ts <apply-url>
 */

const applyUrl =
  process.argv[2] ?? 'https://job-boards.greenhouse.io/anthropic/jobs/4461450008'

const facts = {
  candidate: {
    fullName: 'Ada Lovelace',
    email: 'ada@example.test',
    phone: '+91 90000 00000',
    headline: 'Backend engineer',
    location: 'Bengaluru, India',
    links: { github: 'https://github.com/example', linkedin: 'https://linkedin.com/in/example' },
    skills: ['TypeScript', 'Node.js', 'PostgreSQL', 'AWS'],
    experience: [{ company: 'Example Ltd', role: 'Senior Backend Engineer', years: '2021–2026' }],
  },
  job: { title: 'the advertised role', company: 'the employer' },
}

const scratch = await mkdtemp(path.join(os.tmpdir(), 'huntly-verify-'))
const resumePath = path.join(scratch, 'resume.txt')
await writeFile(resumePath, 'Ada Lovelace — backend engineer. Synthetic file, verification only.')

const session = await openSession({ userId: null, label: 'verify-agent', timeoutMinutes: 10 })
console.log(`live: ${session.liveUrl ?? '(local)'}\n`)

try {
  await session.page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })

  const first = await observe(session.page)
  console.log(renderObservation(first).split('\n').slice(0, 24).join('\n'))
  console.log(`\n(${first.elements.length} interactive elements)\n`)

  const result = await runAgent({
    page: session.page,
    userId: null,
    goal:
      'If this page is a job listing rather than an application form, follow the apply link. '
      + 'Then fill in every field you can from the facts. Stop when the form is filled. Do not submit.',
    facts,
    allowedDomains: domainsForApplyUrl(applyUrl),
    dryRun: true,
    files: { resume: resumePath },
    maxSteps: 12,
    onStep: (step) => {
      console.log(`  ${step.index}. ${step.tool} → ${step.ok ? '' : 'REFUSED: '}${step.result}`)
    },
  })

  console.log('\n--- report ---')
  console.log(`reached form: ${result.reachedForm}   submitted: ${result.submitted}   steps: ${result.steps}`)
  console.log(`stopped because: ${result.stoppedBecause}`)
  console.log(`filled (${result.filled.length}): ${result.filled.join(', ') || '—'}`)
  console.log(`blocked (${result.blocked.length}): ${result.blocked.join(', ') || '—'}`)
  console.log(`note: ${result.note}`)

  if (result.submitted) {
    console.error('\nFAIL: a dry run reported a submission.')
    process.exitCode = 1
  }
} finally {
  await session.close()
  await rm(scratch, { recursive: true, force: true })
}

if (session.sessionId) {
  const info = await getBrowser(session.sessionId)
  console.log(`\nsession ${info.status} — browser $${info.browserCost ?? 0}, proxy $${info.proxyCost ?? 0}`)
}

// Model calls meter into Postgres, and the pool keeps the process alive long
// after the work is done. Close it, or this script never exits.
await closeDatabase()
