import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { hasDatabase } from '../config/env.js'
import { logger } from '../lib/logger.js'
import { closeDatabase, getDb } from './client.js'
import { syncPortalCatalogue } from './portal-catalogue.js'

/** Applies the SQL in ./migrations, then upserts the portal catalogue. */
export async function runMigrations(): Promise<void> {
  logger.info('applying migrations from ./migrations')
  await migrate(getDb(), { migrationsFolder: './migrations' })
  logger.info('migrations applied')

  const count = await syncPortalCatalogue()
  logger.info({ count }, 'portal catalogue synced')
}

async function main(): Promise<void> {
  if (!hasDatabase) {
    logger.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.')
    process.exit(1)
  }
  await runMigrations()
}

main()
  .then(async () => {
    await closeDatabase()
    process.exit(0)
  })
  .catch(async (error) => {
    logger.error({ err: error }, 'migration failed')
    await closeDatabase()
    process.exit(1)
  })
