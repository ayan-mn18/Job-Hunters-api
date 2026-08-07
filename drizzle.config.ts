import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

/**
 * drizzle-kit reads this for `npm run db:generate`.
 *
 * Generating SQL migrations does NOT need a live database — drizzle-kit diffs
 * src/db/schema.ts against the journal in ./migrations. That is deliberate:
 * the Supabase project does not exist yet, and the checked-in SQL should be
 * reviewable before anyone points it at a real cluster.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './migrations',
  casing: 'snake_case',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://placeholder/placeholder',
  },
  verbose: true,
  strict: true,
})
