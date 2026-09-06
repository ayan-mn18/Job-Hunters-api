export type PostedAtPrecision = 'exact' | 'day' | 'first-seen'
export type RemoteMode = 'remote' | 'hybrid' | 'onsite' | 'unknown'
export type EmploymentType =
  | 'full_time'
  | 'part_time'
  | 'contract'
  | 'internship'
  | 'temporary'
  | 'unknown'

export interface NormalisedLocation {
  raw: string
  city?: string
  country?: string
  countryCode?: string
  isRemote: boolean
}

export type SalaryPeriod = 'hour' | 'day' | 'week' | 'month' | 'year'

export interface RawSalary {
  min: number | null
  max: number | null
  currency: string | null
  period: SalaryPeriod | null
  /** Verbatim string as the posting wrote it, when there was one. */
  text: string | null
}

export interface ExperienceRange {
  min: number | null
  max: number | null
  /** The phrase the numbers came from, so a bad parse can be traced. */
  text: string | null
}

/**
 * How a field arrived. `source` beats `jsonld` beats `parsed`, and the UI can
 * show a caveat on anything below ~0.5.
 */
export interface FieldProvenance {
  method: 'source' | 'jsonld' | 'parsed' | 'derived'
  confidence: number
  sourceField?: string
}

export type ExtractionMeta = Record<string, FieldProvenance>

/** What the detail stage adds on top of a list-stage stub. */
export interface JobDetail {
  descriptionHtml?: string
  descriptionText?: string
  employmentType?: EmploymentType
  salary?: RawSalary
  experience?: ExperienceRange
  skills?: string[]
  responsibilities?: string[]
  locationText?: string
  remote?: RemoteMode
  applyUrl?: string
  postedAt?: string
  meta?: ExtractionMeta
}

export interface ScrapedJob {
  sourceId: string
  portal: string
  url: string
  applyUrl?: string
  title: string
  company: string
  locations: NormalisedLocation[]
  remote: RemoteMode
  employmentType: EmploymentType
  descriptionText?: string
  descriptionHtml?: string
  responsibilities: string[]
  skills: string[]
  experience: ExperienceRange
  salary: RawSalary
  tags: string[]
  postedAt: string
  postedAtPrecision: PostedAtPrecision
  fetchedAt: string
  fingerprint: string
  extractionMeta: ExtractionMeta
  /** True when the detail stage ran and returned a usable description. */
  detailFetched: boolean
  raw?: unknown
}

/** A list-stage result, before the detail stage enriches it. */
export interface JobStub {
  sourceId: string
  portal: string
  url: string
  applyUrl?: string
  title: string
  company: string
  locationText: string
  remote?: RemoteMode
  employmentType?: EmploymentType
  descriptionHtml?: string
  descriptionText?: string
  tags: string[]
  postedAt: string
  postedAtPrecision: PostedAtPrecision
  salary?: RawSalary
  /** Detail URL, when it differs from the human-facing `url`. */
  detailUrl?: string
  raw?: unknown
}

/**
 * One keyword search, aimed at one market.
 *
 * Crawl sources (an ATS board, a remote-jobs feed) ignore these and list
 * whatever is recent. Search sources issue one request per query. This is the
 * half of discovery that was missing: the user's roles and locations were only
 * ever used to *score* results that had already arrived, never to ask for
 * them.
 */
export interface SearchQuery {
  /** What to search for, e.g. "backend engineer". */
  keywords: string
  /** ISO-3166 alpha-2, or `remote`, or null for "wherever". */
  market: string | null
  /** Human-readable location to pass through when the source takes one. */
  locationText?: string
  remoteOnly?: boolean
}

export interface DiscoveryContext {
  since: Date
  now: Date
  maxItems: number
  /** The run's query plan. Undefined for crawl-only runs. */
  queries?: SearchQuery[]
  /** Recorded against each query for traceability. */
  runId?: string
  /** Skip the detail stage — used by the fast list-only smoke check. */
  skipDetail?: boolean
  /** Defaults to true: only software engineering titles get through. */
  softwareOnly?: boolean
}

export interface AdapterResult {
  portal: string
  seen: number
  jobs: ScrapedJob[]
  warnings: string[]
  error?: string
  durationMs: number
  detailFetched: number
  detailFailed: number
}

export interface DiscoveryAdapter {
  id: string
  label: string
  fetchRecent(context: DiscoveryContext): Promise<AdapterResult>
}
