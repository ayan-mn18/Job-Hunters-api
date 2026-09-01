import { XMLParser } from 'fast-xml-parser'
import { companyNameFor } from './boards.js'
import { boardsFor, recordBoardResults } from './board-resolver.js'
import { fetchHtml, fetchJson, fetchXml } from './fetcher.js'
import { decodeEntities, htmlToText } from './html.js'
import { normaliseEmploymentType, normalisePeriod } from './jsonld.js'
import { jsonLdDetail, toDiscoveryAdapter, type SourceAdapter } from './runner.js'
import type {
  DiscoveryAdapter,
  DiscoveryContext,
  JobDetail,
  JobStub,
  RawSalary,
} from './types.js'

/**
 * Source adapters.
 *
 * Each one does as little as possible: produce stubs, and say how to fetch a
 * job's own page when the list endpoint does not already carry the full
 * posting. Everything after that — freshness, detail fetching, parsing,
 * scoring — is shared, so the difference between a good source and a bad one
 * is now only how much the source itself publishes.
 *
 * Sources are limited to boards with a documented public JSON or RSS feed, or
 * public job pages that publish schema.org data. Portals that require defeating
 * bot protection are deliberately absent.
 */

function isoDate(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = new Date(value < 1e11 ? value * 1000 : value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function salaryOf(min: unknown, max: unknown, currency: unknown, period: unknown): RawSalary | undefined {
  const low = typeof min === 'number' ? min : Number(min)
  const high = typeof max === 'number' ? max : Number(max)
  const hasLow = Number.isFinite(low) && low > 0
  const hasHigh = Number.isFinite(high) && high > 0
  if (!hasLow && !hasHigh) return undefined
  return {
    min: hasLow ? low : null,
    max: hasHigh ? high : null,
    currency: typeof currency === 'string' && currency.trim() ? currency.trim().toUpperCase() : null,
    period: (period as RawSalary['period']) ?? null,
    text: null,
  }
}

/* ------------------------------------------------------------- Greenhouse */

interface GreenhouseJob {
  id: number
  title: string
  absolute_url: string
  location?: { name?: string }
  first_published?: string
  updated_at?: string
  content?: string
  company_name?: string
  metadata?: Array<{ name?: string; value?: unknown }>
}


const greenhouseSource: SourceAdapter = {
  id: 'greenhouse',
  label: 'Greenhouse employers',
  async list(context) {
    const stubs: JobStub[] = []
    const warnings: string[] = []
    let seen = 0
        const results = await Promise.all(
      (await boardsFor('greenhouse')).map(async (token) => {
        const fallbackCompany = companyNameFor(token)
        try {
          const data = await fetchJson<{ jobs?: GreenhouseJob[] }>(
            `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`,
            { timeoutMs: 25_000 },
          )
          return { token, fallbackCompany, rows: data.jobs ?? [], error: null as string | null }
        } catch (error) {
          return {
            token,
            fallbackCompany,
            rows: [] as GreenhouseJob[],
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }),
    )

    await recordBoardResults('greenhouse', results)

    for (const { token, fallbackCompany, rows, error } of results) {
      if (error) {
        warnings.push(`${token}: ${error}`)
        continue
      }
      seen += rows.length
      for (const row of rows) {
        const postedAt = isoDate(row.first_published ?? row.updated_at)
        if (!postedAt || !row.title) continue
        stubs.push({
          sourceId: `${token}:${row.id}`,
          portal: 'greenhouse',
          url: row.absolute_url,
          applyUrl: row.absolute_url,
          title: row.title,
          company: row.company_name?.trim() || fallbackCompany,
          locationText: row.location?.name ?? '',
          // Greenhouse double-escapes the posting body, so `content` arrives as
          // `&lt;p&gt;…`. Decoding first is what makes it HTML again — without
          // this the stored description is a wall of literal angle brackets.
          descriptionHtml: row.content ? decodeEntities(row.content) : undefined,
          tags: ['greenhouse', token],
          postedAt,
          postedAtPrecision: 'exact',
          raw: row,
        })
      }
    }
    void context
    return { stubs, seen, warnings }
  },
}

/* ------------------------------------------------------------------ Lever */

interface LeverJob {
  id: string
  text: string
  hostedUrl: string
  applyUrl?: string
  createdAt: number
  descriptionPlain?: string
  description?: string
  lists?: Array<{ text?: string; content?: string }>
  additionalPlain?: string
  categories?: { location?: string; commitment?: string; team?: string }
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string }
}


/**
 * Lever splits a posting into an intro plus titled `lists`. Re-assembling them
 * as headed HTML is what lets the section parser find "Responsibilities" —
 * `descriptionPlain` alone has no structure at all.
 */
function leverHtml(row: LeverJob): string {
  const parts: string[] = []
  if (row.description) parts.push(row.description)
  for (const list of row.lists ?? []) {
    if (list.text) parts.push(`<h3>${list.text}</h3>`)
    if (list.content) parts.push(`<ul>${list.content}</ul>`)
  }
  return parts.join('\n')
}

const leverSource: SourceAdapter = {
  id: 'lever',
  label: 'Lever employers',
  async list() {
    const stubs: JobStub[] = []
    const warnings: string[] = []
    let seen = 0
    const results = await Promise.all(
      (await boardsFor('lever')).map(async (token) => {
        const company = companyNameFor(token)
        try {
          const rows = await fetchJson<LeverJob[]>(
            `https://api.lever.co/v0/postings/${token}?mode=json`,
            { timeoutMs: 25_000 },
          )
          return { token, company, rows, error: null as string | null }
        } catch (error) {
          return {
            token,
            company,
            rows: [] as LeverJob[],
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }),
    )

    await recordBoardResults('lever', results)

    for (const { token, company, rows, error } of results) {
      if (error) {
        warnings.push(`${token}: ${error}`)
        continue
      }
      seen += rows.length
      for (const row of rows) {
        const postedAt = isoDate(row.createdAt)
        if (!postedAt || !row.text) continue
        const html = leverHtml(row)
        stubs.push({
          sourceId: `${token}:${row.id}`,
          portal: 'lever',
          url: row.hostedUrl,
          applyUrl: row.applyUrl ?? row.hostedUrl,
          title: row.text,
          company,
          locationText: row.categories?.location ?? '',
          employmentType: normaliseEmploymentType(row.categories?.commitment),
          descriptionHtml: html || undefined,
          descriptionText: html ? undefined : row.descriptionPlain,
          // Lever writes intervals as "per-year-salary"; stripping the prefix
          // is not enough, so the whole string goes through the period parser.
          salary: salaryOf(
            row.salaryRange?.min,
            row.salaryRange?.max,
            row.salaryRange?.currency,
            normalisePeriod(row.salaryRange?.interval),
          ),
          tags: ['lever', token, row.categories?.team ?? ''].filter(Boolean),
          postedAt,
          postedAtPrecision: 'exact',
          raw: row,
        })
      }
    }
    return { stubs, seen, warnings }
  },
}

/* ------------------------------------------------------------------ Ashby */

interface AshbyJob {
  id: string
  title: string
  location?: string
  secondaryLocations?: Array<{ location?: string }>
  jobUrl?: string
  applyUrl?: string
  publishedAt?: string
  descriptionPlain?: string
  descriptionHtml?: string
  isRemote?: boolean
  isListed?: boolean
  employmentType?: string
  compensation?: {
    compensationTierSummary?: string
    scrapeableCompensationSalarySummary?: string
  }
}


const ashbySource: SourceAdapter = {
  id: 'ashby',
  label: 'Ashby employers',
  async list() {
    const stubs: JobStub[] = []
    const warnings: string[] = []
    let seen = 0
    const results = await Promise.all(
      (await boardsFor('ashby')).map(async (token) => {
        const company = companyNameFor(token)
        try {
          const data = await fetchJson<{ jobs?: AshbyJob[] }>(
            `https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=true`,
            { timeoutMs: 25_000 },
          )
          return { token, company, rows: data.jobs ?? [], error: null as string | null }
        } catch (error) {
          return {
            token,
            company,
            rows: [] as AshbyJob[],
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }),
    )

    await recordBoardResults('ashby', results)

    for (const { token, company, rows, error } of results) {
      if (error) {
        warnings.push(`${token}: ${error}`)
        continue
      }
      const listed = rows.filter((row) => row.isListed !== false)
      seen += listed.length
      for (const row of listed) {
        const postedAt = isoDate(row.publishedAt)
        const url = row.jobUrl ?? row.applyUrl
        if (!postedAt || !url || !row.title) continue
        const salaryText =
          row.compensation?.scrapeableCompensationSalarySummary ??
          row.compensation?.compensationTierSummary
        stubs.push({
          sourceId: `${token}:${row.id}`,
          portal: 'ashby',
          url,
          applyUrl: row.applyUrl ?? url,
          title: row.title,
          company,
          locationText: [row.location, ...(row.secondaryLocations ?? []).map((item) => item.location)]
            .filter(Boolean)
            .join('; '),
          remote: row.isRemote ? 'remote' : undefined,
          employmentType: normaliseEmploymentType(row.employmentType),
          descriptionHtml: row.descriptionHtml,
          descriptionText: row.descriptionPlain,
          salary: salaryText ? { min: null, max: null, currency: null, period: null, text: salaryText } : undefined,
          tags: ['ashby', token],
          postedAt,
          postedAtPrecision: 'exact',
          raw: row,
        })
      }
    }
    return { stubs, seen, warnings }
  },
}

/* --------------------------------------------------------- SmartRecruiters */

interface SmartRecruitersPosting {
  id: string
  name: string
  releasedDate?: string
  company?: { name?: string }
  location?: { city?: string; region?: string; country?: string; remote?: boolean }
  typeOfEmployment?: { label?: string }
  experienceLevel?: { label?: string }
  ref?: string
}

interface SmartRecruitersDetail {
  jobAd?: {
    sections?: Record<string, { title?: string; text?: string } | undefined>
  }
  typeOfEmployment?: { label?: string }
  experienceLevel?: { label?: string }
  applyUrl?: string
  postingUrl?: string
}


function smartRecruitersLocation(location: SmartRecruitersPosting['location']): string {
  const parts = [location?.city, location?.region, location?.country].filter(Boolean)
  const text = parts.join(', ')
  return location?.remote ? `Remote${text ? `, ${text}` : ''}` : text
}

/**
 * The one source here that genuinely needs a second request: the postings list
 * carries only titles and locations, and the description lives behind a
 * per-posting endpoint.
 */
const smartRecruitersSource: SourceAdapter = {
  id: 'smartrecruiters',
  label: 'SmartRecruiters employers',
  detailConcurrency: 4,
  async list() {
    const stubs: JobStub[] = []
    const warnings: string[] = []
    let seen = 0
    const results = await Promise.all(
      (await boardsFor('smartrecruiters')).map(async (token) => {
        const company = companyNameFor(token)
        try {
          const data = await fetchJson<{ content?: SmartRecruitersPosting[]; totalFound?: number }>(
            `https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=100`,
            { timeoutMs: 25_000 },
          )
          return { token, company, rows: data.content ?? [], error: null as string | null }
        } catch (error) {
          return {
            token,
            company,
            rows: [] as SmartRecruitersPosting[],
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }),
    )

    await recordBoardResults('smartrecruiters', results)

    for (const { token, company, rows, error } of results) {
      if (error) {
        warnings.push(`${token}: ${error}`)
        continue
      }
      seen += rows.length
      for (const row of rows) {
        const postedAt = isoDate(row.releasedDate)
        if (!postedAt || !row.name) continue
        stubs.push({
          sourceId: `${token}:${row.id}`,
          portal: 'smartrecruiters',
          url: `https://jobs.smartrecruiters.com/${token}/${row.id}`,
          title: row.name,
          company: row.company?.name?.trim() || company,
          locationText: smartRecruitersLocation(row.location),
          remote: row.location?.remote ? 'remote' : undefined,
          employmentType: normaliseEmploymentType(row.typeOfEmployment?.label),
          tags: ['smartrecruiters', token, row.experienceLevel?.label ?? ''].filter(Boolean),
          postedAt,
          postedAtPrecision: 'exact',
          detailUrl: `https://api.smartrecruiters.com/v1/companies/${token}/postings/${row.id}`,
          raw: row,
        })
      }
    }
    return { stubs, seen, warnings }
  },
  async detail(stub) {
    if (!stub.detailUrl) return null
    const data = await fetchJson<SmartRecruitersDetail>(stub.detailUrl, { timeoutMs: 20_000, retries: 1 })
    const sections = data.jobAd?.sections ?? {}
    // Rebuild the posting with its own headings so the section parser sees the
    // same structure a reader would.
    const html = (['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation'] as const)
      .map((key) => {
        const section = sections[key]
        if (!section?.text) return ''
        const heading = section.title ?? key.replace(/([A-Z])/g, ' $1')
        return `<h3>${heading}</h3>${section.text}`
      })
      .filter(Boolean)
      .join('\n')
    if (!html) return null
    const detail = { descriptionHtml: html } as { descriptionHtml: string; employmentType?: ReturnType<typeof normaliseEmploymentType>; applyUrl?: string }
    const employmentType = normaliseEmploymentType(data.typeOfEmployment?.label)
    if (employmentType) detail.employmentType = employmentType
    if (data.applyUrl ?? data.postingUrl) detail.applyUrl = data.applyUrl ?? data.postingUrl
    return detail
  },
}

/* -------------------------------------------------------- remote job APIs */

interface RemotiveJob {
  id: number
  title: string
  company_name: string
  candidate_required_location?: string
  description?: string
  publication_date?: string
  url: string
  job_type?: string
  salary?: string
  tags?: string[]
}

const remotiveSource: SourceAdapter = {
  id: 'remotive',
  label: 'Remotive',
  async list() {
    const data = await fetchJson<{ jobs?: RemotiveJob[] }>(
      'https://remotive.com/api/remote-jobs?limit=200',
      { timeoutMs: 25_000 },
    )
    const rows = data.jobs ?? []
    const stubs: JobStub[] = []
    for (const row of rows) {
      const postedAt = isoDate(row.publication_date)
      if (!postedAt || !row.title || !row.company_name || !row.url) continue
      stubs.push({
        sourceId: String(row.id),
        portal: 'remotive',
        url: row.url,
        title: row.title,
        company: row.company_name,
        locationText: row.candidate_required_location || 'Remote',
        remote: 'remote',
        employmentType: normaliseEmploymentType(row.job_type),
        descriptionHtml: row.description,
        salary: row.salary?.trim()
          ? { min: null, max: null, currency: null, period: null, text: row.salary.trim() }
          : undefined,
        tags: row.tags ?? [],
        postedAt,
        postedAtPrecision: 'exact',
        raw: row,
      })
    }
    return { stubs, seen: rows.length }
  },
}

interface JobicyJob {
  id: number
  jobTitle: string
  companyName: string
  jobGeo?: string
  jobDescription?: string
  pubDate?: string
  url: string
  jobType?: string[] | string
  jobIndustry?: string[] | string
  annualSalaryMin?: number
  annualSalaryMax?: number
  salaryCurrency?: string
}

const jobicySource: SourceAdapter = {
  id: 'jobicy',
  label: 'Jobicy',
  async list() {
    const data = await fetchJson<{ jobs?: JobicyJob[] }>(
      'https://jobicy.com/api/v2/remote-jobs?count=100',
      { timeoutMs: 25_000 },
    )
    const rows = data.jobs ?? []
    const stubs: JobStub[] = []
    for (const row of rows) {
      const postedAt = isoDate(row.pubDate)
      if (!postedAt || !row.jobTitle || !row.companyName || !row.url) continue
      const industry = Array.isArray(row.jobIndustry) ? row.jobIndustry : row.jobIndustry ? [row.jobIndustry] : []
      stubs.push({
        sourceId: String(row.id),
        portal: 'jobicy',
        url: row.url,
        title: row.jobTitle,
        company: row.companyName,
        locationText: row.jobGeo || 'Remote',
        remote: 'remote',
        employmentType: normaliseEmploymentType(row.jobType),
        descriptionHtml: row.jobDescription,
        salary: salaryOf(row.annualSalaryMin, row.annualSalaryMax, row.salaryCurrency, 'year'),
        tags: industry,
        postedAt,
        postedAtPrecision: 'exact',
        raw: row,
      })
    }
    return { stubs, seen: rows.length }
  },
}

interface ArbeitnowJob {
  slug: string
  title: string
  company_name: string
  location?: string
  description?: string
  created_at?: number
  url: string
  remote?: boolean
  job_types?: string[]
  tags?: string[]
}

const arbeitnowSource: SourceAdapter = {
  id: 'arbeitnow',
  label: 'Arbeitnow',
  async list() {
    const data = await fetchJson<{ data?: ArbeitnowJob[] }>(
      'https://www.arbeitnow.com/api/job-board-api',
      { timeoutMs: 25_000 },
    )
    const rows = data.data ?? []
    const stubs: JobStub[] = []
    for (const row of rows) {
      const postedAt = isoDate(row.created_at)
      if (!postedAt || !row.title || !row.company_name || !row.url) continue
      stubs.push({
        sourceId: row.slug,
        portal: 'arbeitnow',
        url: row.url,
        title: row.title,
        company: row.company_name,
        locationText: row.location ?? '',
        remote: row.remote ? 'remote' : undefined,
        employmentType: normaliseEmploymentType(row.job_types),
        descriptionHtml: row.description,
        tags: row.tags ?? [],
        postedAt,
        postedAtPrecision: 'exact',
        raw: row,
      })
    }
    return { stubs, seen: rows.length }
  },
}

/* --------------------------------------------------------------- RemoteOK */

interface RemoteOkRow {
  id?: string | number
  slug?: string
  epoch?: number
  date?: string
  company?: string
  position?: string
  location?: string
  description?: string
  tags?: string[]
  url?: string
  apply_url?: string
  salary_min?: number
  salary_max?: number
  legal?: string
}

const remoteOkSource: SourceAdapter = {
  id: 'remoteok',
  label: 'RemoteOK',
  detailConcurrency: 2,
  async list() {
    const rows = await fetchJson<RemoteOkRow[]>('https://remoteok.com/api', { timeoutMs: 25_000 })
    const stubs: JobStub[] = []
    for (const row of rows) {
      // The first element of RemoteOK's feed is a licence notice, not a job.
      if (row.legal) continue
      const postedAt = isoDate(row.epoch ?? row.date)
      if (!postedAt || !row.position || !row.company) continue
      const url = row.url ?? `https://remoteok.com/remote-jobs/${row.slug ?? row.id}`
      stubs.push({
        sourceId: String(row.id ?? row.slug),
        portal: 'remoteok',
        url,
        applyUrl: row.apply_url,
        title: row.position,
        company: row.company,
        locationText: row.location || 'Remote',
        remote: 'remote',
        descriptionHtml: row.description,
        salary: salaryOf(row.salary_min, row.salary_max, 'USD', 'year'),
        tags: row.tags ?? [],
        postedAt,
        postedAtPrecision: 'exact',
        raw: row,
      })
    }
    return { stubs, seen: Math.max(0, rows.length - 1) }
  },
  detail: (stub) => jsonLdDetail(stub.url),
}

/* -------------------------------------------------------- We Work Remotely */

interface WwrItem {
  guid?: string | { '#text'?: string }
  link?: string
  title?: string
  pubDate?: string
  region?: string
  country?: string
  type?: string
  description?: string
  category?: string
}

const wwrParser = new XMLParser({
  ignoreAttributes: false,
  processEntities: true,
  htmlEntities: true,
  maxTotalExpansions: 10_000,
} as ConstructorParameters<typeof XMLParser>[0])

const weWorkRemotelySource: SourceAdapter = {
  id: 'weworkremotely',
  label: 'We Work Remotely',
  detailConcurrency: 2,
  async list() {
    const xml = await fetchXml('https://weworkremotely.com/remote-jobs.rss', { timeoutMs: 25_000 })
    const parsed = wwrParser.parse(xml) as { rss?: { channel?: { item?: WwrItem | WwrItem[] } } }
    const value = parsed.rss?.channel?.item
    const rows = Array.isArray(value) ? value : value ? [value] : []
    const stubs: JobStub[] = []
    for (const row of rows) {
      const postedAt = isoDate(row.pubDate)
      if (!postedAt || !row.title) continue
      const guid = typeof row.guid === 'object' ? row.guid['#text'] : row.guid
      const url = row.link ?? guid
      if (!url) continue
      // WWR titles are "Company: Role"; anything else is left whole rather
      // than guessed at.
      const separator = row.title.indexOf(':')
      const company = separator > 0 ? row.title.slice(0, separator).trim() : 'Unknown'
      const title = separator > 0 ? row.title.slice(separator + 1).trim() : row.title.trim()
      stubs.push({
        sourceId: String(guid ?? url),
        portal: 'weworkremotely',
        url,
        title,
        company,
        locationText: [row.region, row.country].filter(Boolean).join(', ') || 'Remote',
        remote: 'remote',
        employmentType: normaliseEmploymentType(row.type ?? row.category),
        descriptionHtml: row.description,
        tags: row.category ? [row.category] : [],
        postedAt,
        postedAtPrecision: 'exact',
        raw: row,
      })
    }
    return { stubs, seen: rows.length }
  },
  detail: (stub) => jsonLdDetail(stub.url),
}

/* ---------------------------------------------------------------- Workable */

interface WorkableJob {
  id?: string
  shortcode?: string
  title?: string
  description?: string
  requirements?: string
  benefits?: string
  published_on?: string
  created_at?: string
  city?: string
  state?: string
  country?: string
  telecommuting?: boolean
  employment_type?: string
  application_url?: string
  url?: string
}


const workableSource: SourceAdapter = {
  id: 'workable',
  label: 'Workable employers',
  async list() {
    const stubs: JobStub[] = []
    const warnings: string[] = []
    let seen = 0
    const results = await Promise.all(
      (await boardsFor('workable')).map(async (token) => {
        const company = companyNameFor(token)
        try {
          const data = await fetchJson<{ jobs?: WorkableJob[] }>(
            `https://apply.workable.com/api/v1/widget/accounts/${token}?details=true`,
            { timeoutMs: 25_000 },
          )
          return { token, company, rows: data.jobs ?? [], error: null as string | null }
        } catch (error) {
          return {
            token,
            company,
            rows: [] as WorkableJob[],
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }),
    )

    await recordBoardResults('workable', results)

    for (const { token, company, rows, error } of results) {
      if (error) {
        warnings.push(`${token}: ${error}`)
        continue
      }
      seen += rows.length
      for (const row of rows) {
        const postedAt = isoDate(row.published_on ?? row.created_at)
        const url = row.url ?? row.application_url
        if (!postedAt || !url || !row.title) continue
        const html = [
          row.description,
          row.requirements ? `<h3>Requirements</h3>${row.requirements}` : '',
          row.benefits ? `<h3>Benefits</h3>${row.benefits}` : '',
        ]
          .filter(Boolean)
          .join('\n')
        stubs.push({
          sourceId: `${token}:${row.shortcode ?? row.id}`,
          portal: 'workable',
          url,
          applyUrl: row.application_url ?? url,
          title: row.title,
          company,
          locationText: [row.city, row.state, row.country].filter(Boolean).join(', '),
          remote: row.telecommuting ? 'remote' : undefined,
          employmentType: normaliseEmploymentType(row.employment_type),
          descriptionHtml: html || undefined,
          tags: ['workable', token],
          postedAt,
          postedAtPrecision: 'exact',
          raw: row,
        })
      }
    }
    return { stubs, seen, warnings }
  },
}

/* -------------------------------------------------------------- Instahyre */

interface InstahyreJob {
  id?: number
  title?: string
  locations?: string
  public_url?: string
  keywords?: string[]
  employer?: { company_name?: string; instahyre_note?: string }
}

/**
 * Instahyre publishes no posting timestamp, so freshness is "first seen by
 * us". It stays behind an explicit opt-in for that reason.
 */
const instahyreSource: SourceAdapter = {
  id: 'instahyre',
  label: 'Instahyre',
  detailConcurrency: 2,
  async list(context: DiscoveryContext) {
    const payload = await fetchJson<{ objects?: InstahyreJob[] }>(
      'https://www.instahyre.com/api/v1/job_search?limit=100',
      { timeoutMs: 25_000 },
    )
    const rows = payload.objects ?? []
    const stubs: JobStub[] = []
    for (const row of rows) {
      if (!row.id || !row.title || !row.public_url || !row.employer?.company_name) continue
      stubs.push({
        sourceId: String(row.id),
        portal: 'instahyre',
        url: row.public_url,
        applyUrl: row.public_url,
        title: row.title,
        company: row.employer.company_name,
        locationText: row.locations ?? 'India',
        descriptionText: row.employer.instahyre_note
          ? htmlToText(row.employer.instahyre_note)
          : undefined,
        tags: row.keywords ?? [],
        postedAt: context.now.toISOString(),
        postedAtPrecision: 'first-seen',
        raw: row,
      })
    }
    return {
      stubs,
      seen: rows.length,
      warnings: ['Instahyre publishes no posting date; freshness is first-seen only.'],
    }
  },
  detail: (stub) => jsonLdDetail(stub.url),
}

/* -------------------------------------------------- Work at a Startup (YC) */

/**
 * Work at a Startup is a Rails + Inertia app: every page ships its prop
 * payload as an entity-escaped JSON blob baked into the HTML. Reading markup
 * straight back keeps this polite — one GET per page, no client bundle calls.
 */
interface WaasListing {
  id?: number
  title?: string
  jobType?: string
  location?: string
  roleType?: string
  salary?: string
  companyName?: string
  companySlug?: string
  companyBatch?: string
  applyUrl?: string
}

interface WaasJobDetail {
  descriptionHtml?: string
  skills?: string[]
  minExperience?: string
  salaryRange?: string
  location?: string
  jobType?: string
}

/** Bracket-balances a JSON fragment following `marker` in the decoded HTML. */
function extractEmbeddedJson<T>(html: string, marker: string): T | null {
  const decoded = decodeEntities(html)
  const markerIndex = decoded.indexOf(marker)
  if (markerIndex === -1) return null
  const openIndex = decoded.slice(markerIndex).search(/[{[]/)
  if (openIndex === -1) return null
  const start = markerIndex + openIndex
  const input = decoded.slice(start)
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === '{' || char === '[') depth += 1
    if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(input.slice(0, index + 1)) as T
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/**
 * The listing page embeds 30 jobs per page with no pagination metadata. Six
 * pages is deliberately the cap: a full scan would also crawl the detail pages
 * of hundreds of stale postings for no ranking gain. Stop early when a page
 * contributes nothing new.
 */
const WAAS_LIST_PAGES = Number(process.env.WAAS_LIST_PAGES ?? 6)
const WAAS_BASE = 'https://www.workatastartup.com'

const waasSource: SourceAdapter = {
  id: 'workatastartup',
  label: 'Work at a Startup (YC)',
  detailConcurrency: 2,
  async list(context: DiscoveryContext) {
    const seenIds = new Set<number>()
    const stubs: JobStub[] = []
    let seen = 0

    for (let page = 1; page <= WAAS_LIST_PAGES; page += 1) {
      const html = await fetchHtml(`${WAAS_BASE}/jobs?page=${page}`, { timeoutMs: 25_000 })
      const rows = extractEmbeddedJson<WaasListing[]>(html, '"jobs":') ?? []
      seen += rows.length
      const fresh = rows.filter((row) => typeof row.id === 'number')
      if (fresh.length === 0) break
      const added = fresh.filter((row) => !seenIds.has(row.id!))
      fresh.forEach((row) => seenIds.add(row.id!))
      if (added.length === 0) break

      for (const row of added) {
        if (!row.title || !row.companyName) continue
        stubs.push({
          sourceId: String(row.id),
          portal: 'workatastartup',
          url: `${WAAS_BASE}/jobs/${row.id}`,
          applyUrl: row.applyUrl,
          title: row.title,
          company: row.companyName,
          locationText: row.location ?? '',
          remote: row.location?.includes('Remote') ? 'remote' : undefined,
          employmentType: normaliseEmploymentType(row.jobType),
          salary: row.salary?.trim()
            ? { min: null, max: null, currency: null, period: null, text: row.salary.trim() }
            : undefined,
          tags: ['workatastartup', `yc-${row.companyBatch ?? ''}`, row.roleType ?? ''].filter(Boolean),
          postedAt: context.now.toISOString(),
          postedAtPrecision: 'first-seen',
          raw: row,
        })
      }
    }

    return {
      stubs,
      seen,
      warnings: ['Work at a Startup publishes no posting date; freshness is first-seen only.'],
    }
  },
  async detail(stub) {
    const html = await fetchHtml(stub.url, { timeoutMs: 20_000, retries: 1 })
    const job = extractEmbeddedJson<WaasJobDetail>(html, '"job":')
    if (!job?.descriptionHtml) return null

    const detail: JobDetail = { descriptionHtml: job.descriptionHtml }
    if (job.skills && job.skills.length > 0) detail.skills = job.skills
    if (job.location) detail.locationText = job.location
    if (job.location?.includes('Remote')) detail.remote = 'remote'
    const employmentType = normaliseEmploymentType(job.jobType)
    if (employmentType) detail.employmentType = employmentType
    if (job.salaryRange) {
      detail.salary = { min: null, max: null, currency: null, period: null, text: job.salaryRange }
    }
    if (job.minExperience) {
      const years = Number(/\d+/.exec(job.minExperience)?.[0])
      if (Number.isFinite(years)) {
        detail.experience = { min: years, max: null, text: job.minExperience }
      }
    }
    return detail
  },
}

/* ------------------------------------------------------------------ export */

export const SOURCE_ADAPTERS: SourceAdapter[] = [
  greenhouseSource,
  leverSource,
  ashbySource,
  smartRecruitersSource,
  workableSource,
  remotiveSource,
  jobicySource,
  arbeitnowSource,
  remoteOkSource,
  weWorkRemotelySource,
  instahyreSource,
  waasSource,
]

export const DISCOVERY_ADAPTERS: DiscoveryAdapter[] = SOURCE_ADAPTERS.map(toDiscoveryAdapter)

export function adaptersFor(portalIds: string[]): DiscoveryAdapter[] {
  const enabled = new Set(portalIds)
  return DISCOVERY_ADAPTERS.filter((adapter) => enabled.has(adapter.id))
}
