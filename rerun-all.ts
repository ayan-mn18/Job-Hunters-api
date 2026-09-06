import { and, eq } from 'drizzle-orm'
import { db } from './src/db/client.js'
import { huntCandidates } from './src/db/schema.js'
import { applyApprovedCandidate } from './src/hunt/apply.js'

const U = '6456cc3c-2d51-42ab-a521-37f5519c5d05'
const R = 'e73f1ad3-b200-4531-a258-f28c0694c95b'

const rows = await db.select({ id: huntCandidates.id, portal: huntCandidates.sourcePortal })
  .from(huntCandidates)
  .where(and(eq(huntCandidates.runId, R), eq(huntCandidates.userId, U), eq(huntCandidates.status, 'queued')))

console.log(`RERUN ${rows.length} candidates with the agent tier enabled`)
let i = 0
for (const row of rows) {
  i++
  const t0 = Date.now()
  try {
    await applyApprovedCandidate(U, row.id, { dryRun: true })
    console.log(`[${i}/${rows.length}] ${row.portal} ok ${((Date.now()-t0)/1000).toFixed(0)}s`)
  } catch (e) {
    console.log(`[${i}/${rows.length}] ${row.portal} FAILED ${((Date.now()-t0)/1000).toFixed(0)}s :: ${(e as Error).message.slice(0,120)}`)
  }
}
console.log('ALL DONE')
process.exit(0)
