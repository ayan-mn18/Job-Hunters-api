/**
 * The contract every portal adapter emits, and the interface every adapter
 * implements. These two shapes are the whole point of the spike: if they hold
 * up across a JSON API, an RSS feed and a multi-tenant ATS, they will hold up
 * for the portals we add later.
 */

export type PortalId = string

/**
 * How much we trust `postedAt`.
 *
 * - `exact`          portal gave a real timestamp (ISO 8601 or epoch).
 * - `day`            portal gave a date with no time component.
 * - `relative`       portal gave "3 days ago" / "yesterday" and we resolved it
 *                    against the fetch time. Good to roughly an hour at best.
 * - `first-seen`     portal gave nothing usable. This is the timestamp at which
 *                    our crawler first observed the posting. Only meaningful
 *                    once the seen-store has been running longer than the
 *                    freshness window, so brand new installs must not trust it.
 */
export type PostedAtPrecision = 'exact' | 'day' | 'relative' | 'first-seen'

/** How the portal behaves toward automated clients, recorded per adapter. */
export type LegalPosture =
  /** Documented public API or feed whose terms permit this use. */
  | 'sanctioned'
  /** Public data, no explicit API, robots.txt does not forbid the path. */
  | 'permitted-by-robots'
  /** No clear permission, no clear prohibition. Judgement call. */
  | 'grey'
  /** Terms forbid automated access. Real account-ban or legal risk. */
  | 'prohibited'

export type RemoteMode = 'remote' | 'hybrid' | 'onsite' | 'unknown'

export interface SalaryRange {
  min?: number
  max?: number
  currency?: string
  period?: 'year' | 'month' | 'day' | 'hour'
  raw?: string
}

export interface NormalisedLocation {
  raw: string
  city?: string
  country?: string
  /** ISO 3166-1 alpha-2, uppercase. Drives the user's Gulf/India/remote filters. */
  countryCode?: string
  isRemote: boolean
}

/**
 * One posting, normalised. Adapters emit this and nothing else — everything
 * downstream (scoring, resume tailoring, applying) reads only this shape, so a
 * new portal never leaks its quirks past its own adapter file.
 */
export interface ScrapedJob {
  /** Stable id as the portal knows it. Unique within `portal`, not globally. */
  sourceId: string
  portal: PortalId
  /** Canonical human-facing posting URL. */
  url: string
  /** Where the application actually happens, when it differs from `url`. */
  applyUrl?: string

  title: string
  company: string
  /** Used for cross-portal dedupe when company names are spelt differently. */
  companyDomain?: string

  locations: NormalisedLocation[]
  remote: RemoteMode
  employmentType?: string

  descriptionHtml?: string
  descriptionText?: string
  tags: string[]
  salary?: SalaryRange

  /** ISO 8601, always UTC. Read alongside `postedAtPrecision`. */
  postedAt: string
  postedAtPrecision: PostedAtPrecision
  /** ISO 8601, always UTC. When our crawler pulled this record. */
  fetchedAt: string

  /**
   * Content hash used to collapse the same role listed on several portals.
   * See `dedupe.ts` for what goes into it.
   */
  fingerprint: string

  /** Untouched portal payload, kept for debugging and re-parsing. */
  raw?: unknown
}

export interface AdapterContext {
  /** Only postings at or after this instant survive. UTC. */
  since: Date
  /** Wall clock for this run, used to resolve relative dates. UTC. */
  now: Date
  /** Cap per adapter so one portal cannot dominate a run. */
  maxItems: number
  log: (msg: string, extra?: Record<string, unknown>) => void
}

export interface AdapterResult {
  portal: PortalId
  /** Everything the adapter saw, before the freshness filter. */
  seen: number
  /** Survived the freshness filter. */
  jobs: ScrapedJob[]
  /**
   * Non-fatal problems: a sub-feed 404'd, a field went missing, markup moved.
   * The runner surfaces these — they are the early warning that a portal
   * changed its HTML under us.
   */
  warnings: string[]
  /** Set when the adapter could not run at all. */
  error?: string
  durationMs: number
}

export interface PortalAdapter {
  readonly id: PortalId
  readonly label: string
  /**
   * 1 = official API or feed. 2 = plain HTTP + HTML parse.
   * 3 = headless browser required.
   */
  readonly tier: 1 | 2 | 3
  readonly legal: LegalPosture
  /** Short note on why `legal` is what it is. Shown in the run report. */
  readonly legalNote: string
  fetchRecent(ctx: AdapterContext): Promise<AdapterResult>
}
