import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { env, hasDatabase } from '../config/env.js'
import { logger } from '../lib/logger.js'
import * as schema from './schema.js'

/**
 * The pool is created lazily. Without it, a machine with no DATABASE_URL could
 * not boot the server at all — and we want `GET /healthz` to come up and *say*
 * the database is missing, rather than crash-looping before it can.
 */

let pool: pg.Pool | undefined
let database: NodePgDatabase<typeof schema> | undefined

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super('DATABASE_URL is not set — see .env.example')
    this.name = 'DatabaseNotConfiguredError'
  }
}

export function getPool(): pg.Pool {
  if (!hasDatabase) throw new DatabaseNotConfiguredError()
  if (!pool) {
    pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: env.DATABASE_POOL_MAX,
      // Supabase terminates TLS with a certificate chain Node does not ship a
      // root for. `rejectUnauthorized: false` keeps the transport encrypted
      // while skipping chain verification — the standard Supabase setup.
      ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    })

    pool.on('error', (error) => {
      logger.error({ err: error }, 'idle postgres client errored')
    })
  }
  return pool
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!database) {
    database = drizzle(getPool(), { schema, casing: 'snake_case' })
  }
  return database
}

/**
 * Proxy so modules can `import { db }` and read naturally, while the real pool
 * is still only built on first query.
 */
export const db = new Proxy({} as NodePgDatabase<typeof schema>, {
  get(_target, property, receiver) {
    return Reflect.get(getDb(), property, receiver)
  },
})

export async function pingDatabase(): Promise<{ ok: boolean; error?: string }> {
  if (!hasDatabase) return { ok: false, error: 'DATABASE_URL not set' }
  try {
    await getPool().query('select 1')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function closeDatabase(): Promise<void> {
  // Take the reference and clear the module state *before* awaiting: a second
  // caller arriving mid-await would otherwise call `end()` on the same pool,
  // which pg treats as a fatal error.
  const current = pool
  pool = undefined
  database = undefined
  if (current) await current.end()
}

export { schema }
