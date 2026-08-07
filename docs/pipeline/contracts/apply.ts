/**
 * Apply-step contracts.
 *
 * One `PortalAdapter` interface, several implementations with very different
 * mechanics behind it (public API, authenticated API, ATS vendor form, browser
 * automation). The pipeline does not know or care which it got.
 *
 * See ../04-apply-step.md. Portal-by-portal specifics are the scraping agent's
 * territory; this file only fixes the seam.
 */

import type { FailureClass } from './pipeline'

/* -------------------------------------------------------------- the kit -- */

/**
 * Every answer a job form has ever asked for, filled once. Mirrors the
 * "My Kit" screen. Values are canonical; adapters coerce to a portal's
 * expected shape (dropdown option, radio, boolean, formatted string).
 */
export interface KitAnswers {
  personal: {
    fullName: string
    firstName: string
    lastName: string
    pronouns?: string
    email: string
    phone: { countryCode: string; national: string }
    dateOfBirth?: string
  }
  address: {
    line1: string
    line2?: string
    city: string
    region: string
    postalCode: string
    country: string
  }
  links: {
    linkedin?: string
    github?: string
    portfolio?: string
    other?: { label: string; url: string }[]
  }
  employment: {
    totalExperienceMonths: number
    currentEmployer?: string
    currentTitle?: string
    noticePeriodDays: number
    /** Minor units, to avoid float money. */
    currentCtc?: { amount: number; currency: string; period: 'year' | 'month' }
    expectedCtc?: { amount: number; currency: string; period: 'year' | 'month' }
    servingNoticePeriod: boolean
  }
  authorization: {
    /** ISO country codes the user may work in without sponsorship. */
    workAuthorizedIn: string[]
    requiresSponsorship: boolean
    /** Free text for the "explain your status" boxes. */
    statement: string
  }
  preferences: {
    willingToRelocate: boolean
    relocationNote?: string
    openToRemote: boolean
    earliestStartDate?: string
    preferredLocations: string[]
  }
  /** EEO / diversity questions. Default to declining to answer. */
  voluntaryDisclosures: {
    gender?: string
    ethnicity?: string
    veteranStatus?: string
    disabilityStatus?: string
    preferNotToSay: boolean
  }
  /**
   * Reusable prose for open-text questions ("why this company?"). Keyed by a
   * normalised question fingerprint so answers accrete rather than being
   * re-invented per application.
   */
  narrativeAnswers: Record<string, string>
}

/* ------------------------------------------------------------ field map -- */

export type FieldValueKind =
  | 'text'
  | 'longtext'
  | 'number'
  | 'boolean'
  | 'date'
  | 'select'
  | 'multiselect'
  | 'file'

export interface DiscoveredField {
  /** Adapter-scoped stable handle: a CSS selector, an API field name, an id. */
  handle: string
  label: string
  kind: FieldValueKind
  required: boolean
  options?: { value: string; label: string }[]
  maxLength?: number
}

/**
 * The join between a form field and the Kit. `path` is a dotted path into
 * KitAnswers; `confidence` below `autoFillThreshold` means the field is left
 * blank and the application is parked for review rather than guessed at.
 */
export interface FieldMapping {
  handle: string
  path: string | null
  value: string | number | boolean | string[] | null
  confidence: number
  source: 'kit' | 'resume' | 'narrative' | 'default' | 'unmapped'
}

export interface FieldMapResult {
  mappings: FieldMapping[]
  /** Required fields we could not fill. Non-empty ⇒ do not submit. */
  unresolvedRequired: DiscoveredField[]
  /**
   * Questions with no Kit answer that the user should add. Fed back into the
   * My Kit screen so the same form never blocks twice.
   */
  newQuestions: { fingerprint: string; label: string; kind: FieldValueKind }[]
}

/* --------------------------------------------------------------- adapter -- */

export type PortalMechanism =
  | 'public_api' // documented, keyed API. Fully supported.
  | 'partner_api' // API behind an application/partner agreement.
  | 'email' // the posting says "email your resume to …".
  | 'ats_form' // Greenhouse/Lever/Ashby-style hosted form, no login needed.
  | 'authenticated_form' // logged-in session on the portal itself.
  | 'browser_automation' // headless browser driving a UI never meant for it.

/**
 * Honest per-portal risk, surfaced in the UI so the user chooses per portal
 * rather than accepting one global gamble.
 */
export type BanRisk =
  | 'none' // sanctioned path, nothing to ban
  | 'low' // ToS-tolerated in practice; throttling is the worst case
  | 'medium' // ToS-prohibited, detection plausible, account recoverable
  | 'high' // active anti-automation; account loss is the expected outcome

export interface PortalCapabilities {
  portal: string
  mechanism: PortalMechanism
  banRisk: BanRisk
  /** Requires the user to complete an OAuth or credential handshake first. */
  requiresSession: boolean
  /** Many postings redirect off-portal; adapter must follow to the real form. */
  redirectsToAts: boolean
  supportsResumeUpload: boolean
  supportsCoverLetter: boolean
  /** Some portals answer "did they view it?"; drives the Applications screen. */
  supportsStatusPolling: boolean
  /** Below this we stop; the user's daily target does not override it. */
  recommendedDailyCap: number
  notes: string
}

export interface ApplyRequest {
  applicationId: string
  runId: string
  userId: string
  portal: string
  jobUrl: string
  portalJobId: string
  /** Local path to the rendered PDF. The adapter must not persist it. */
  resumePdfPath: string
  resumeFileName: string
  kit: KitAnswers
  coverLetter?: string
  /** Dry run: discover and map fields, never click submit. */
  simulate: boolean
}

export type ApplyStatus =
  | 'submitted'
  | 'already_applied'
  | 'needs_review' // parked: unresolved required fields or a question we won't guess
  | 'blocked' // captcha, bot wall, hard rate limit
  | 'auth_expired'
  | 'closed' // posting gone or filled
  | 'failed'

export interface ApplyOutcome {
  applicationId: string
  status: ApplyStatus
  /** Portal's own reference, when it gives one. */
  externalApplicationId?: string
  submittedAt?: string
  /** What we actually sent, for the audit trail. Values redacted per policy. */
  submittedFields: { handle: string; label: string; redactedValue: string }[]
  unresolvedRequired: DiscoveredField[]
  /** Confirmation screenshot path, kept only until the outcome is persisted. */
  evidencePath?: string
  failure?: { classification: FailureClass; message: string }
  durationMs: number
}

/**
 * The seam. Adding a portal means implementing this and registering
 * capabilities — nothing in the pipeline changes.
 */
export interface PortalAdapter {
  readonly capabilities: PortalCapabilities

  /** Cheap liveness + session check. Run before a lane opens for the day. */
  health(userId: string): Promise<{ ok: boolean; reason?: string }>

  /** Fetch postings first seen since `since`. Paginated by the adapter. */
  discover(input: {
    userId: string
    since: string
    roles: string[]
    locations: string[]
    cursor?: string
  }): Promise<{ postings: import('./pipeline').RawPosting[]; cursor?: string }>

  /** Full JD text for a posting whose listing entry was truncated. */
  fetchDescription(jobUrl: string): Promise<string>

  /** Open the application form and report its fields without filling anything. */
  discoverFields(input: ApplyRequest): Promise<DiscoveredField[]>

  /** Fill and (unless `simulate`) submit. Must be safe to call twice. */
  submit(input: ApplyRequest, mapped: FieldMapResult): Promise<ApplyOutcome>

  /** Optional: has the employer viewed / rejected / advanced the application? */
  pollStatus?(input: {
    userId: string
    externalApplicationId: string
  }): Promise<{ status: string; changedAt: string } | null>
}
