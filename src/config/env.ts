import 'dotenv/config'
import { z } from 'zod'

/**
 * Every knob the process reads lives here, validated once at boot. Nothing else
 * in the codebase is allowed to touch `process.env` directly — that way a typo
 * in a variable name fails loudly on startup instead of quietly at 3am.
 */

const csv = (value: string) =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1')

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://127.0.0.1:5173')
    .transform(csv),

  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_SSL: booleanish.default('true'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
  REDIS_URL: z.string().url().optional(),


  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  JWT_ISSUER: z.string().default('job-hunters-api'),

  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default('resumes'),
  SUPABASE_SIGNED_URL_TTL: z.coerce.number().int().positive().default(3600),
  PORTAL_CREDENTIALS_KEY: z.string().min(43).optional(),
  CHROMIUM_EXECUTABLE_PATH: z.string().min(1).optional(),
  PORTAL_AUTOMATION_ENABLED: booleanish.default('false'),


  MAX_RESUME_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  MAX_PHOTO_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),

  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),

  /**
   * Restricted to the IANA character set. This is not decoration: the value is
   * embedded as a literal inside `AT TIME ZONE` (see src/lib/sql.ts for why it
   * cannot be a bind parameter), and this regex is what makes that safe.
   */
  APP_TIMEZONE: z
    .string()
    .regex(/^[A-Za-z0-9_+\-/]+$/, 'APP_TIMEZONE must be an IANA timezone name, e.g. Asia/Kolkata')
    .default('Asia/Kolkata'),
})

/**
 * Dev-only fallbacks. In production a missing JWT secret is fatal; locally we
 * would rather the server boot so `GET /healthz` and the docs are reachable
 * before anyone has filled in a `.env`.
 */
function withDevFallbacks(raw: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (raw.NODE_ENV === 'production') return raw
  return {
    ...raw,
    JWT_ACCESS_SECRET:
      raw.JWT_ACCESS_SECRET || 'dev-only-insecure-access-secret-do-not-ship-0123456789',
    JWT_REFRESH_SECRET:
      raw.JWT_REFRESH_SECRET || 'dev-only-insecure-refresh-secret-do-not-ship-0123456789',
  }
}

const parsed = schema.safeParse(withDevFallbacks(process.env))

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
  // Deliberately console, not the logger: the logger is configured from env.
  console.error(`Invalid environment configuration:\n${detail}\n\nSee .env.example.`)
  process.exit(1)
}

export const env = parsed.data

export const isProduction = env.NODE_ENV === 'production'
export const isTest = env.NODE_ENV === 'test'

/** Storage calls are skipped (and reported as stubbed) until these are set. */
export const hasSupabaseStorage = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)

/** Every route that touches Postgres 503s until this is set. */
export const hasDatabase = Boolean(env.DATABASE_URL)
export const hasRedis = Boolean(env.REDIS_URL)
export const hasPortalCredentialVault = Boolean(env.PORTAL_CREDENTIALS_KEY)

export type Env = typeof env
