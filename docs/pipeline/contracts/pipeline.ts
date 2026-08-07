/**
 * Queue and worker contracts.
 *
 * Five queues, one per stage, chained by the producing worker. Every payload is
 * a pointer plus the minimum context needed to act — never a whole resume, JD
 * or PDF. Redis holds job metadata; Postgres holds the truth.
 *
 * See ../01-queue-architecture.md for the reasoning.
 */

import type { AtsReport, JDAnalysis, TailoringPlan } from './resume'

/* ----------------------------------------------------------------- names -- */

export const QUEUES = {
  triage: 'hunt.triage',
  score: 'hunt.score',
  tailor: 'hunt.tailor',
  /** Terminal sink. Nothing consumes it; the UI reads it. */
  dead: 'hunt.dead',
} as const

/**
 * Scrape and apply are sharded per portal, because rate limits, session state
 * and failure modes are per portal and BullMQ OSS has no per-group limiter —
 * the limiter lives on the Worker, so one lane per portal is the only way to
 * pace LinkedIn independently of RemoteOK. Naukri going into cooldown must not
 * stall the Wellfound queue.
 */
export const scrapeQueue = (portal: string) => `hunt.scrape:${portal}` as const
export const applyQueue = (portal: string) => `hunt.apply:${portal}` as const

export type QueueName =
  | (typeof QUEUES)[keyof typeof QUEUES]
  | `hunt.scrape:${string}`
  | `hunt.apply:${string}`

/* ------------------------------------------------------------------- run -- */

export type RunStatus =
  | 'scheduled'
  | 'running'
  | 'paused'
  | 'completed'
  | 'stopped'
  | 'failed'

/**
 * One 06:00 sweep. Everything downstream carries `runId`, which is what makes
 * "stop the hunt" a single flag flip rather than a queue-draining exercise.
 */
export interface HuntRun {
  id: string
  userId: string
  /** The IST calendar date this run belongs to. Unique per user per day. */
  runDate: string // "2026-08-07"
  trigger: 'schedule' | 'manual' | 'catchup'
  status: RunStatus
  startedAt: string
  finishedAt: string | null
  /** Snapshot of the spec at run start. The user editing mid-run does not alter it. */
  spec: HuntSpec
  budget: RunBudget
  counters: RunCounters
}

export interface HuntSpec {
  roles: string[]
  companies: string[]
  locations: string[]
  minMatchScore: number
  dailyTarget: number
  dealBreakers: string[]
  portals: string[]
}

export interface RunBudget {
  /** From HuntSpec.dailyTarget. Hard cap on successful submissions. */
  applicationsTarget: number
  /** Hard cap on tailoring calls, target + headroom for render/ATS rejects. */
  tailoringCap: number
  /** USD. Run pauses, not fails, when hit. */
  llmSpendCapUsd: number
  /** Window the run may submit in, IST. Outside it, apply jobs stay delayed. */
  submitWindow: { startHour: number; endHour: number }
}

export interface RunCounters {
  scraped: number
  deduped: number
  scored: number
  belowThreshold: number
  tailored: number
  tailoringRejected: number
  rendered: number
  atsRejected: number
  submitted: number
  failed: number
  llmSpendUsd: number
}

/* -------------------------------------------------------------- payloads -- */

interface JobBase {
  runId: string
  userId: string
  /** Attempt-independent trace id. Survives retries; used by the live log. */
  traceId: string
}

export interface ScrapeJob extends JobBase {
  portal: string
  /** Only postings first seen inside this window. */
  since: string
  query: { roles: string[]; locations: string[] }
  cursor?: string
}

export interface TriageJob extends JobBase {
  portal: string
  /** Postings as scraped, before dedupe. */
  postings: RawPosting[]
}

export interface RawPosting {
  portal: string
  portalJobId: string
  url: string
  title: string
  company: string
  location: string
  salary?: string
  postedAt?: string
  descriptionText: string
}

export interface ScoreJob extends JobBase {
  jobId: string
  jdSnapshotId: string
}

export interface TailorJob extends JobBase {
  jobId: string
  applicationId: string
  jdSnapshotId: string
  baseResumeId: string
  baseResumeVersion: number
  templateId: string
  matchScore: number
}

export interface ApplyJob extends JobBase {
  applicationId: string
  jobId: string
  variantId: string
  portal: string
  /** Set when a prior attempt got partway through a multi-step form. */
  resumeFromStep?: string
}

export type Stage = 'scrape' | 'triage' | 'score' | 'tailor' | 'apply' | 'run'

export interface DeadJob extends JobBase {
  stage: Stage
  originalPayload: unknown
  error: { name: string; message: string; classification: FailureClass }
  attempts: number
  failedAt: string
}

export type PipelineJob =
  | ({ kind: 'scrape' } & ScrapeJob)
  | ({ kind: 'triage' } & TriageJob)
  | ({ kind: 'score' } & ScoreJob)
  | ({ kind: 'tailor' } & TailorJob)
  | ({ kind: 'apply' } & ApplyJob)

/* -------------------------------------------------------------- failures -- */

/**
 * Retry policy is chosen from the class, not from the exception type. Anything
 * unclassified is treated as `permanent` — retrying an unknown failure 5 times
 * against a portal that may be rate-limiting you is the worse default.
 */
export type FailureClass =
  | 'transient' // network blip, 5xx, timeout — retry with backoff
  | 'rate_limited' // 429 or portal soft-block — retry after cooldown, slow the lane
  | 'auth_expired' // session dead — pause the portal, notify, do not retry
  | 'captcha' // human needed — park, do not retry
  | 'form_changed' // selector miss — dead-letter immediately, adapter needs a fix
  | 'validation' // our data was rejected — dead-letter, needs a Kit fix
  | 'budget_exhausted' // run hit a cap — requeue tomorrow, not a failure
  | 'permanent' // anything else

/* ------------------------------------------------------------ idempotency -- */

/**
 * The one invariant that matters across restarts: never apply twice.
 *
 * Enforced in three places, deliberately redundant:
 *   1. `jobs.dedupe_key` unique index — a posting seen on two portals is one row.
 *   2. `applications (user_id, job_id)` unique index — one application per job,
 *      per user, forever. The DB is the authority, not the queue.
 *   3. BullMQ `jobId` set to a deterministic key so a duplicated enqueue is a
 *      no-op rather than a second run.
 */
export interface IdempotencyKeys {
  /** sha256(normalisedCompany + '|' + normalisedTitle + '|' + jdHash) */
  dedupeKey: string
  /** `apply:${userId}:${jobId}` — used as the BullMQ jobId on hunt.apply. */
  applyJobId: string
  /** `tailor:${userId}:${jobId}:${baseResumeVersion}` */
  tailorJobId: string
}

/* ---------------------------------------------------------- observability -- */

export type RunEventLevel = 'info' | 'success' | 'warn' | 'error'

/**
 * One row per meaningful thing that happened, appended to Postgres and pushed
 * over SSE. This is exactly what the UI's "live run log" renders — it already
 * has the shape (emoji + text + time) in `mock.ts::activity`.
 */
export interface RunEvent {
  id: string
  runId: string
  userId: string
  seq: number
  at: string
  level: RunEventLevel
  stage: Stage
  /** Rendered directly by the UI. Keep it human, no stack traces. */
  message: string
  emoji: string
  /** Ids the UI can link to. */
  refs?: { jobId?: string; applicationId?: string; variantId?: string; portal?: string }
}

/** Sent on the same SSE channel, throttled to ~1/s, so the UI can drive gauges. */
export interface RunProgress {
  runId: string
  status: RunStatus
  counters: RunCounters
  target: number
  /** Per-portal lane health, for the portals list on the Hunt screen. */
  portals: {
    portal: string
    state: 'idle' | 'working' | 'cooling' | 'blocked' | 'auth_expired'
    submittedToday: number
    remainingToday: number
    nextSlotAt: string | null
  }[]
  etaCompleteAt: string | null
}

export type RunStreamMessage =
  | { type: 'event'; data: RunEvent }
  | { type: 'progress'; data: RunProgress }
  | { type: 'heartbeat'; at: string }

/* ------------------------------------------------------------- scheduling -- */

export interface SchedulerConfig {
  /** Repeatable job id, one per user: `daily:${userId}`. */
  schedulerId: string
  /** Second-precision cron. 06:00 daily. */
  pattern: '0 0 6 * * *'
  /** IANA zone. India has no DST, but naming the zone keeps it correct anyway. */
  tz: 'Asia/Kolkata'
}

/** Rate-limit configuration per portal lane. */
export interface PortalLimits {
  portal: string
  /** BullMQ worker limiter: max jobs per duration for this lane. */
  maxPerWindow: number
  windowMs: number
  /** Hard daily ceiling regardless of the user's target. */
  dailyCap: number
  /** Randomised gap between submissions, ms. */
  jitter: { minMs: number; maxMs: number }
  /** Backoff multiplier applied to the lane after a 429 or soft-block. */
  cooldownMs: number
  concurrency: number
}

/* -------------------------------------------------- cross-stage artifacts -- */

/** Written by hunt.score, read by hunt.tailor. */
export interface ScoreResult {
  jobId: string
  matchScore: number
  jd: JDAnalysis
  breakdown: {
    skillOverlap: number
    titleAffinity: number
    seniorityFit: number
    locationFit: number
    companyPreference: number
  }
  dealBreakerHits: string[]
  decision: 'queue' | 'skip'
}

/** Written by hunt.tailor, read by hunt.apply. */
export interface TailorOutcome {
  applicationId: string
  variantId: string
  plan: TailoringPlan
  atsReport: AtsReport
  /** Path on the shared scratch volume. Deleted by the apply worker. */
  pdfPath: string
  contentHash: string
}
