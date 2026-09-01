import { env } from '../../../config/env.js'
import type { SourceAdapter } from '../runner.js'
import { fetchJson } from '../fetcher.js'
import type { ConnectorMeta } from '../connector.js'
import { recordSearchQuery } from '../query-log.js'
import type { DiscoveryContext, JobStub, RawSalary, SearchQuery } from '../types.js'

/**
 * Adzuna's aggregated search.
 *
 * Breadth, and a genuinely free tier. It covers India directly, which most
 * global aggregators do not, and it is the fallback when the Google-for-Jobs
 * provider rate-limits — two sources answering the same query plan is what
 * stops one provider's bad afternoon from emptying a user's run.
 *
 * It does not cover the Gulf. That is why Jooble sits alongside it.
 */

/** Adzuna is per-country: the code goes in the path, so the set is fixed. */
const SUPPORTED_MARKETS = [
  'gb', 'us', 'at', 'au', 'be', 'br', 'ca', 'ch', 'de', 'es',
  'fr', 'in', 'it', 'mx', 'nl', 'nz', 'pl', 'sg', 'za',
] as const

function marketPath(market: string | null): string | null {
  if (!market || market === 'remote') return 'gb'
  const lower = market.toLowerCase()
  return (SUPPORTED_MARKETS as readonly string[]).includes(lower) ? lower : null
}

interface AdzunaJob {
  id?: string
  title?: string
  description?: string
  created?: string
  redirect_url?: string
  salary_min?: number
  salary_max?: number
  salary_is_predicted?: string
  contract_time?: string
  company?: { display_name?: string }
  location?: { display_name?: string; area?: string[] }
}

function salaryFrom(job: AdzunaJob): RawSalary | undefined {
  // `salary_is_predicted` means Adzuna guessed it from the title. A guessed
  // number shown as though the employer stated it is worse than no number.
  if (job.salary_is_predicted === '1') return undefined
  const min = typeof job.salary_min === 'number' ? job.salary_min : null
  const max = typeof job.salary_max === 'number' ? job.salary_max : null
  if (min === null && max === null) return undefined
  return { min, max, currency: null, period: 'year', text: null }
}

async function search(query: SearchQuery, maxItems: number): Promise<JobStub[]> {
  const country = marketPath(query.market)
  if (!country) return []

  const params = new URLSearchParams({
    app_id: env.ADZUNA_APP_ID ?? '',
    app_key: env.ADZUNA_APP_KEY ?? '',
    results_per_page: String(Math.min(maxItems, 50)),
    what: query.keywords,
    max_days_old: '30',
    content_type: 'application/json',
  })
  if (query.locationText && !query.remoteOnly) params.set('where', query.locationText)

  const body = await fetchJson<{ results?: AdzunaJob[]; count?: number }>(
    `https://api.adzuna.com/v1/api/jobs/${country}/search/1?${params.toString()}`,
    { skipRobots: true, timeoutMs: 20_000 },
  )

  return (body.results ?? []).flatMap((job): JobStub[] => {
    const url = job.redirect_url
    if (!url || !job.title) return []
    return [
      {
        sourceId: String(job.id ?? url),
        portal: 'adzuna',
        url,
        title: job.title,
        company: job.company?.display_name ?? 'Unknown',
        locationText: job.location?.display_name ?? query.locationText ?? '',
        employmentType:
          job.contract_time === 'part_time'
            ? 'part_time'
            : job.contract_time === 'full_time'
              ? 'full_time'
              : undefined,
        descriptionText: job.description ?? undefined,
        tags: [],
        postedAt: job.created ?? new Date().toISOString(),
        postedAtPrecision: job.created ? 'exact' : 'first-seen',
        salary: salaryFrom(job),
        raw: job,
      },
    ]
  })
}

const configured = Boolean(env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY)

export const adzunaMeta: ConnectorMeta = {
  id: 'adzuna',
  tier: 1,
  markets: [...SUPPORTED_MARKETS.map((code) => code.toUpperCase()), 'remote'],
  needsSession: false,
  supports: { keyword: true, location: true },
  ...(configured
    ? {}
    : { unavailableReason: 'Set ADZUNA_APP_ID and ADZUNA_APP_KEY (the free tier covers 1,000 calls a month).' }),
}

export const adzunaSource: SourceAdapter = {
  id: 'adzuna',
  label: 'Adzuna',
  detailConcurrency: 2,

  async list(context: DiscoveryContext) {
    if (!configured) return { stubs: [], seen: 0, warnings: ['Adzuna is not configured.'] }
    const queries = context.queries ?? []
    if (queries.length === 0) return { stubs: [], seen: 0, warnings: ['No query plan for Adzuna.'] }

    const stubs: JobStub[] = []
    const warnings: string[] = []
    const skipped = new Set<string>()
    let seen = 0

    for (const query of queries) {
      if (stubs.length >= context.maxItems) break
      if (!marketPath(query.market)) {
        if (query.market) skipped.add(query.market)
        continue
      }
      const startedAt = Date.now()
      try {
        const found = await search(query, 50)
        seen += found.length
        stubs.push(...found)
        await recordSearchQuery({
          runId: context.runId,
          connectorId: 'adzuna',
          query: query.keywords,
          market: query.market,
          resultCount: found.length,
          durationMs: Date.now() - startedAt,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        warnings.push(`"${query.keywords}": ${message}`)
        await recordSearchQuery({
          runId: context.runId,
          connectorId: 'adzuna',
          query: query.keywords,
          market: query.market,
          resultCount: 0,
          durationMs: Date.now() - startedAt,
          error: message,
        })
      }
    }

    if (skipped.size > 0) {
      warnings.push(`Adzuna does not cover ${[...skipped].join(', ')} — other sources handled those.`)
    }
    return { stubs, seen, warnings }
  },
}
