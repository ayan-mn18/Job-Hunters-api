import { XMLParser } from 'fast-xml-parser'
import { fingerprintOf, inferRemoteMode, normaliseLocations, stripHtml } from './normalise.js'
import type { AdapterResult, DiscoveryAdapter, DiscoveryContext, ScrapedJob } from './types.js'

const USER_AGENT = 'Huntly/0.1 (personal job-search assistant; contact via project repository)'

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${new URL(url).host}`)
  return response.json() as Promise<T>
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${new URL(url).host}`)
  return response.text()
}

function exactDate(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = new Date(value < 1e11 ? value * 1000 : value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function insideWindow(postedAt: string, context: DiscoveryContext): boolean {
  const value = Date.parse(postedAt)
  return value >= context.since.getTime() && value <= context.now.getTime() + 21_600_000
}

function failedResult(portal: string, started: number, error: unknown): AdapterResult {
  return {
    portal,
    seen: 0,
    jobs: [],
    warnings: [],
    error: error instanceof Error ? error.message : String(error),
    durationMs: Date.now() - started,
  }
}

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
  legal?: string
}

const remoteOkAdapter: DiscoveryAdapter = {
  id: 'remoteok',
  label: 'RemoteOK',
  async fetchRecent(context) {
    const started = Date.now()
    try {
      const rows = await fetchJson<RemoteOkRow[]>('https://remoteok.com/api')
      const fetchedAt = context.now.toISOString()
      const jobs: ScrapedJob[] = []
      for (const row of rows) {
        if (row.legal) continue
        const postedAt = exactDate(row.epoch ?? row.date)
        if (!postedAt || !insideWindow(postedAt, context) || !row.position || !row.company) continue
        const locations = normaliseLocations(row.location || 'Remote')
        jobs.push({
          sourceId: String(row.id ?? row.slug),
          portal: 'remoteok',
          url: row.url ?? `https://remoteok.com/remote-jobs/${row.slug ?? row.id}`,
          applyUrl: row.apply_url,
          title: row.position.trim(),
          company: row.company.trim(),
          locations,
          remote: inferRemoteMode(`${row.location ?? ''} ${row.position}`, locations),
          descriptionText: stripHtml(row.description),
          tags: row.tags ?? [],
          postedAt,
          postedAtPrecision: 'exact',
          fetchedAt,
          fingerprint: fingerprintOf(row.position, row.company, locations),
          raw: row,
        })
        if (jobs.length >= context.maxItems) break
      }
      return { portal: 'remoteok', seen: rows.length - 1, jobs, warnings: [], durationMs: Date.now() - started }
    } catch (error) {
      return failedResult('remoteok', started, error)
    }
  },
}

interface WwrItem {
  guid?: string | { '#text'?: string }
  link?: string
  title?: string
  pubDate?: string
  region?: string
  country?: string
  description?: string
  category?: string
}

const wwrParser = new XMLParser({
  ignoreAttributes: false,
  processEntities: true,
  htmlEntities: true,
  maxTotalExpansions: 10_000,
} as ConstructorParameters<typeof XMLParser>[0])

const weWorkRemotelyAdapter: DiscoveryAdapter = {
  id: 'weworkremotely',
  label: 'We Work Remotely',
  async fetchRecent(context) {
    const started = Date.now()
    try {
      const xml = await fetchText('https://weworkremotely.com/remote-jobs.rss')
      const parsed = wwrParser.parse(xml) as { rss?: { channel?: { item?: WwrItem | WwrItem[] } } }
      const value = parsed.rss?.channel?.item
      const rows = Array.isArray(value) ? value : value ? [value] : []
      const fetchedAt = context.now.toISOString()
      const jobs: ScrapedJob[] = []
      for (const row of rows) {
        const postedAt = exactDate(row.pubDate)
        if (!postedAt || !insideWindow(postedAt, context) || !row.title) continue
        const separator = row.title.indexOf(':')
        const company = separator > 0 ? row.title.slice(0, separator).trim() : 'Unknown'
        const title = separator > 0 ? row.title.slice(separator + 1).trim() : row.title.trim()
        const guid = typeof row.guid === 'object' ? row.guid['#text'] : row.guid
        const url = row.link ?? guid
        if (!url) continue
        const locations = normaliseLocations([row.region, row.country].filter(Boolean).join(', ') || 'Remote')
        jobs.push({
          sourceId: String(guid ?? url),
          portal: 'weworkremotely',
          url,
          title,
          company,
          locations,
          remote: 'remote',
          descriptionText: stripHtml(row.description),
          tags: row.category ? [row.category] : [],
          postedAt,
          postedAtPrecision: 'exact',
          fetchedAt,
          fingerprint: fingerprintOf(title, company, locations),
          raw: row,
        })
        if (jobs.length >= context.maxItems) break
      }
      return { portal: 'weworkremotely', seen: rows.length, jobs, warnings: [], durationMs: Date.now() - started }
    } catch (error) {
      return failedResult('weworkremotely', started, error)
    }
  },
}

interface GreenhouseJob {
  id: number
  title: string
  absolute_url: string
  location?: { name?: string }
  first_published?: string
  updated_at?: string
  content?: string
  company_name?: string
}

const GREENHOUSE_BOARDS: Record<string, string> = {
  careem: 'Careem',
  tamara: 'Tamara',
  gitlab: 'GitLab',
  stripe: 'Stripe',
}

const greenhouseAdapter: DiscoveryAdapter = {
  id: 'greenhouse',
  label: 'Greenhouse employers',
  async fetchRecent(context) {
    const started = Date.now()
    const jobs: ScrapedJob[] = []
    const warnings: string[] = []
    let seen = 0
    for (const [token, fallbackCompany] of Object.entries(GREENHOUSE_BOARDS)) {
      try {
        const data = await fetchJson<{ jobs?: GreenhouseJob[] }>(
          `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`,
        )
        const rows = data.jobs ?? []
        seen += rows.length
        for (const row of rows) {
          const postedAt = exactDate(row.first_published ?? row.updated_at)
          if (!postedAt || !insideWindow(postedAt, context)) continue
          const company = row.company_name?.trim() || fallbackCompany
          const locations = normaliseLocations(row.location?.name ?? '')
          jobs.push({
            sourceId: `${token}:${row.id}`,
            portal: 'greenhouse',
            url: row.absolute_url,
            applyUrl: row.absolute_url,
            title: row.title.trim(),
            company,
            locations,
            remote: inferRemoteMode(row.location?.name ?? '', locations),
            descriptionText: stripHtml(row.content),
            tags: ['greenhouse', token],
            postedAt,
            postedAtPrecision: 'exact',
            fetchedAt: context.now.toISOString(),
            fingerprint: fingerprintOf(row.title, company, locations),
            raw: row,
          })
        }
      } catch (error) {
        warnings.push(`${token}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { portal: 'greenhouse', seen, jobs: jobs.slice(0, context.maxItems), warnings, durationMs: Date.now() - started }
  },
}

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
}

const ASHBY_BOARDS: Record<string, string> = {
  ashby: 'Ashby',
  deel: 'Deel',
  ramp: 'Ramp',
}

const ashbyAdapter: DiscoveryAdapter = {
  id: 'ashby',
  label: 'Ashby employers',
  async fetchRecent(context) {
    const started = Date.now()
    const jobs: ScrapedJob[] = []
    const warnings: string[] = []
    let seen = 0
    for (const [token, company] of Object.entries(ASHBY_BOARDS)) {
      try {
        const data = await fetchJson<{ jobs?: AshbyJob[] }>(
          `https://api.ashbyhq.com/posting-api/job-board/${token}`,
        )
        const rows = (data.jobs ?? []).filter((row) => row.isListed !== false)
        seen += rows.length
        for (const row of rows) {
          const postedAt = exactDate(row.publishedAt)
          if (!postedAt || !insideWindow(postedAt, context)) continue
          const locationText = [row.location, ...(row.secondaryLocations ?? []).map((item) => item.location)]
            .filter(Boolean)
            .join('; ')
          const locations = normaliseLocations(locationText)
          const url = row.jobUrl ?? row.applyUrl
          if (!url) continue
          jobs.push({
            sourceId: `${token}:${row.id}`,
            portal: 'ashby',
            url,
            applyUrl: row.applyUrl,
            title: row.title.trim(),
            company,
            locations,
            remote: row.isRemote ? 'remote' : inferRemoteMode(locationText, locations),
            descriptionText: row.descriptionPlain ?? stripHtml(row.descriptionHtml),
            tags: ['ashby', token],
            postedAt,
            postedAtPrecision: 'exact',
            fetchedAt: context.now.toISOString(),
            fingerprint: fingerprintOf(row.title, company, locations),
            raw: row,
          })
        }
      } catch (error) {
        warnings.push(`${token}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { portal: 'ashby', seen, jobs: jobs.slice(0, context.maxItems), warnings, durationMs: Date.now() - started }
  },
}

interface LeverJob {
  id: string
  text: string
  hostedUrl: string
  applyUrl?: string
  createdAt: number
  descriptionPlain?: string
  categories?: { location?: string }
}

const LEVER_BOARDS: Record<string, string> = {
  netflix: 'Netflix',
  canva: 'Canva',
  palantir: 'Palantir',
}

const leverAdapter: DiscoveryAdapter = {
  id: 'lever',
  label: 'Lever employers',
  async fetchRecent(context) {
    const started = Date.now()
    const jobs: ScrapedJob[] = []
    const warnings: string[] = []
    let seen = 0
    for (const [token, company] of Object.entries(LEVER_BOARDS)) {
      try {
        const rows = await fetchJson<LeverJob[]>(`https://api.lever.co/v0/postings/${token}?mode=json`)
        seen += rows.length
        for (const row of rows) {
          const postedAt = exactDate(row.createdAt)
          if (!postedAt || !insideWindow(postedAt, context)) continue
          const locations = normaliseLocations(row.categories?.location ?? '')
          jobs.push({
            sourceId: `${token}:${row.id}`,
            portal: 'lever',
            url: row.hostedUrl,
            applyUrl: row.applyUrl,
            title: row.text.trim(),
            company,
            locations,
            remote: inferRemoteMode(row.categories?.location ?? '', locations),
            descriptionText: row.descriptionPlain,
            tags: ['lever', token],
            postedAt,
            postedAtPrecision: 'exact',
            fetchedAt: context.now.toISOString(),
            fingerprint: fingerprintOf(row.text, company, locations),
            raw: row,
          })
        }
      } catch (error) {
        warnings.push(`${token}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { portal: 'lever', seen, jobs: jobs.slice(0, context.maxItems), warnings, durationMs: Date.now() - started }
  },
}

interface RemoteApiShape {
  jobs?: unknown[]
  data?: unknown[]
}

function remoteApiAdapter(config: {
  id: string
  label: string
  url: string
  rows: (payload: RemoteApiShape) => unknown[]
  map: (row: Record<string, unknown>, now: Date) => ScrapedJob | null
}): DiscoveryAdapter {
  return {
    id: config.id,
    label: config.label,
    async fetchRecent(context) {
      const started = Date.now()
      try {
        const payload = await fetchJson<RemoteApiShape>(config.url)
        const rows = config.rows(payload)
        const jobs = rows
          .map((row) => config.map(row as Record<string, unknown>, context.now))
          .filter((job): job is ScrapedJob => job !== null)
          .filter((job) => job.postedAtPrecision === 'first-seen' || insideWindow(job.postedAt, context))
          .slice(0, context.maxItems)
        return { portal: config.id, seen: rows.length, jobs, warnings: [], durationMs: Date.now() - started }
      } catch (error) {
        return failedResult(config.id, started, error)
      }
    },
  }
}

function mappedRemoteJob(
  portal: string,
  row: Record<string, unknown>,
  now: Date,
  fields: { id: string; title: string; company: string; location: string; description: string; date: string; url: string },
): ScrapedJob | null {
  const title = String(row[fields.title] ?? '').trim()
  const company = String(row[fields.company] ?? '').trim()
  const url = String(row[fields.url] ?? '').trim()
  const postedAt = exactDate(row[fields.date])
  if (!title || !company || !url || !postedAt) return null
  const locationText = String(row[fields.location] ?? 'Remote')
  const locations = normaliseLocations(locationText)
  const descriptionText = stripHtml(String(row[fields.description] ?? ''))
  return {
    sourceId: String(row[fields.id] ?? url),
    portal,
    url,
    title,
    company,
    locations,
    remote: inferRemoteMode(`${locationText} ${descriptionText ?? ''}`, locations),
    descriptionText,
    tags: [],
    postedAt,
    postedAtPrecision: 'exact',
    fetchedAt: now.toISOString(),
    fingerprint: fingerprintOf(title, company, locations),
    raw: row,
  }
}

const remotiveAdapter = remoteApiAdapter({
  id: 'remotive',
  label: 'Remotive',
  url: 'https://remotive.com/api/remote-jobs',
  rows: (payload) => payload.jobs ?? [],
  map: (row, now) => mappedRemoteJob('remotive', row, now, {
    id: 'id', title: 'title', company: 'company_name', location: 'candidate_required_location',
    description: 'description', date: 'publication_date', url: 'url',
  }),
})

const jobicyAdapter = remoteApiAdapter({
  id: 'jobicy',
  label: 'Jobicy',
  url: 'https://jobicy.com/api/v2/remote-jobs?count=100',
  rows: (payload) => payload.jobs ?? [],
  map: (row, now) => mappedRemoteJob('jobicy', row, now, {
    id: 'id', title: 'jobTitle', company: 'companyName', location: 'jobGeo',
    description: 'jobDescription', date: 'pubDate', url: 'url',
  }),
})

const arbeitnowAdapter = remoteApiAdapter({
  id: 'arbeitnow',
  label: 'Arbeitnow',
  url: 'https://www.arbeitnow.com/api/job-board-api',
  rows: (payload) => payload.data ?? [],
  map: (row, now) => mappedRemoteJob('arbeitnow', row, now, {
    id: 'slug', title: 'title', company: 'company_name', location: 'location',
    description: 'description', date: 'created_at', url: 'url',
  }),
})

interface InstahyreJob {
  id?: number
  title?: string
  locations?: string
  public_url?: string
  keywords?: string[]
  employer?: { company_name?: string; instahyre_note?: string }
}

const instahyreAdapter: DiscoveryAdapter = {
  id: 'instahyre',
  label: 'Instahyre',
  async fetchRecent(context) {
    const started = Date.now()
    try {
      const payload = await fetchJson<{ objects?: InstahyreJob[] }>(
        'https://www.instahyre.com/api/v1/job_search?limit=100',
      )
      const rows = payload.objects ?? []
      const jobs: ScrapedJob[] = []
      for (const row of rows) {
        if (!row.id || !row.title || !row.public_url || !row.employer?.company_name) continue
        const locations = normaliseLocations(row.locations ?? 'India')
        jobs.push({
          sourceId: String(row.id),
          portal: 'instahyre',
          url: row.public_url,
          applyUrl: row.public_url,
          title: row.title,
          company: row.employer.company_name,
          locations,
          remote: inferRemoteMode(row.locations ?? '', locations),
          descriptionText: row.employer.instahyre_note,
          tags: row.keywords ?? [],
          postedAt: context.now.toISOString(),
          postedAtPrecision: 'first-seen',
          fetchedAt: context.now.toISOString(),
          fingerprint: fingerprintOf(row.title, row.employer.company_name, locations),
          raw: row,
        })
      }
      return { portal: 'instahyre', seen: rows.length, jobs, warnings: ['Instahyre has no posting timestamp; cold-start jobs require review.'], durationMs: Date.now() - started }
    } catch (error) {
      return failedResult('instahyre', started, error)
    }
  },
}

export const DISCOVERY_ADAPTERS: DiscoveryAdapter[] = [
  greenhouseAdapter,
  ashbyAdapter,
  leverAdapter,
  remoteOkAdapter,
  weWorkRemotelyAdapter,
  remotiveAdapter,
  jobicyAdapter,
  arbeitnowAdapter,
  instahyreAdapter,
]

export function adaptersFor(portalIds: string[]): DiscoveryAdapter[] {
  const enabled = new Set(portalIds)
  return DISCOVERY_ADAPTERS.filter((adapter) => enabled.has(adapter.id))
}
