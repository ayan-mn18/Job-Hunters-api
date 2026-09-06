import { sql } from 'drizzle-orm'
import { hasDatabase } from '../config/env.js'
import { closeDatabase, getDb } from '../db/client.js'
import { logger } from '../lib/logger.js'

/**
 * Wipes scraped job data so a run can start from a clean slate.
 *
 * Hunt runs themselves are kept: the run history is the record of what the
 * product did, and deleting it would erase the user's own activity rather than
 * bad scrape output. The child rows that point at jobs do go, because they
 * carry scores computed by the old scorer.
 *
 * Users, kits, resumes, applications and portal accounts are never touched.
 */

const TABLES = ['hunt_candidates', 'hunt_run_jobs', 'job_sources', 'jobs'] as const

async function main(): Promise<void> {
  if (!hasDatabase) {
    logger.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.')
    process.exit(1)
  }
  const db = getDb()

  const before: Record<string, number> = {}
  for (const table of TABLES) {
    const result = await db.execute<{ count: string }>(sql`select count(*)::text as count from ${sql.identifier(table)}`)
    before[table] = Number(result.rows[0]?.count ?? 0)
  }
  logger.info(before, 'rows before reset')

  // One statement so the tables cannot be observed half-empty, and so the
  // foreign keys between them never have to be satisfied mid-way.
  await db.execute(sql`truncate table hunt_candidates, hunt_run_jobs, job_sources, jobs restart identity cascade`)

  // Counters on hunt_runs describe jobs that no longer exist.
  await db.execute(sql`
    update hunt_runs
       set jobs_scraped = 0,
           jobs_scored = 0,
           candidates_approved = 0,
           updated_at = now()
     where jobs_scraped <> 0 or jobs_scored <> 0 or candidates_approved <> 0
  `)

  logger.info({ cleared: TABLES }, 'job data reset; hunt run history kept')
}

main()
  .then(async () => {
    await closeDatabase()
    process.exit(0)
  })
  .catch(async (error) => {
    logger.error({ err: error }, 'job reset failed')
    await closeDatabase()
    process.exit(1)
  })
