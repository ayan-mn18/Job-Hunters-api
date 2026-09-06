import { env } from '../../../config/env.js'
import type { SourceAdapter } from '../runner.js'
import { request } from '../fetcher.js'
import type { ConnectorMeta } from '../connector.js'
import { recordSearchQuery } from '../query-log.js'
import type { DiscoveryContext, JobStub, SearchQuery } from '../types.js'

/**
 * Jooble.
 *
 * Here for one reason: the Gulf. Adzuna does not cover the UAE, Saudi Arabia
 * or Qatar, and those markets matter for this product. Jooble does, and it
 * aggregates the regional boards — Bayt, GulfTalent, Naukrigulf — that a
 * candidate there would actually be applying through.
 *
 * Its API is a POST with the key in the path, which is unusual enough to be
 * worth stating rather than looking like a mistake.
 */

/** Human-readable location per market, since Jooble takes text, not codes. */
const MARKET_LOCATION: Record<string, string> = {
  IN: 'India',
  AE: 'United Arab Emirates',
  SA: 'Saudi Arabia',
  QA: 'Qatar',
  SG: 'Singapore',
  GB: 'United Kingdom',
  US: 'United States',
  DE: 'Germany',
  CA: 'Canada',
  AU: 'Australia',
  NL: 'Netherlands',
}

interface JoobleJob {
  id?: number | string
  title?: string
  location?: string
  snippet?: string
  salary?: string
  source?: string
  type?: string
  link?: string
  company?: string
  updated?: string
}

async function search(query: SearchQuery, maxItems: number): Promise<JobStub[]> {
  const location = query.remoteOnly
    ? ''
    : (query.locationText ?? (query.market ? MARKET_LOCATION[query.market] : '') ?? '')

  const response = await request(`https://jooble.org/api/${env.JOOBLE_API_KEY ?? ''}`, {
    skipRobots: true,
    timeoutMs: 20_000,
    accept: 'application/json',
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    body: JSON.stringify({
      keywords: query.remoteOnly ? `${query.keywords} remote` : query.keywords,
      location,
      page: '1',
    }),
  })

  const body = (await response.json()) as { jobs?: JoobleJob[] }
  return (body.jobs ?? []).slice(0, maxItems).flatMap((job): JobStub[] => {
    if (!job.link || !job.title) return []
    return [
      {
        sourceId: String(job.id ?? job.link),
        portal: 'jooble',
        url: job.link,
        title: job.title,
        company: job.company?.trim() || 'Unknown',
        locationText: job.location ?? location,
        // `snippet` is a teaser, not a description — the shared detail stage
        // fetches the real posting.
        descriptionText: job.snippet ?? undefined,
        tags: job.source ? [job.source] : [],
        postedAt: job.updated ?? new Date().toISOString(),
        postedAtPrecision: job.updated ? 'exact' : 'first-seen',
        raw: job,
      },
    ]
  })
}

const configured = Boolean(env.JOOBLE_API_KEY)

export const joobleMeta: ConnectorMeta = {
  id: 'jooble',
  tier: 1,
  markets: [...Object.keys(MARKET_LOCATION), 'remote'],
  needsSession: false,
  supports: { keyword: true, location: true },
  ...(configured
    ? {}
    : { unavailableReason: 'Set JOOBLE_API_KEY — this is the connector that covers the Gulf markets.' }),
}

export const joobleSource: SourceAdapter = {
  id: 'jooble',
  label: 'Jooble',
  detailConcurrency: 2,

  async list(context: DiscoveryContext) {
    if (!configured) return { stubs: [], seen: 0, warnings: ['Jooble is not configured.'] }
    const queries = context.queries ?? []
    if (queries.length === 0) return { stubs: [], seen: 0, warnings: ['No query plan for Jooble.'] }

    const stubs: JobStub[] = []
    const warnings: string[] = []
    let seen = 0

    for (const query of queries) {
      if (stubs.length >= context.maxItems) break
      const startedAt = Date.now()
      try {
        const found = await search(query, 30)
        seen += found.length
        stubs.push(...found)
        await recordSearchQuery({
          runId: context.runId,
          connectorId: 'jooble',
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
          connectorId: 'jooble',
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
