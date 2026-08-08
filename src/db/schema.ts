import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
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
    descriptionText: text('description_text'),
    descriptionHash: text('description_hash'),
    canonicalUrl: text('canonical_url').notNull(),
    applyUrl: text('apply_url'),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull(),
    postedAtPrecision: text('posted_at_precision').notNull(),
    skills: text('skills').array().notNull().default(sql`'{}'::text[]`),
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
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index('apply_attempts_candidate_idx').on(table.candidateId, table.createdAt)],
)

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
export type ActivityEvent = typeof activityEvents.$inferSelect

export type ApplicationStatus = (typeof applicationStatusEnum.enumValues)[number]
export type ReferralSource = (typeof referralSourceEnum.enumValues)[number]
export type ActivityKind = (typeof activityKindEnum.enumValues)[number]
