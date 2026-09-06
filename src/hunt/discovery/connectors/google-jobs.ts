import { env } from '../../../config/env.js'
import type { SourceAdapter } from '../runner.js'
import { fetchJson } from '../fetcher.js'
import type { ConnectorMeta } from '../connector.js'
import { recordSearchQuery } from '../query-log.js'
import type { DiscoveryContext, JobStub, RawSalary, SearchQuery } from '../types.js'

/**
 * Google for Jobs, through a search API.
 *
 * This one connector closes the largest gap in the product. Google indexes
 * postings from LinkedIn, Naukri, Foundit, Bayt and Indeed, so their listings
 * arrive here — keyword- and location-searched — with no session, no scraping
 * of those sites, and no terms-of-service exposure. The landing page has been
 * advertising those portals; this is what makes the claim true.
 *
 * Two providers are supported because both are commodities and neither is
 * worth being locked into. Whichever key is configured wins.
 */

type Provider = 'jsearch' | 'serpapi'

function activeProvider(): Provider | null {
  if (env.JSEARCH_API_KEY) return 'jsearch'
  if (env.SERPAPI_KEY) return 'serpapi'
  return null
}

/** Google for Jobs takes one location string, not a country code. */
function locationFor(query: SearchQuery): string | undefined {
  if (query.remoteOnly) return undefined
  return query.locationText ?? undefined
}

interface JSearchJob {
  job_id?: string
  job_title?: string
  employer_name?: string
  job_publisher?: string
  job_apply_link?: string
  job_description?: string
  job_is_remote?: boolean
  job_posted_at_datetime_utc?: string
  job_city?: string
  job_country?: string
  job_min_salary?: number
  job_max_salary?: number
  job_salary_currency?: string
  job_salary_period?: string
  job_employment_type?: string
  job_google_link?: string
}

function salaryFrom(job: JSearchJob): RawSalary | undefined {
  const min = typeof job.job_min_salary === 'number' ? job.job_min_salary : null
  const max = typeof job.job_max_salary === 'number' ? job.job_max_salary : null
  if (min === null && max === null) return undefined
  const period = (job.job_salary_period ?? '').toLowerCase()
  return {
    min,
    max,
    currency: job.job_salary_currency ?? null,
    period:
      period === 'year' || period === 'yearly'
        ? 'year'
        : period === 'month' || period === 'monthly'
          ? 'month'
          : period === 'hour' || period === 'hourly'
            ? 'hour'
            : null,
    text: null,
  }
}

async function listJSearch(query: SearchQuery, maxItems: number): Promise<JobStub[]> {
  const params = new URLSearchParams({
    query: [query.keywords, locationFor(query)].filter(Boolean).join(' in '),
    page: '1',
    num_pages: '1',
    date_posted: 'month',
  })
  if (query.remoteOnly) params.set('work_from_home', 'true')
  if (query.market && query.market !== 'remote') params.set('country', query.market.toLowerCase())

  const body = await fetchJson<{ data?: JSearchJob[] }>(
    `https://jsearch.p.rapidapi.com/search?${params.toString()}`,
    {
      skipRobots: true,
      timeoutMs: 20_000,
      headers: {
        'x-rapidapi-key': env.JSEARCH_API_KEY ?? '',
        'x-rapidapi-host': 'jsearch.p.rapidapi.com',
      },
    },
  )

  const jobs = body.data ?? []
  return jobs.slice(0, maxItems).flatMap((job): JobStub[] => {
    const url = job.job_apply_link ?? job.job_google_link
    if (!url || !job.job_title || !job.employer_name) return []
    const postedAt = job.job_posted_at_datetime_utc
    return [
      {
        sourceId: job.job_id ?? url,
        portal: 'google-jobs',
        url,
        applyUrl: job.job_apply_link ?? undefined,
        title: job.job_title,
        company: job.employer_name,
        locationText: [job.job_city, job.job_country].filter(Boolean).join(', ') || 'Remote',
        remote: job.job_is_remote ? 'remote' : undefined,
        descriptionText: job.job_description ?? undefined,
        // The publisher — LinkedIn, Naukri, Indeed — is worth keeping. It is
        // how the user recognises where a posting actually came from.
        tags: job.job_publisher ? [job.job_publisher] : [],
        postedAt: postedAt ?? new Date().toISOString(),
        postedAtPrecision: postedAt ? 'exact' : 'first-seen',
        salary: salaryFrom(job),
        raw: job,
      },
    ]
  })
}

interface SerpApiJob {
  job_id?: string
  title?: string
  company_name?: string
  location?: string
  description?: string
  via?: string
  detected_extensions?: { posted_at?: string; work_from_home?: boolean }
  apply_options?: Array<{ link?: string }>
  share_link?: string
}

async function listSerpApi(query: SearchQuery, maxItems: number): Promise<JobStub[]> {
  const params = new URLSearchParams({
    engine: 'google_jobs',
    q: [query.keywords, locationFor(query)].filter(Boolean).join(' '),
    api_key: env.SERPAPI_KEY ?? '',
  })
  if (query.market && query.market !== 'remote') params.set('gl', query.market.toLowerCase())

  const body = await fetchJson<{ jobs_results?: SerpApiJob[] }>(
    `https://serpapi.com/search.json?${params.toString()}`,
    { skipRobots: true, timeoutMs: 20_000 },
  )

  const jobs = body.jobs_results ?? []
  return jobs.slice(0, maxItems).flatMap((job): JobStub[] => {
    const url = job.apply_options?.[0]?.link ?? job.share_link
    if (!url || !job.title || !job.company_name) return []
    return [
      {
        sourceId: job.job_id ?? url,
        portal: 'google-jobs',
        url,
        applyUrl: job.apply_options?.[0]?.link ?? undefined,
        title: job.title,
        company: job.company_name,
        locationText: job.location ?? 'Remote',
        remote: job.detected_extensions?.work_from_home ? 'remote' : undefined,
        descriptionText: job.description ?? undefined,
        tags: job.via ? [job.via.replace(/^via\s+/i, '')] : [],
        // SerpApi reports "3 days ago" rather than a timestamp. Rather than
        // guess a date, mark it first-seen and let the freshness window treat
        // it accordingly.
        postedAt: new Date().toISOString(),
        postedAtPrecision: 'first-seen',
        raw: job,
      },
    ]
  })
}

export const googleJobsMeta: ConnectorMeta = {
  id: 'google-jobs',
  tier: 1,
  // Google for Jobs is global; the connector passes the market through.
  markets: ['*'],
  needsSession: false,
  supports: { keyword: true, location: true },
  ...(activeProvider()
    ? {}
    : {
        unavailableReason:
          'Set JSEARCH_API_KEY or SERPAPI_KEY to search Google for Jobs (this is what reaches LinkedIn, Naukri and Indeed listings).',
      }),
}

/** Results requested per query. Kept modest: the plan issues many queries. */
const PER_QUERY = 25

export const googleJobsSource: SourceAdapter = {
  id: 'google-jobs',
  label: 'Google for Jobs',
  detailConcurrency: 2,

  async list(context: DiscoveryContext) {
    const provider = activeProvider()
    if (!provider) {
      return { stubs: [], seen: 0, warnings: ['Google for Jobs is not configured.'] }
    }
    const queries = context.queries ?? []
    if (queries.length === 0) {
      return { stubs: [], seen: 0, warnings: ['No query plan — Google for Jobs needs keywords.'] }
    }

    const stubs: JobStub[] = []
    const warnings: string[] = []
    let seen = 0

    // Sequential on purpose. These are metered APIs with per-second limits,
    // and the shared fetcher's host gate would serialise them anyway.
    for (const query of queries) {
      if (stubs.length >= context.maxItems) break
      const startedAt = Date.now()
      try {
        const found =
          provider === 'jsearch'
            ? await listJSearch(query, PER_QUERY)
            : await listSerpApi(query, PER_QUERY)
        seen += found.length
        stubs.push(...found)
        await recordSearchQuery({
          runId: context.runId,
          connectorId: 'google-jobs',
          query: query.keywords,
          market: query.market,
          resultCount: found.length,
          durationMs: Date.now() - startedAt,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        warnings.push(`"${query.keywords}" (${query.market ?? 'any'}): ${message}`)
        await recordSearchQuery({
          runId: context.runId,
          connectorId: 'google-jobs',
          query: query.keywords,
          market: query.market,
          resultCount: 0,
          durationMs: Date.now() - startedAt,
          error: message,
        })
      }
    }

    return { stubs, seen, warnings }
  },
}
