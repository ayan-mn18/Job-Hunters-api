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

/** Blank values in a copied .env.example mean "not configured". */
const optionalString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
)

const optionalUrl = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().url().optional(),
)

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

  DATABASE_URL: optionalString,
  DATABASE_SSL: booleanish.default('true'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
  REDIS_URL: optionalUrl,


  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  JWT_ISSUER: z.string().default('job-hunters-api'),

  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  SUPABASE_URL: optionalUrl,
  SUPABASE_SERVICE_ROLE_KEY: optionalString,
  SUPABASE_STORAGE_BUCKET: z.string().default('resumes'),
  SUPABASE_SIGNED_URL_TTL: z.coerce.number().int().positive().default(3600),
  PORTAL_CREDENTIALS_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(43).optional(),
  ),
  CHROMIUM_EXECUTABLE_PATH: optionalString,
  PORTAL_AUTOMATION_ENABLED: booleanish.default('false'),
  /** Adds --no-sandbox and friends. Set by the runner image, not by hand. */
  BROWSER_IN_CONTAINER: booleanish.default('false'),
  /**
   * Fill every field, screenshot the result, and stop before submitting.
   *
   * On by default. Turning it off is what makes the product send real
   * applications to real employers on someone's behalf, and that should be a
   * deliberate act rather than a default anyone inherits.
   */
  APPLY_DRY_RUN: booleanish.default('true'),
  /** Stops every application immediately, without a redeploy. */
  APPLY_KILL_SWITCH: booleanish.default('false'),
  /** How long a blocked attempt waits for a human before parking. */
  APPLY_TAKEOVER_WINDOW_MS: z.coerce.number().int().positive().default(5 * 60_000),
  /**
   * Maximum concurrent application jobs on the browser runner.
   *
   * Capped at the browser ceiling below. Allowing more would only queue the
   * excess inside `openSession`, which is a worse place to wait than the job
   * queue — a job holding a BullMQ lock while it waits for a browser is a job
   * that can stall out and be retried for no reason.
   */
  RUNNER_APPLY_CONCURRENCY: z.coerce.number().int().positive().max(4).default(1),
  /**
   * Opens a real window for interactive sign-in.
   *
   * Only meaningful with BROWSER_PROVIDER=local. With the hosted provider a
   * user signs in by clicking inside the session's live view, which needs no
   * display on the host at all.
   */
  AUTOMATION_HEADFUL: booleanish.default('false'),

  /**
   * Where browsers come from.
   *
   * `browser-use` is a hosted Chromium reached over CDP: stealth, residential
   * proxies, CAPTCHA solving, a per-user profile that keeps a login alive, and
   * a live URL a human can take over in. `local` is the old Playwright launch,
   * kept for offline development and for tests.
   */
  BROWSER_PROVIDER: z.enum(['browser-use', 'local']).default('browser-use'),
  BROWSER_USE_API_KEY: optionalString,
  BROWSER_USE_API_BASE: z.string().url().default('https://api.browser-use.com/api/v4'),
  /**
   * Two-letter country for the managed residential proxy, or empty for a
   * direct connection.
   *
   * Empty is the default because the two egress rates differ by 25× ($5/GB
   * managed against $0.20/GB direct) and most application forms do not care
   * where the request comes from. Sites that do care ask for a proxy in their
   * own skill manifest.
   */
  BROWSER_USE_PROXY_COUNTRY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().length(2).optional(),
  ),
  /** Minutes before a hosted session self-terminates. Also the billing cap. */
  BROWSER_SESSION_TIMEOUT_MIN: z.coerce.number().int().positive().max(240).default(15),
  /**
   * How many browsers may exist at once, across every part of the product.
   *
   * Applying is not the only thing that opens one — LinkedIn outreach, the
   * referral sync and interactive sign-in each open their own — so this counts
   * browsers rather than jobs. Callers past the limit queue and then fail with
   * a clear message rather than being refused by the provider for a reason
   * that has nothing to do with what they were doing.
   */
  BROWSER_MAX_CONCURRENT_SESSIONS: z.coerce.number().int().positive().max(10).default(4),
  /**
   * Hands a failed flow to Browser Use's own managed agent as a last resort.
   *
   * Off by default, and it should stay off: that agent reasons with a model
   * from their list, not with Muse Spark, so every run through it puts a
   * different brain in the loop than the rest of the product uses.
   */
  BROWSER_USE_MANAGED_FALLBACK: booleanish.default('false'),

  /**
   * Firecrawl handles every page we are allowed to read without signing in —
   * job boards with no API, company career pages, posting detail pages. It
   * renders JavaScript and survives the anti-bot checks that made those
   * sources unreliable through plain `fetch`.
   */
  FIRECRAWL_API_KEY: optionalString,
  FIRECRAWL_API_BASE: z.string().url().default('https://api.firecrawl.dev/v2'),

  /**
   * Which provider reasons.
   *
   * `muse` is the default: Muse Spark answers every purpose in the product,
   * from reranking a job to deciding the next click in a form. Anthropic stays
   * reachable because Muse is a single point of failure otherwise — a bad key
   * or an outage would take down rerank, classification, drafting and applying
   * at the same moment.
   */
  MODEL_PROVIDER: z.enum(['muse', 'anthropic']).default('muse'),
  /** The Muse Spark model the gateway calls for ordinary purposes. */
  MUSE_MODEL: z.string().default('muse-spark-1.3-contributor'),

  /**
   * Model access. Absent, the gateway reports itself as unconfigured and every
   * model-backed feature degrades to its deterministic fallback rather than
   * throwing — the same posture the storage and queue checks take.
   */
  ANTHROPIC_API_KEY: optionalString,
  /**
   * Required only for an identity-linked API key (one console account with
   * access to several workspaces) — it disambiguates which workspace the
   * call bills to. A workspace's own key does not need this.
   */
  ANTHROPIC_WORKSPACE_ID: optionalString,
  /** Per-purpose overrides. All default to the general-purpose model. */
  MODEL_DEFAULT: z.string().default('claude-opus-5'),
  MODEL_RERANK: z.string().optional(),
  MODEL_CLASSIFY: z.string().optional(),
  MODEL_DRAFT: z.string().optional(),
  /** Per-user monthly ceiling in USD. 0 disables the check. */
  MODEL_MONTHLY_BUDGET_USD: z.coerce.number().min(0).default(20),

  /**
   * Muse Spark, through Meta's OpenAI-compatible Model API.
   *
   * This is the key the whole product reasons with, not just the apply agent:
   * without it `MODEL_PROVIDER=muse` has nothing to call and every
   * model-backed feature drops to its deterministic fallback.
   */
  META_API_KEY: optionalString,
  META_API_BASE: z.string().url().default('https://api.meta.ai/v1'),
  APPLY_AGENT_MODEL: z.string().default('muse-spark-1.3-contributor'),
  /**
   * Muse Spark is a reasoning model and spends most of its budget thinking —
   * a one-word reply measured 434 reasoning tokens — so this ceiling is per
   * agent step, not per application, and is deliberately generous.
   */
  APPLY_AGENT_MAX_TOKENS: z.coerce.number().int().positive().default(8000),
  /**
   * Hard stop on a runaway agent loop, for the batch tier.
   *
   * Low because the deterministic ladder has already filled most of the form
   * by the time the agent runs there; it only handles the leftovers.
   */
  APPLY_AGENT_MAX_STEPS: z.coerce.number().int().positive().default(18),
  /**
   * The same ceiling for a playground run, where the agent fills the whole
   * form itself.
   *
   * A live Anthropic posting on Greenhouse has 53 interactive elements and ran
   * out of room at 18 with the form most of the way done — which is the worst
   * possible place to stop, because nothing was submitted and the work was
   * thrown away.
   */
  PLAYGROUND_AGENT_MAX_STEPS: z.coerce.number().int().positive().default(45),
  /**
   * Ceiling on a single agent step. Without one, a stalled `act()` parks the
   * application in `applying` forever: apply jobs are queued with
   * `attempts: 1` and carry no timeout of their own.
   */
  APPLY_AGENT_STEP_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  /** How many times the same browser/model error may be recovered in-place. */
  APPLY_RECOVERY_ATTEMPTS: z.coerce.number().int().positive().max(5).default(3),

  /**
   * Tier-1 job search APIs. Each connector reports itself unavailable —
   * rather than failing a run — when its key is missing, so a deployment can
   * enable them one at a time.
   *
   * A Google-for-Jobs connector is what reaches LinkedIn, Naukri, Foundit and
   * Indeed postings without touching anyone's account. Either provider works;
   * whichever key is present is used.
   */
  JSEARCH_API_KEY: optionalString,
  SERPAPI_KEY: optionalString,
  ADZUNA_APP_ID: optionalString,
  ADZUNA_APP_KEY: optionalString,
  JOOBLE_API_KEY: optionalString,

  /**
   * Gmail. `gmail.readonly` is a Google *restricted* scope: a published app
   * needs an annual CASA assessment, but the OAuth consent screen's testing
   * mode allows up to 100 manually added users for free. Start there.
   */
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  /** Existing Gmail callback. Kept separate from login so the scopes stay isolated. */
  GOOGLE_OAUTH_REDIRECT: optionalUrl,
  GOOGLE_GMAIL_REDIRECT: optionalUrl,
  /** Google login callback. It may share the Gmail callback URI. */
  GOOGLE_AUTH_REDIRECT: optionalUrl.default('http://localhost:46461/login'),

  /** Dodo Payments is deliberately opt-in; test mode is the safe default. */
  DODO_PAYMENTS_API_KEY: optionalString,
  DODO_PAYMENTS_WEBHOOK_KEY: optionalString,
  DODO_PAYMENTS_BASE_URL: z.string().url().default('https://test.dodopayments.com'),
  DODO_PAYMENTS_ENABLED: booleanish.default('false'),
  DODO_PAYMENTS_PRODUCT_ID: optionalString,
  DODO_PAYMENTS_RETURN_URL: optionalUrl,

  /**
   * Outgoing mail, for run confirmations.
   *
   * Deliberately plain SMTP rather than sending through the user's own Gmail:
   * that would need `gmail.send`, a second restricted scope and a second
   * consent screen, for one message. Without these the confirmation is logged
   * and skipped, and the application it describes still stands.
   */
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().positive().max(65535).default(587),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  MAIL_FROM: z.string().default('Hunty <hunty@huntly.app>'),

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

/**
 * Model-backed features fall back to deterministic behaviour without a key for
 * whichever provider is active. Asking about the wrong provider's key is how a
 * feature reports itself available and then throws on first use.
 */
export const hasModelAccess =
  env.MODEL_PROVIDER === 'muse' ? Boolean(env.META_API_KEY) : Boolean(env.ANTHROPIC_API_KEY)

/** Discovery keeps its API connectors without this; only HTML sources need it. */
export const hasFirecrawl = Boolean(env.FIRECRAWL_API_KEY)

/** Hosted browsers. Without a key the browser provider falls back to local. */
export const hasBrowserUse = Boolean(env.BROWSER_USE_API_KEY)

/** What `openSession` will actually do, once the key situation is accounted for. */
export const browserProvider: 'browser-use' | 'local' =
  env.BROWSER_PROVIDER === 'browser-use' && hasBrowserUse ? 'browser-use' : 'local'

/** Run confirmations are logged instead of sent until SMTP is configured. */
export const hasMailer = Boolean(env.SMTP_HOST)

/** Gmail ingest is off until an OAuth client exists. */
export const hasGmail = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)

/** Google login is separately state-bound even when it shares Gmail's redirect URI. */
export const hasGoogleAuth = Boolean(
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_AUTH_REDIRECT,
)

/** Dodo remains unavailable until the explicit enable switch is turned on. */
export const hasDodoPayments = Boolean(
  env.DODO_PAYMENTS_ENABLED && env.DODO_PAYMENTS_API_KEY && env.DODO_PAYMENTS_PRODUCT_ID,
)

/**
 * The agent tier falls back to the deterministic recipe ladder without a key,
 * the same posture every other model-backed feature takes.
 */
export const hasApplyAgent = Boolean(env.META_API_KEY)

export type Env = typeof env
