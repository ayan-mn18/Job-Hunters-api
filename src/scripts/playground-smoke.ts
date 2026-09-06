import { eq } from 'drizzle-orm'
import { closeDatabase, db } from '../db/client.js'
import { playgroundMessages, playgroundRuns, users } from '../db/schema.js'
import { executePlaygroundRun } from '../playground/run.js'
import { postReply } from '../playground/replies.js'
import { loadRunUnscoped } from '../playground/store.js'
import { closeRedis } from '../lib/redis.js'
import { logger } from '../lib/logger.js'

/**
 * Drives a whole playground run without the HTTP layer.
 *
 * The interesting half of this feature is what happens between the browser and
 * the person, and that is hard to see through a socket in a test. This runs the
 * engine in-process, approves the shortlist the way the UI would, prints the
 * transcript, and reports what the run ended up recording.
 *
 *   npx tsx src/scripts/playground-smoke.ts [email]
 *
 * Forces a dry run: it fills a real form on a real employer's site and stops.
 */

const email = process.argv[2] ?? 'demo@jobhunters.test'
const prompt = process.argv[3] ?? 'search the best suitable job on workatastartup.com'

const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)
if (!user) {
  console.error(`no user ${email}`)
  process.exit(1)
}

const [run] = await db
  .insert(playgroundRuns)
  .values({ userId: user.id, prompt, dryRun: true })
  .returning()
if (!run) throw new Error('could not create the run')

console.log(`run ${run.id} for ${email}\nprompt: ${prompt}\n`)

/**
 * Stands in for the user pressing Apply.
 *
 * Polls rather than subscribing because this script is the only consumer and a
 * second Redis subscription would outlive the run it was watching.
 */
const answer = process.argv[4] ?? 'done'
const approver = (async () => {
  let answered = ''
  for (let i = 0; i < 300; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const current = await loadRunUnscoped(run.id)
    if (!current) return
    if (current.status === 'shortlisted') {
      const shortlist = (current.shortlist ?? []) as Array<{ url: string; title: string }>
      const best = shortlist[0]
      console.log(`\n>>> approving: ${best?.title ?? '(none)'}\n`)
      await postReply(run.id, { kind: 'approve', text: best?.url ?? '' })
    }
    // Answer each question once. Answering the same one twice would push a
    // reply nobody is waiting for onto the list, which is exactly what the
    // kind filter exists to catch.
    if (current.status === 'blocked' && current.pendingQuestion && current.pendingQuestion !== answered) {
      answered = current.pendingQuestion
      console.log(`\n>>> asked: ${current.pendingQuestion}\n>>> answering: ${answer}\n`)
      await postReply(run.id, { kind: 'answer', text: answer })
    }
    if (['submitted', 'failed', 'cancelled'].includes(current.status)) return
  }
})()

try {
  await executePlaygroundRun(run.id)
} catch (error) {
  logger.error({ err: error }, 'smoke run threw')
}
await approver

const final = await loadRunUnscoped(run.id)
const transcript = await db
  .select()
  .from(playgroundMessages)
  .where(eq(playgroundMessages.runId, run.id))

console.log('\n=== transcript ===')
for (const message of transcript) {
  console.log(`  [${message.speaker}]${message.kind ? ` (${message.kind})` : ''} ${message.body}`)
}

console.log('\n=== result ===')
console.log(`status:   ${final?.status}`)
console.log(`skill:    ${final?.skillId}`)
console.log(`live:     ${final?.liveUrl ?? '—'}`)
console.log(`chosen:   ${final?.chosenJobTitle ?? '—'} at ${final?.chosenJobCompany ?? '—'}`)
console.log(`filled:   ${JSON.stringify(final?.filledFields ?? [])}`)
console.log(`blocked:  ${JSON.stringify(final?.blockedFields ?? [])}`)
console.log(`emailed:  ${final?.emailSentAt ? 'yes' : 'no'}`)
console.log(`error:    ${final?.error ?? '—'}`)

await closeRedis()
await closeDatabase()
process.exit(final?.status === 'submitted' ? 0 : 1)
