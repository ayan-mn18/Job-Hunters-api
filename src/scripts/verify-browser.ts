import { getBrowser } from '../browser/client.js'
import { openSession } from '../browser/session.js'
import { closeDatabase } from '../db/client.js'
import { browserProvider } from '../config/env.js'

/**
 * Proves the browser lane end to end, and that it cleans up after itself.
 *
 * The second half matters more than the first. A hosted browser is not stopped
 * by disconnecting from it — it keeps running, and keeps billing, until its own
 * timeout expires. A leak here is invisible until the invoice arrives, so this
 * checks the session actually reaches `stopped`.
 */

const target = process.argv[2] ?? 'https://www.workatastartup.com/jobs'

console.log(`provider: ${browserProvider}`)

const session = await openSession({ userId: null, label: 'verify', timeoutMinutes: 5 })
console.log(`session:  ${session.sessionId ?? '(local)'}`)
console.log(`live:     ${session.liveUrl ?? '(no live view on the local provider)'}`)

try {
  await session.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  const title = await session.page.title()
  const text = (await session.page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 160)
  console.log(`title:    ${title}`)
  console.log(`body:     ${text}`)
  if (!title) throw new Error('The page loaded but has no title — something is wrong.')
} finally {
  await session.close()
}

if (session.sessionId) {
  const info = await getBrowser(session.sessionId)
  console.log(`stopped:  ${info.status} (browser $${info.browserCost ?? 0}, proxy $${info.proxyCost ?? 0})`)
  if (info.status !== 'stopped') {
    console.error('The session did not stop. It will bill until its timeout.')
    process.exit(1)
  }
}

console.log('\nBrowser lane verified.')

// Model calls meter into Postgres, and the pool keeps the process alive long
// after the work is done. Close it, or this script never exits.
await closeDatabase()
