import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Schema notes
 * ------------
 * - Every user-scoped table carries `user_id` with `on delete cascade`, so a
 *   single delete of a user leaves nothing behind. That matters here: this
 *   database holds resumes, phone numbers and salary figures.
 * - Money and durations ("₹24,00,000", "30 days") are stored as free text on
 *   purpose. Job portals ask these questions in a dozen incompatible formats
 *   and the answer is copied into a form field verbatim; normalising it would
 *   lose fidelity for no gain.
 * - Timestamps are `timestamptz`. Anything that groups by day (referral days,
 *   the streak, "applied today") converts to APP_TIMEZONE at query time.
 */

const now = sql`now()`

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(now),
}

/* -------------------------------------------------------------------- enums */

export const applicationStatusEnum = pgEnum('application_status', [
  'queued',
  'applied',
  'viewed',
  'interview',
  'rejected',
  'needs_review',
  'failed',
  'closed',
])

export const referralSourceEnum = pgEnum('referral_source', ['linkedin', 'email'])

export const resumeKindEnum = pgEnum('resume_kind', ['base', 'variant'])

export const resumeParseStatusEnum = pgEnum('resume_parse_status', [
  'pending',
  'parsing',
  'parsed',
  'failed',
])

export const huntRunStatusEnum = pgEnum('hunt_run_status', [
  'queued',
  'running',
  'awaiting_approval',
  'applying',
  'paused',
  'stopped',
  'completed',
  'failed',
])

export const huntCandidateStatusEnum = pgEnum('hunt_candidate_status', [
  'discovered',
  'approved',
  'rejected',
  'tailored',
  'queued',
  'applying',
  'applied',
  'needs_review',
  'failed',
])

export const huntRunJobStatusEnum = pgEnum('hunt_run_job_status', [
  'scraped',
  'eligible',
  'below_threshold',
  'deal_breaker',
  'role_mismatch',
  'seniority_mismatch',
  'experience_mismatch',
  'insufficient_skills',
  'location_mismatch',
  'approved',
  'rejected',
  'queued',
  'tailored',
  'applying',
  'applied',
  'needs_review',
  'failed',
  'closed',
])

export const portalAccountStatusEnum = pgEnum('portal_account_status', [
  'absent',
  'provisioning',
  'pending_verification',
  'ready',
  'blocked',
  'failed',
])

export const applyAttemptStatusEnum = pgEnum('apply_attempt_status', [
  'pending',
  'submitting',
  'submitted',
  'needs_review',
  'unknown',
  'failed',
])

export const playgroundRunStatusEnum = pgEnum('playground_run_status', [
  'queued',
  'launching',
  'searching',
  /** A match is chosen and waiting for a person to press Apply. */
  'shortlisted',
  'applying',
  /** The agent asked a question and cannot continue until it is answered. */
  'blocked',
  'submitted',
  'failed',
  'cancelled',
])

export const playgroundSpeakerEnum = pgEnum('playground_speaker', [
  'huntly',
  'agent',
  'llm',
  'user',
  'system',
])

export const activityKindEnum = pgEnum('activity_kind', [
  'application_submitted',
  'application_status_changed',
  'resume_tailored',
  'resume_uploaded',
  'jobs_scraped',
  'referral_received',
  'referral_handled',
  'hunt_started',
  'hunt_stopped',
  'portal_connected',
  'portal_disconnected',
  'account_created',
  'onboarding_completed',
])

/* -------------------------------------------------------------------- users */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    /** Google OIDC subject. Email remains the fallback link for old accounts. */
    googleSubject: text('google_subject'),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    /** Emoji the UI shows as the avatar. Picked at signup, editable later. */
    avatar: text('avatar').notNull().default('🧑‍🚀'),
    /** Drives the onboarding redirect guard in the UI. */
    onboarded: boolean('onboarded').notNull().default(false),
    onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().default(now),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // Case-insensitive uniqueness. Emails are stored lowercased by the service
    // layer as well; this index is the backstop.
    uniqueIndex('users_email_lower_idx').on(sql`lower(${table.email})`),
    uniqueIndex('users_google_subject_idx').on(table.googleSubject),
  ],
)

/**
 * Refresh tokens are stored hashed, one row per issued token, so that:
 *   - a stolen database dump cannot be replayed as a session,
 *   - logout can revoke exactly one device,
 *   - reuse of an already-rotated token can be detected.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** Set when this token was rotated, pointing at its replacement. */
    replacedByTokenId: uuid('replaced_by_token_id'),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('refresh_tokens_hash_idx').on(table.tokenHash),
    index('refresh_tokens_user_idx').on(table.userId),
  ],
)

/* ---------------------------------------------------------------------- kit */

/**
 * "My Kit" — one row per user. The bag of answers every job portal form asks
 * for. One row rather than a key/value bag because the UI renders a fixed set
 * of labelled fields, and typed columns keep that contract honest.
 */
export const kits = pgTable('kits', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),

  fullName: text('full_name'),
  pronouns: text('pronouns'),
  /** Contact email on forms — may differ from the login email. */
  email: text('email'),
  phone: text('phone'),

  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  city: text('city'),
  state: text('state'),
  /** PIN / ZIP / postcode. */
  postalCode: text('postal_code'),
  country: text('country'),

  linkedinUrl: text('linkedin_url'),
  githubUrl: text('github_url'),
  portfolioUrl: text('portfolio_url'),

  /** Shown under the name on the Kit screen, e.g. "Full-stack Engineer". */
  headline: text('headline'),

  noticePeriod: text('notice_period'),
  totalExperience: text('total_experience'),
  maxYearsExperience: smallint('max_years_experience').notNull().default(5),
  currentCtc: text('current_ctc'),
  expectedCtc: text('expected_ctc'),
  workAuthorization: text('work_authorization'),
  willingToRelocate: text('willing_to_relocate'),
  /** Private Supabase object used only for supported portal profiles. */
  photoStoragePath: text('photo_storage_path'),
  photoFileName: text('photo_file_name'),
  photoMimeType: text('photo_mime_type'),


  skills: text('skills').array().notNull().default(sql`'{}'::text[]`),

  ...timestamps,
})

export const employments = pgTable(
  'employments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull().default('💼'),
    role: text('role').notNull(),
    company: text('company').notNull(),
    startedOn: date('started_on'),
    endedOn: date('ended_on'),
    isCurrent: boolean('is_current').notNull().default(false),
    /** Free-text override for the date range, when the dates are fuzzy. */
    periodLabel: text('period_label'),
    blurb: text('blurb'),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
  },
  (table) => [index('employments_user_idx').on(table.userId, table.sortOrder)],
)

/**
 * The raw onboarding wizard payload, kept verbatim alongside the normalised
 * kit/spec rows it was fanned out into. Cheap to store, and the only way to
 * answer "what did the user actually type in step 3" after the fact.
 */
export const onboardingSubmissions = pgTable(
  'onboarding_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    payload: jsonb('payload').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [index('onboarding_submissions_user_idx').on(table.userId)],
)

/* ------------------------------------------------------------------ resumes */

export const resumes = pgTable(
  'resumes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: resumeKindEnum('kind').notNull().default('base'),
    /** Original filename, shown in the UI. */
    fileName: text('file_name').notNull(),
    /** Object key inside the Supabase Storage bucket. */
    storagePath: text('storage_path').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** Exactly one base resume per user is true; enforced by a partial index. */
    isBase: boolean('is_base').notNull().default(false),

    parseStatus: resumeParseStatusEnum('parse_status').notNull().default('pending'),
    parsedAt: timestamp('parsed_at', { withTimezone: true }),
    parseError: text('parse_error'),
    /** Structured profile from the parser workstream. Shape owned by them. */
    parsedProfile: jsonb('parsed_profile'),
    parsedSkills: text('parsed_skills').array().notNull().default(sql`'{}'::text[]`),
    parsedTitles: text('parsed_titles').array().notNull().default(sql`'{}'::text[]`),
    parsedYearsExperience: smallint('parsed_years_experience'),
    /** Canonical user-editable resume structure used by portal profiles and tailoring. */
    structuredDocument: jsonb('structured_document'),
    structuredVersion: integer('structured_version').notNull().default(1),
    structuredConfirmedAt: timestamp('structured_confirmed_at', { withTimezone: true }),

    /** For variants: the base resume this was tailored from. */
    derivedFromResumeId: uuid('derived_from_resume_id'),
    /** For variants: the job description text it was tailored against. */
    tailoredForJobTitle: text('tailored_for_job_title'),

    ...timestamps,
  },
  (table) => [
    index('resumes_user_idx').on(table.userId, table.kind),
    uniqueIndex('resumes_one_base_per_user_idx')
      .on(table.userId)
      .where(sql`${table.isBase} = true`),
  ],
)

/* ------------------------------------------------------------------ portals */

/**
 * Global catalogue, seeded from migration data rather than per-user rows, so
 * adding "Dice" later is one INSERT and every user sees it.
 */
export const portals = pgTable('portals', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  emoji: text('emoji').notNull(),
  /** Marketing/JD site the scraper targets. Informational only. */
  websiteUrl: text('website_url'),
  sortOrder: integer('sort_order').notNull().default(0),
  /** Lets us dark-launch a portal the scraper cannot handle yet. */
  isAvailable: boolean('is_available').notNull().default(true),
  ...timestamps,
})

export const userPortals = pgTable(
  'user_portals',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    portalId: text('portal_id')
      .notNull()
      .references(() => portals.id, { onDelete: 'cascade' }),
    connected: boolean('connected').notNull().default(false),
    /** Running total the Den and Hunt screens add up. Owned by the scraper. */
    jobsFound: integer('jobs_found').notNull().default(0),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    /**
     * Portal session material lives OUTSIDE this table on purpose — see
     * docs/ for the credential-vault decision. Nothing secret goes here.
     */
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.userId, table.portalId] })],
)

/* ---------------------------------------------------------------- hunt spec */

export const huntSpecs = pgTable('hunt_specs', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  roles: text('roles').array().notNull().default(sql`'{}'::text[]`),
  dreamCompanies: text('dream_companies').array().notNull().default(sql`'{}'::text[]`),
  locations: text('locations').array().notNull().default(sql`'{}'::text[]`),
  dealBreakers: text('deal_breakers').array().notNull().default(sql`'{}'::text[]`),
  minMatchScore: smallint('min_match_score').notNull().default(70),
  dailyTarget: smallint('daily_target').notNull().default(100),
  /**
   * Per-user scoring weights, `{ title, skills, experience, location, company }`,
   * summing to 100. Stored rather than hardcoded so two people hunting
   * different things do not have to share one opinion about what matters.
   */
  scoreWeights: jsonb('score_weights'),
  /** Master switch: false pauses the scheduled morning run. */
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
})

/**
 * One row per invocation of the hunt pipeline. The worker (other workstream)
 * owns writing progress here; this API only creates, reads, and requests stop.
 */
export const huntRuns = pgTable(
  'hunt_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: huntRunStatusEnum('status').notNull().default('queued'),
    /** Set by this API; the worker polls it to wind down gracefully. */
    stopRequestedAt: timestamp('stop_requested_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    targetApplications: integer('target_applications').notNull().default(0),
    jobsScraped: integer('jobs_scraped').notNull().default(0),
    jobsScored: integer('jobs_scored').notNull().default(0),
    applicationsSubmitted: integer('applications_submitted').notNull().default(0),
    candidatesApproved: integer('candidates_approved').notNull().default(0),
    applicationsNeedsReview: integer('applications_needs_review').notNull().default(0),
    approvalRequired: boolean('approval_required').notNull().default(true),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    /** Free-form worker breadcrumb, e.g. { step: "tailor", portal: "linkedin" }. */
    progress: jsonb('progress'),
    error: text('error'),
    ...timestamps,
  },
  (table) => [index('hunt_runs_user_idx').on(table.userId, table.createdAt)],
)

/* ----------------------------------------------------------- hunt pipeline */

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fingerprint: text('fingerprint').notNull(),
    title: text('title').notNull(),
    company: text('company').notNull(),
    locations: jsonb('locations').notNull(),
    remoteMode: text('remote_mode').notNull().default('unknown'),
    /** full_time | part_time | contract | internship | temporary | unknown */
    employmentType: text('employment_type').notNull().default('unknown'),
    descriptionText: text('description_text'),
    /** Sanitised JD markup, kept so the UI can render headings and lists. */
    descriptionHtml: text('description_html'),
    descriptionHash: text('description_hash'),
    canonicalUrl: text('canonical_url').notNull(),
    applyUrl: text('apply_url'),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull(),
    postedAtPrecision: text('posted_at_precision').notNull(),
    skills: text('skills').array().notNull().default(sql`'{}'::text[]`),
    /** Years of experience the posting asks for. Null means the JD never said. */
    experienceMin: smallint('experience_min'),
    experienceMax: smallint('experience_max'),
    /** Verbatim phrase the years came from, so a wrong parse is auditable. */
    experienceText: text('experience_text'),
    /**
     * Salary is stored twice on purpose: parsed numbers drive filtering and
     * sorting, `salaryText` keeps what the posting actually said so the UI
     * never has to reconstruct "₹18–24 LPA" from two integers.
     */
    salaryMin: numeric('salary_min'),
    salaryMax: numeric('salary_max'),
    salaryCurrency: text('salary_currency'),
    /** hour | day | week | month | year */
    salaryPeriod: text('salary_period'),
    salaryText: text('salary_text'),
    responsibilities: text('responsibilities').array().notNull().default(sql`'{}'::text[]`),
    /** Per-field `{ value, confidence, method, sourceField }` audit trail. */
    extractionMeta: jsonb('extraction_meta'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('jobs_fingerprint_idx').on(table.fingerprint),
    index('jobs_posted_idx').on(table.postedAt),
  ],
)

export const jobSources = pgTable(
  'job_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    portalId: text('portal_id').notNull(),
    sourceId: text('source_id').notNull(),
    sourceUrl: text('source_url').notNull(),
    applyUrl: text('apply_url'),
    raw: jsonb('raw'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().default(now),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('job_sources_portal_source_idx').on(table.portalId, table.sourceId),
    index('job_sources_job_idx').on(table.jobId),
  ],
)

export const huntRunJobs = pgTable(
  'hunt_run_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => huntRuns.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    sourcePortal: text('source_portal').notNull(),
    status: huntRunJobStatusEnum('status').notNull().default('scraped'),
    score: smallint('score'),
    scoreBreakdown: jsonb('score_breakdown'),
    reasons: text('reasons').array().notNull().default(sql`'{}'::text[]`),
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().default(now),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('hunt_run_jobs_run_job_idx').on(table.runId, table.jobId),
    index('hunt_run_jobs_user_status_idx').on(table.userId, table.status),
    index('hunt_run_jobs_run_portal_idx').on(table.runId, table.sourcePortal),
    // Matches the ORDER BY on the scraped-jobs dashboard, which is otherwise a
    // full sort of every row in the run on each page request.
    index('hunt_run_jobs_run_score_idx').on(table.runId, table.score.desc(), table.discoveredAt.desc()),
  ],
)

export const huntCandidates = pgTable(
  'hunt_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => huntRuns.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    sourcePortal: text('source_portal').notNull(),
    score: smallint('score').notNull(),
    scoreBreakdown: jsonb('score_breakdown').notNull(),
    reasons: text('reasons').array().notNull().default(sql`'{}'::text[]`),
    status: huntCandidateStatusEnum('status').notNull().default('discovered'),
    resumeVariantId: uuid('resume_variant_id'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('hunt_candidates_run_job_idx').on(table.runId, table.jobId),
    index('hunt_candidates_user_status_idx').on(table.userId, table.status),
  ],
)

export const resumeVariants = pgTable(
  'resume_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => huntCandidates.id, { onDelete: 'cascade' }),
    baseResumeId: uuid('base_resume_id')
      .notNull()
      .references(() => resumes.id, { onDelete: 'restrict' }),
    fileName: text('file_name').notNull(),
    storagePath: text('storage_path').notNull(),
    plan: jsonb('plan').notNull(),
    changed: boolean('changed').notNull().default(false),
    contentHash: text('content_hash'),
    ...timestamps,
  },
  (table) => [uniqueIndex('resume_variants_candidate_idx').on(table.candidateId)],
)

export const portalAccounts = pgTable(
  'portal_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    portalId: text('portal_id').notNull(),
    email: text('email').notNull(),
    encryptedCredentials: text('encrypted_credentials'),
    status: portalAccountStatusEnum('status').notNull().default('absent'),
    externalUserId: text('external_user_id'),
    /**
     * The hosted browser profile holding this portal's login.
     *
     * Replaces storing a `storageState` blob in `encrypted_credentials`: the
     * cookies live with the browser that will use them, they refresh on every
     * visit instead of going stale the week after they were captured, and this
     * column is a reference rather than a secret.
     */
    browserProfileId: text('browser_profile_id'),
    actionRequired: text('action_required'),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    profileSyncedAt: timestamp('profile_synced_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex('portal_accounts_user_portal_idx').on(table.userId, table.portalId)],
)

export const applyAttempts = pgTable(
  'apply_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => huntCandidates.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    portalId: text('portal_id').notNull(),
    status: applyAttemptStatusEnum('status').notNull().default('pending'),
    externalApplicationId: text('external_application_id'),
    submittedFields: jsonb('submitted_fields'),
    unresolvedFields: jsonb('unresolved_fields'),
    evidenceStoragePath: text('evidence_storage_path'),
    /** Where a human can watch this attempt, and take it over. */
    liveUrl: text('live_url'),
    /** The hosted browser session, kept for cost attribution after the fact. */
    browserSessionId: text('browser_session_id'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index('apply_attempts_candidate_idx').on(table.candidateId, table.createdAt)],
)

/* --------------------------------------------------------------- playground */

/**
 * One job, watched from the prompt to the confirmation email.
 *
 * Kept apart from `hunt_runs` deliberately. A hunt is a batch that optimises
 * for throughput and reports a status per row; a playground run is a single
 * application that optimises for being watchable, and it stops and asks rather
 * than parking itself for review. Sharing a table would have meant every
 * column on it meaning two things.
 *
 * It still writes a real `applications` row when it submits — the application
 * is real, only the framing around it is different.
 */
export const playgroundRuns = pgTable(
  'playground_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** What the user typed. */
    prompt: text('prompt').notNull(),
    status: playgroundRunStatusEnum('status').notNull().default('queued'),
    /** The site skill this run resolved to, e.g. `workatastartup`. */
    skillId: text('skill_id'),
    /** Where a person can watch and take over. */
    liveUrl: text('live_url'),
    browserSessionId: text('browser_session_id'),
    /** Ranked postings, as shown in the browser panel. */
    shortlist: jsonb('shortlist'),
    /** The posting the user pressed Apply on. */
    chosenJobUrl: text('chosen_job_url'),
    chosenJobTitle: text('chosen_job_title'),
    chosenJobCompany: text('chosen_job_company'),
    /** The application row this produced, once it submitted. */
    applicationId: uuid('application_id').references(() => applications.id, {
      onDelete: 'set null',
    }),
    /** What went in, and what was deliberately left out. */
    filledFields: jsonb('filled_fields'),
    blockedFields: jsonb('blocked_fields'),
    /** The question the run is waiting on, when status is `blocked`. */
    pendingQuestion: text('pending_question'),
    dryRun: boolean('dry_run').notNull().default(true),
    emailSentAt: timestamp('email_sent_at', { withTimezone: true }),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index('playground_runs_user_idx').on(table.userId, table.createdAt)],
)

/**
 * Everything said during a run, by anyone.
 *
 * Persisted rather than held in the socket because a run outlives a browser
 * tab: reopening a run has to show what was already said, and a question the
 * agent asked while nobody was watching still needs answering.
 */
export const playgroundMessages = pgTable(
  'playground_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => playgroundRuns.id, { onDelete: 'cascade' }),
    speaker: playgroundSpeakerEnum('speaker').notNull(),
    body: text('body').notNull(),
    /** Renders as a callout: `stuck`, `refused`, `success`. */
    kind: text('kind'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [index('playground_messages_run_idx').on(table.runId, table.createdAt)],
)

export type PlaygroundRun = typeof playgroundRuns.$inferSelect
export type PlaygroundMessage = typeof playgroundMessages.$inferSelect

/* ------------------------------------------------------------- applications */

/**
 * The job snapshot is denormalised into this table rather than joined from a
 * `jobs` table. Two reasons: the posting can vanish from the portal the day
 * after we apply and we still need to render the row, and the scraping
 * workstream owns the shape of raw postings — pinning it here would couple us
 * to a design that is still moving.
 */
export const applications = pgTable(
  'applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),

    role: text('role').notNull(),
    company: text('company').notNull(),
    /** Emoji stand-in for a company logo until logo fetching exists. */
    logo: text('logo').notNull().default('🏢'),
    location: text('location'),
    salary: text('salary'),
    jobUrl: text('job_url'),
    jobDescription: text('job_description'),
    /** The portal's own posting id, e.g. "JR-48210". */
    externalJobId: text('external_job_id'),

    portalId: text('portal_id').references(() => portals.id, { onDelete: 'set null' }),
    /** Display name captured at apply time, in case the portal row is removed. */
    portalName: text('portal_name'),

    matchScore: smallint('match_score'),
    status: applicationStatusEnum('status').notNull().default('queued'),

    resumeVariantId: uuid('resume_variant_id').references(() => resumes.id, {
      onDelete: 'set null',
    }),
    /** Denormalised filename so the list endpoint needs no join. */
    resumeVariantName: text('resume_variant_name'),

    huntRunId: uuid('hunt_run_id').references(() => huntRuns.id, { onDelete: 'set null' }),

    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().default(now),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    viewedAt: timestamp('viewed_at', { withTimezone: true }),
    interviewAt: timestamp('interview_at', { withTimezone: true }),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),

    notes: text('notes'),
    ...timestamps,
  },
  (table) => [
    index('applications_user_status_idx').on(table.userId, table.status),
    index('applications_user_applied_idx').on(table.userId, table.appliedAt),
    // Stops a retrying worker from double-applying to the same posting.
    uniqueIndex('applications_user_portal_job_idx')
      .on(table.userId, table.portalId, table.externalJobId)
      .where(sql`${table.externalJobId} is not null`),
    uniqueIndex('applications_user_job_idx')
      .on(table.userId, table.jobId)
      .where(sql`${table.jobId} is not null`),
  ],
)

/** Append-only audit of status transitions. Powers the timeline and the feed. */
export const applicationEvents = pgTable(
  'application_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    fromStatus: applicationStatusEnum('from_status'),
    toStatus: applicationStatusEnum('to_status').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [index('application_events_app_idx').on(table.applicationId, table.createdAt)],
)

/* ---------------------------------------------------------------- referrals */

export const linkedinConversations = pgTable(
  'linkedin_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    externalConversationId: text('external_conversation_id').notNull(),
    threadUrl: text('thread_url').notNull(),
    title: text('title').notNull(),
    scrapedAt: timestamp('scraped_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('linkedin_conversations_user_external_idx').on(table.userId, table.externalConversationId),
    index('linkedin_conversations_user_scraped_idx').on(table.userId, table.scrapedAt),
  ],
)

export const linkedinMessages = pgTable(
  'linkedin_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => linkedinConversations.id, { onDelete: 'cascade' }),
    externalMessageId: text('external_message_id').notNull(),
    body: text('body').notNull(),
    senderName: text('sender_name').notNull(),
    senderProfileUrl: text('sender_profile_url'),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    timestampRaw: text('timestamp_raw').notNull(),
    outbound: boolean('outbound').notNull().default(false),
    links: jsonb('links').notNull().default(sql`'[]'::jsonb`),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('linkedin_messages_user_external_idx').on(table.userId, table.externalMessageId),
    index('linkedin_messages_user_sent_idx').on(table.userId, table.sentAt),
    index('linkedin_messages_conversation_idx').on(table.conversationId, table.sentAt),
  ],
)

export const referrals = pgTable(
  'referrals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    requesterName: text('requester_name').notNull(),
    requesterHeadline: text('requester_headline'),
    requesterAvatar: text('requester_avatar').notNull().default('🙂'),
    requesterEmail: text('requester_email'),
    requesterProfileUrl: text('requester_profile_url'),

    source: referralSourceEnum('source').notNull(),
    /** Provider message id — the dedupe key for the daily inbox sweep. */
    externalMessageId: text('external_message_id'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().default(now),

    targetRole: text('target_role'),
    /** The requisition id they quoted, e.g. "JR-48210". */
    jobRequisitionId: text('job_requisition_id'),
    jobDescription: text('job_description'),

    resumeName: text('resume_name'),
    /** Object key in Supabase Storage, when they attached a file. */
    resumeStoragePath: text('resume_storage_path'),
    /** External link, when they sent a URL instead of a file. */
    resumeUrl: text('resume_url'),

    /** Their original message, verbatim. */
    note: text('note'),
    matchScore: smallint('match_score'),

    /** The generated recommendation, ready to copy and send. */
    draft: text('draft'),
    draftGeneratedAt: timestamp('draft_generated_at', { withTimezone: true }),
    draftModel: text('draft_model'),

    handled: boolean('handled').notNull().default(false),
    handledAt: timestamp('handled_at', { withTimezone: true }),

    ...timestamps,
  },
  (table) => [
    index('referrals_user_received_idx').on(table.userId, table.receivedAt),
    index('referrals_user_handled_idx').on(table.userId, table.handled),
    uniqueIndex('referrals_external_message_idx')
      .on(table.userId, table.source, table.externalMessageId)
      .where(sql`${table.externalMessageId} is not null`),
  ],
)

/* ----------------------------------------------------------------- activity */

/** "Hunty's trail" on the Den screen. Written by every module that does work. */
export const activityEvents = pgTable(
  'activity_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: activityKindEnum('kind').notNull(),
    emoji: text('emoji').notNull().default('🐾'),
    text: text('text').notNull(),
    /** Anything the row wants to link to: { applicationId, referralId, ... }. */
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [index('activity_events_user_idx').on(table.userId, table.createdAt)],
)

/* ---------------------------------------------------------------- relations */

export const usersRelations = relations(users, ({ one, many }) => ({
  kit: one(kits, { fields: [users.id], references: [kits.userId] }),
  huntSpec: one(huntSpecs, { fields: [users.id], references: [huntSpecs.userId] }),
  employments: many(employments),
  resumes: many(resumes),
  applications: many(applications),
  referrals: many(referrals),
  activityEvents: many(activityEvents),
  userPortals: many(userPortals),
  huntRuns: many(huntRuns),
}))

export const kitsRelations = relations(kits, ({ one }) => ({
  user: one(users, { fields: [kits.userId], references: [users.id] }),
}))

export const employmentsRelations = relations(employments, ({ one }) => ({
  user: one(users, { fields: [employments.userId], references: [users.id] }),
}))

export const resumesRelations = relations(resumes, ({ one, many }) => ({
  user: one(users, { fields: [resumes.userId], references: [users.id] }),
  applications: many(applications),
}))

export const portalsRelations = relations(portals, ({ many }) => ({
  userPortals: many(userPortals),
}))

export const userPortalsRelations = relations(userPortals, ({ one }) => ({
  user: one(users, { fields: [userPortals.userId], references: [users.id] }),
  portal: one(portals, { fields: [userPortals.portalId], references: [portals.id] }),
}))

export const applicationsRelations = relations(applications, ({ one, many }) => ({
  user: one(users, { fields: [applications.userId], references: [users.id] }),
  portal: one(portals, { fields: [applications.portalId], references: [portals.id] }),
  resumeVariant: one(resumes, {
    fields: [applications.resumeVariantId],
    references: [resumes.id],
  }),
  events: many(applicationEvents),
}))

export const applicationEventsRelations = relations(applicationEvents, ({ one }) => ({
  application: one(applications, {
    fields: [applicationEvents.applicationId],
    references: [applications.id],
  }),
}))

export const referralsRelations = relations(referrals, ({ one }) => ({
  user: one(users, { fields: [referrals.userId], references: [users.id] }),
}))

export const huntRunsRelations = relations(huntRuns, ({ one, many }) => ({
  user: one(users, { fields: [huntRuns.userId], references: [users.id] }),
  applications: many(applications),
}))

/* -------------------------------------------------------------------- inbox */

/**
 * A connected mailbox.
 *
 * `kind` is the seam between the two ways of reading mail. `gmail-oauth` uses
 * the API and needs a Google security assessment before it can serve the
 * public; `forwarding` needs no OAuth at all — the user sets one Gmail filter
 * and job mail arrives at an address we own. The consumer does not care which.
 */
export const emailAccounts = pgTable(
  'email_accounts',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('gmail-oauth'),
    address: text('address').notNull(),
    /** Encrypted under the user's own data key, like every other credential. */
    encryptedCredentials: text('encrypted_credentials'),
    /** Gmail's `historyId`, so each poll reads only what is new. */
    cursor: text('cursor'),
    status: text('status').notNull().default('pending'),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.userId] })],
)

/**
 * One classified message.
 *
 * The body is deliberately not stored — only what was extracted from it. This
 * table exists to answer "did anyone reply about my applications", and keeping
 * the full text of someone's mail to answer that would be a much larger
 * promise than the feature needs.
 */
export const emailMessages = pgTable(
  'email_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    fromAddress: text('from_address').notNull(),
    fromDomain: text('from_domain').notNull(),
    subject: text('subject').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    /** interview_invite · assessment · rejection · recruiter_outreach · application_ack · other */
    classification: text('classification').notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull().default('0'),
    company: text('company'),
    role: text('role'),
    nextStep: text('next_step'),
    /** When the mail names a date — an interview slot, a deadline. */
    happensAt: timestamp('happens_at', { withTimezone: true }),
    applicationId: uuid('application_id').references(() => applications.id, { onDelete: 'set null' }),
    /** How the application was matched: `ats_domain`, `company`, `url`, or null. */
    matchedBy: text('matched_by'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('email_messages_user_external_idx').on(table.userId, table.externalId),
    index('email_messages_user_received_idx').on(table.userId, table.receivedAt),
  ],
)

/**
 * One feed for everything that wants a person's attention — mail, a blocked
 * application, a finished run, a referral.
 *
 * One table rather than four because the user has one attention span, and
 * four separate "what happened" surfaces is how the important one gets missed.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `interview` · `assessment` · `rejection` · `blocked_application` · `run_finished` · `referral` */
    kind: text('kind').notNull(),
    /** `now` needs a person today; `soon` this week; `fyi` never interrupts. */
    urgency: text('urgency').notNull().default('fyi'),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    emailMessageId: uuid('email_message_id').references(() => emailMessages.id, { onDelete: 'cascade' }),
    applicationId: uuid('application_id').references(() => applications.id, { onDelete: 'set null' }),
    readAt: timestamp('read_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index('notifications_user_idx').on(table.userId, table.readAt, table.createdAt)],
)

/* ----------------------------------------------------------------- outreach */

/** "Get me referred at X" — one row per company the user is aiming at. */
export const outreachTargets = pgTable(
  'outreach_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    company: text('company').notNull(),
    /** The role they want, which sets who is worth asking. */
    targetRole: text('target_role'),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    /** `active` | `paused` | `done`. */
    status: text('status').notNull().default('active'),
    ...timestamps,
  },
  (table) => [index('outreach_targets_user_idx').on(table.userId, table.status)],
)

/**
 * A person who could refer this user, and how far the conversation has got.
 *
 * `signals` holds what made them rank: shared employer, shared school, mutual
 * connections, how recently they joined. Kept so the draft can name a real
 * shared fact rather than opening with "hi".
 */
export const outreachProspects = pgTable(
  'outreach_prospects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetId: uuid('target_id')
      .notNull()
      .references(() => outreachTargets.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    profileUrl: text('profile_url').notNull(),
    name: text('name').notNull(),
    title: text('title'),
    /** 1, 2 or 3. First-degree skips the invite entirely. */
    degree: smallint('degree').notNull().default(3),
    signals: jsonb('signals').notNull().default(sql`'{}'::jsonb`),
    score: smallint('score').notNull().default(0),
    /** identified · drafted · approved · invited · accepted · asked · referred · declined · withdrawn */
    state: text('state').notNull().default('identified'),
    invitedAt: timestamp('invited_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    askedAt: timestamp('asked_at', { withTimezone: true }),
    outcome: text('outcome'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('outreach_prospects_target_profile_idx').on(table.targetId, table.profileUrl),
    index('outreach_prospects_state_idx').on(table.userId, table.state),
  ],
)

/**
 * Drafted messages. Nothing sends without `approvedAt`.
 *
 * That column is the whole safety model: the send path checks it before
 * anything else, so a message nobody agreed to cannot leave regardless of what
 * the rest of the engine decides.
 */
export const outreachMessages = pgTable(
  'outreach_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    prospectId: uuid('prospect_id')
      .notNull()
      .references(() => outreachProspects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `invite` | `ask` | `followup`. */
    kind: text('kind').notNull(),
    body: text('body').notNull(),
    /** The one true, checkable thing this message opens with. */
    basedOn: text('based_on'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index('outreach_messages_prospect_idx').on(table.prospectId, table.kind)],
)

/**
 * The account-health strip, and the circuit breaker's state.
 *
 * If this engine is ever quietly damaging someone's LinkedIn account, the
 * acceptance rate is where it shows up first — which is why it is a stored
 * counter rather than something computed only when asked.
 */
export const accountHealth = pgTable(
  'account_health',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    portalId: text('portal_id').notNull(),
    invites7d: smallint('invites_7d').notNull().default(0),
    invitesToday: smallint('invites_today').notNull().default(0),
    accepted7d: smallint('accepted_7d').notNull().default(0),
    challenges30d: smallint('challenges_30d').notNull().default(0),
    /** Set by the breaker after a checkpoint. Nothing sends while it is future. */
    pausedUntil: timestamp('paused_until', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.userId, table.portalId] })],
)

/* -------------------------------------------------------------------- apply */

/**
 * Every state an application attempt passed through.
 *
 * The apply function used to be a straight line: fill, submit, hope. When it
 * stopped somewhere it wrote `needs_review` and nothing about *where* or
 * *why* — so a user learned their application had failed, and could not learn
 * anything else. These rows are what the live view renders and what the audit
 * trail reads.
 */
export const attemptEvents = pgTable(
  'attempt_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => applyAttempts.id, { onDelete: 'cascade' }),
    /** `queued`, `opening`, `filling`, `blocked`, `submitting`, `submitted`, `failed`. */
    state: text('state').notNull(),
    /** For `blocked`: `needs_input`, `captcha`, `login_required`, `unknown_field`. */
    reason: text('reason'),
    detail: jsonb('detail'),
    at: timestamp('at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [index('attempt_events_attempt_idx').on(table.attemptId, table.at)],
)

/**
 * Answers to form questions, keyed by where they were asked.
 *
 * This is the compounding asset. Every application form invents its own
 * phrasing for the same handful of questions, and the expensive part is not
 * filling a field — it is working out what a field is asking. Answer it once
 * and it is answered forever, for this user and, where the answer is not
 * personal, for everyone.
 *
 * A null `userId` marks the shared anonymised layer: the *mapping* from a
 * strange question to a known field, never the value.
 */
export const fieldAnswers = pgTable(
  'field_answers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null for the shared layer — a mapping rather than a personal answer. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** `boards.greenhouse.io`, `jobs.lever.co`, … */
    host: text('host').notNull(),
    /** Stable hash of the field's label, name and type. */
    fieldSignature: text('field_signature').notNull(),
    /** The label as the form wrote it, for the review screen. */
    label: text('label').notNull(),
    /** Which persona/kit field this question maps to, when it maps to one. */
    mapsTo: text('maps_to'),
    /** The value to fill. Null on shared rows, which carry only the mapping. */
    value: text('value'),
    /** False until a human has agreed with it. */
    confirmed: boolean('confirmed').notNull().default(false),
    timesUsed: integer('times_used').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('field_answers_scope_idx').on(table.userId, table.host, table.fieldSignature),
    index('field_answers_host_idx').on(table.host, table.fieldSignature),
  ],
)

/* ------------------------------------------------------------------ persona */

/**
 * The persona, one attribute per row.
 *
 * The onboarding wizard used to ask a fixed set of questions regardless of
 * what the resume had already revealed, and half of what it asked — phone,
 * notice period, CTC — buys no matching accuracy at all. It is needed to fill
 * a form, later, once.
 *
 * A slot carries where its value came from and how sure we are. That is what
 * makes the intake adaptive: a question is only ever asked about a slot that
 * is both uncertain *and* changes which jobs the user would see.
 */
export const personaSlots = pgTable(
  'persona_slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `target_titles`, `seniority`, `location_mode`, `must_have_stack`, … */
    slot: text('slot').notNull(),
    /** Shape depends on the slot; the slot catalogue owns the contract. */
    value: jsonb('value').notNull(),
    /** 0–1. Below ~0.6 the slot is a candidate for being asked about. */
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull().default('0'),
    /** `resume` | `asked` | `inferred` | `default`. */
    source: text('source').notNull().default('default'),
    ...timestamps,
  },
  (table) => [uniqueIndex('persona_slots_user_slot_idx').on(table.userId, table.slot)],
)

/**
 * Labelled preferences, for learning what this person actually wants.
 *
 * Two kinds feed it. Pairwise choices during intake — "which of these two
 * would you take?" — which extract trade-offs people cannot reliably
 * self-report on a form. And every approve or reject on the Hunt screen, which
 * is a labelled example the product was already generating and throwing away.
 *
 * The feature vector is the same `scoreBreakdown` the scorer already stores, so
 * this is mostly a matter of reading what we already write.
 */
export const preferenceEvents = pgTable(
  'preference_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `pairwise` | `approve` | `reject`. */
    kind: text('kind').notNull(),
    /** For pairwise: the chosen job's features minus the rejected one's. */
    features: jsonb('features').notNull(),
    /** 1 = wanted, 0 = not. */
    label: smallint('label').notNull(),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    comparedJobId: uuid('compared_job_id').references(() => jobs.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [index('preference_events_user_idx').on(table.userId, table.createdAt)],
)

/**
 * One intake session: which questions were asked, in order, and what came back.
 *
 * Kept so the budget is auditable. "We promised at most seven questions" is a
 * claim that needs evidence, and the median is the number that matters.
 */
export const intakeSessions = pgTable(
  'intake_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    asked: jsonb('asked').notNull().default(sql`'[]'::jsonb`),
    questionsAsked: smallint('questions_asked').notNull().default(0),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index('intake_sessions_user_idx').on(table.userId)],
)

/* ---------------------------------------------------------------- discovery */

/**
 * Company job boards, resolved at runtime.
 *
 * This replaces the hardcoded arrays that used to live in
 * `hunt/discovery/boards.ts`. Those arrays were the reason discovery had a
 * fixed universe: about 110 companies, chosen once, the same for every user.
 * A board here can be seeded from a user's dream companies or learned from a
 * search result, and `lastOkAt` / `lastJobCount` let a dead token be retired
 * instead of costing a request and a warning on every run.
 */
export const companyBoards = pgTable(
  'company_boards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** `greenhouse`, `lever`, `ashby`, `smartrecruiters`, `workable`. */
    ats: text('ats').notNull(),
    /** The board slug in that ATS's URL, e.g. `stripe`. */
    token: text('token').notNull(),
    /** Display name; the posting usually carries a better one. */
    company: text('company').notNull(),
    /** `seed` | `dream-company` | `search-result` | `manual`. */
    source: text('source').notNull().default('seed'),
    isActive: boolean('is_active').notNull().default(true),
    lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastJobCount: integer('last_job_count'),
    consecutiveFailures: smallint('consecutive_failures').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('company_boards_ats_token_idx').on(table.ats, table.token),
    index('company_boards_active_idx').on(table.isActive, table.ats),
  ],
)

/**
 * Every query a run issued, and what came back.
 *
 * Exists to answer "why didn't I see job X". Without it, discovery is a black
 * box: the user's roles and locations went in, some jobs came out, and nothing
 * connects the two.
 */
export const searchQueries = pgTable(
  'search_queries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => huntRuns.id, { onDelete: 'cascade' }),
    connectorId: text('connector_id').notNull(),
    /** The literal keyword string sent to the source. */
    query: text('query').notNull(),
    /** ISO-3166 alpha-2, or `remote`, or null for a global crawl. */
    market: text('market'),
    resultCount: integer('result_count').notNull().default(0),
    durationMs: integer('duration_ms'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [index('search_queries_run_idx').on(table.runId, table.connectorId)],
)

/**
 * Cached semantic judgement of one posting against one version of a persona.
 *
 * Keyed on the description hash rather than the job id so the same posting
 * republished by a second source reuses the verdict, and on the persona
 * version so editing the hunt spec invalidates it.
 */
export const jobReranks = pgTable(
  'job_reranks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    descriptionHash: text('description_hash').notNull(),
    personaVersion: text('persona_version').notNull(),
    /** 0–100, the model's own view of fit. */
    fit: smallint('fit').notNull(),
    rationale: text('rationale').notNull(),
    /** The strongest reason this is a bad match, always populated. */
    whyNot: text('why_not'),
    model: text('model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex('job_reranks_hash_persona_idx').on(table.descriptionHash, table.personaVersion),
  ],
)

/* ----------------------------------------------------------------- key wrap */

/**
 * One data-encryption key per user, stored wrapped by the deployment's master
 * key (`PORTAL_CREDENTIALS_KEY`).
 *
 * Before this, one key encrypted every user's LinkedIn session and portal
 * password. That is adequate for a single-tenant tool and wrong for a hosted
 * one: it makes one compromise a compromise of everybody, and it makes key
 * rotation a full re-encrypt of every secret in the database. With per-user
 * keys, rotating the master key only re-wraps this table — the ciphertext of
 * the credentials themselves never has to be touched.
 */
export const userKeys = pgTable('user_keys', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** The user's DEK, encrypted under the master key. Never logged. */
  wrappedDek: text('wrapped_dek').notNull(),
  /** Which master key wrapped it, so a rotation can find what to re-wrap. */
  masterKeyId: text('master_key_id').notNull().default('default'),
  ...timestamps,
})

/* ------------------------------------------------------------- scheduling */

/**
 * When each user's daily jobs run, in their own timezone.
 *
 * This table is what replaced the `setInterval` that used to live inside the
 * web process. The worker reads it at boot and registers one BullMQ repeatable
 * job per enabled queue per user, keyed `daily:<queue>:<userId>` — and because
 * repeatable keys are idempotent, every replica may register and exactly one
 * fires.
 */
export const userSchedules = pgTable('user_schedules', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),

  /** 0–23, interpreted in `timezone`. */
  runHourLocal: smallint('run_hour_local').notNull().default(7),
  /** IANA name. Defaults to the deployment's APP_TIMEZONE at row creation. */
  timezone: text('timezone').notNull().default('Asia/Kolkata'),

  discoverEnabled: boolean('discover_enabled').notNull().default(true),
  inboxEnabled: boolean('inbox_enabled').notNull().default(false),
  referralEnabled: boolean('referral_enabled').notNull().default(false),
  /** Outbound outreach is off until the user opts in. See docs/outreach.md. */
  outreachEnabled: boolean('outreach_enabled').notNull().default(false),

  lastDiscoverAt: timestamp('last_discover_at', { withTimezone: true }),
  lastInboxAt: timestamp('last_inbox_at', { withTimezone: true }),
  lastReferralAt: timestamp('last_referral_at', { withTimezone: true }),

  ...timestamps,
})

/* ----------------------------------------------------------- model metering */

/**
 * One row per model call, written by the gateway and by nothing else.
 *
 * This exists from the first model call rather than after pricing is settled:
 * retrofitting cost accounting once a plan is already sold is how a flat fee
 * quietly stops covering its own costs.
 */
export const modelUsage = pgTable(
  'model_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** `rerank`, `classify-email`, `map-field`, `draft-referral`, … */
    purpose: text('purpose').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    /** Six decimal places: a single call can cost a small fraction of a cent. */
    usd: numeric('usd', { precision: 12, scale: 6 }).notNull().default('0'),
    durationMs: integer('duration_ms'),
    ok: boolean('ok').notNull().default(true),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index('model_usage_user_created_idx').on(table.userId, table.createdAt),
    index('model_usage_purpose_idx').on(table.purpose, table.createdAt),
  ],
)

/* -------------------------------------------------------------------- types */

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Kit = typeof kits.$inferSelect
export type Employment = typeof employments.$inferSelect
export type Resume = typeof resumes.$inferSelect
export type Portal = typeof portals.$inferSelect
export type UserPortal = typeof userPortals.$inferSelect
export type HuntSpec = typeof huntSpecs.$inferSelect
export type HuntRun = typeof huntRuns.$inferSelect
export type Job = typeof jobs.$inferSelect
export type JobSource = typeof jobSources.$inferSelect
export type HuntCandidate = typeof huntCandidates.$inferSelect
export type HuntRunJob = typeof huntRunJobs.$inferSelect
export type ResumeVariant = typeof resumeVariants.$inferSelect
export type PortalAccount = typeof portalAccounts.$inferSelect
export type ApplyAttempt = typeof applyAttempts.$inferSelect
export type Application = typeof applications.$inferSelect
export type ApplicationEvent = typeof applicationEvents.$inferSelect
export type Referral = typeof referrals.$inferSelect
export type LinkedInConversation = typeof linkedinConversations.$inferSelect
export type LinkedInMessage = typeof linkedinMessages.$inferSelect
export type ActivityEvent = typeof activityEvents.$inferSelect
export type UserSchedule = typeof userSchedules.$inferSelect
export type NewUserSchedule = typeof userSchedules.$inferInsert
export type ModelUsage = typeof modelUsage.$inferSelect
export type CompanyBoard = typeof companyBoards.$inferSelect
export type NewCompanyBoard = typeof companyBoards.$inferInsert
export type SearchQueryRow = typeof searchQueries.$inferSelect
export type JobRerank = typeof jobReranks.$inferSelect
export type PersonaSlot = typeof personaSlots.$inferSelect
export type NewPersonaSlot = typeof personaSlots.$inferInsert
export type PreferenceEvent = typeof preferenceEvents.$inferSelect
export type IntakeSession = typeof intakeSessions.$inferSelect
export type AttemptEvent = typeof attemptEvents.$inferSelect
export type FieldAnswer = typeof fieldAnswers.$inferSelect
export type NewFieldAnswer = typeof fieldAnswers.$inferInsert
export type OutreachTarget = typeof outreachTargets.$inferSelect
export type OutreachProspect = typeof outreachProspects.$inferSelect
export type NewOutreachProspect = typeof outreachProspects.$inferInsert
export type OutreachMessage = typeof outreachMessages.$inferSelect
export type AccountHealth = typeof accountHealth.$inferSelect
export type EmailAccount = typeof emailAccounts.$inferSelect
export type EmailMessage = typeof emailMessages.$inferSelect
export type NewEmailMessage = typeof emailMessages.$inferInsert
export type Notification = typeof notifications.$inferSelect

export type ApplicationStatus = (typeof applicationStatusEnum.enumValues)[number]
export type ReferralSource = (typeof referralSourceEnum.enumValues)[number]
export type ActivityKind = (typeof activityKindEnum.enumValues)[number]
