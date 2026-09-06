import { eq } from 'drizzle-orm'
import { closeDatabase, db } from '../db/client.js'
import { huntRuns, users } from '../db/schema.js'
import { closeRedis } from '../lib/redis.js'
import { closeQueues, getQueue } from '../queues/index.js'
import { registerQueueImplementations } from '../queues/register.js'
import { QUEUE } from '../queues/names.js'
import { getHuntQueue } from '../services/hunt-queue.js'

/**
 * Proves the enqueue path end to end without going through HTTP auth:
 * create a run row, hand it to the queue, and read back what Redis holds.
 *
 * Run with:  npx tsx src/scripts/queue-smoke.ts <email>
 */

const email = process.argv[2]
if (!email) {
  console.error('usage: tsx src/scripts/queue-smoke.ts <email>')
  process.exit(1)
}

registerQueueImplementations()

const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)
if (!user) {
  console.error(`no user with email ${email}`)
  process.exit(1)
}

const [run] = await db
  .insert(huntRuns)
  .values({ userId: user.id, status: 'queued', targetApplications: 5 })
  .returning()
if (!run) throw new Error('could not create run')

const queue = getHuntQueue()
console.log(`queue implementation: ${queue.name} (real: ${queue.isReal})`)

const { jobId } = await queue.enqueue({
  runId: run.id,
  userId: user.id,
  targetApplications: 5,
})
console.log(`enqueued job ${jobId} for run ${run.id}`)

const counts = await getQueue(QUEUE.discover).getJobCounts()
console.log('queue counts:', counts)

await closeQueues()
await closeRedis()
await closeDatabase()
process.exit(0)
