import { scrape } from '../../lib/firecrawl.js'
import { logger } from '../../lib/logger.js'
import { normaliseEmploymentType } from '../../hunt/discovery/jsonld.js'
import type { SourceAdapter } from '../../hunt/discovery/runner.js'
import type { DiscoveryContext, JobDetail, JobStub, RemoteMode } from '../../hunt/discovery/types.js'

/**
 * Listing and reading Work at a Startup, through Firecrawl.
 *
 * The previous adapter fetched the HTML directly and pulled a JSON blob out of
 * it. That stopped working: the site now answers a plain HTTP client with 406
 * whatever user agent it sends, so the adapter was silently contributing zero
 * postings to every run. Firecrawl renders the page the way a browser would
 * and returns exactly the fields below.
 *
 * One credit per listing page, one per posting read. `PAGES` is small on
 * purpose — the board is not large, and the detail stage is where the cost is.
 */

const BASE = 'https://www.workatastartup.com'
const PAGES = 3

const LIST_SCHEMA = {
  type: 'object',
  properties: {
    jobs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          company: { type: 'string' },
          batch: { type: 'string', description: 'YC batch, e.g. S14 or W23.' },
          location: { type: 'string' },
          salary: { type: 'string' },
          url: { type: 'string', description: 'Absolute link to the posting.' },
        },
        required: ['title', 'company', 'url'],
      },
    },
  },
  required: ['jobs'],
}

interface ListedJob {
  title?: string
  company?: string
  batch?: string
  location?: string
  salary?: string
  url?: string
}

function idFromUrl(url: string): string | null {
  return /\/jobs\/(\d+)/.exec(url)?.[1] ?? null
}

function remoteFrom(location: string | undefined): RemoteMode | undefined {
  if (!location) return undefined
  if (/remote/i.test(location)) return /hybrid/i.test(location) ? 'hybrid' : 'remote'
  return undefined
}

export const workAtAStartupSource: SourceAdapter = {
  id: 'workatastartup',
  label: 'Work at a Startup (YC)',
  detailConcurrency: 2,

  async list(context: DiscoveryContext) {
    const stubs: JobStub[] = []
    const seenIds = new Set<string>()
    let seen = 0
    const warnings = [
      'Work at a Startup publishes no posting date; freshness is first-seen only.',
    ]

    for (let page = 1; page <= PAGES; page += 1) {
      if (stubs.length >= context.maxItems) break

      let rows: ListedJob[]
      try {
        const result = await scrape(page === 1 ? `${BASE}/jobs` : `${BASE}/jobs?page=${page}`, {
          formats: [],
          extract: {
            schema: LIST_SCHEMA,
            prompt: 'Extract every job posting listed on this page.',
          },
        })
        rows = ((result.json as { jobs?: ListedJob[] } | null)?.jobs ?? []).filter(Boolean)
      } catch (error) {
        warnings.push(`Page ${page} could not be read: ${error instanceof Error ? error.message : String(error)}`)
        break
      }

      seen += rows.length
      if (rows.length === 0) break

      let added = 0
      for (const row of rows) {
        if (!row.title || !row.company || !row.url) continue
        const id = idFromUrl(row.url)
        if (!id || seenIds.has(id)) continue
        seenIds.add(id)
        added += 1

        const remote = remoteFrom(row.location)
        stubs.push({
          sourceId: id,
          portal: 'workatastartup',
          url: `${BASE}/jobs/${id}`,
          title: row.title,
          company: row.company,
          locationText: row.location ?? '',
          ...(remote ? { remote } : {}),
          ...(row.salary?.trim()
            ? { salary: { min: null, max: null, currency: null, period: null, text: row.salary.trim() } }
            : {}),
          tags: ['workatastartup', row.batch ? `yc-${row.batch}` : ''].filter(Boolean),
          postedAt: context.now.toISOString(),
          postedAtPrecision: 'first-seen',
          raw: row,
        })
      }

      // Pagination that returns the same page twice is the usual sign the
      // board has run out; stop rather than paying for a fourth identical read.
      if (added === 0) break
    }

    return { stubs, seen, warnings }
  },

  async detail(stub: JobStub): Promise<JobDetail | null> {
    let markdown: string | null
    try {
      const result = await scrape(stub.url, { formats: ['markdown'], onlyMainContent: true })
      markdown = result.markdown
    } catch (error) {
      logger.debug({ err: error, url: stub.url }, 'waas detail read failed')
      return null
    }
    if (!markdown) return null

    const detail: JobDetail = { descriptionText: markdown }

    // The posting header is a run-on line of facts: "RemoteFull-timeUS
    // citizenship/visa not required3+ years". Reading it with narrow patterns
    // beats asking a model to summarise a page we already have in full.
    const employment = normaliseEmploymentType(
      /\b(full[- ]?time|part[- ]?time|contract|internship)\b/i.exec(markdown)?.[1] ?? '',
    )
    if (employment) detail.employmentType = employment

    if (/\bremote\b/i.test(markdown.slice(0, 800))) detail.remote = 'remote'

    const years = /(\d+)\+?\s*years?/i.exec(markdown.slice(0, 1200))
    if (years?.[1]) {
      detail.experience = { min: Number(years[1]), max: null, text: years[0] }
    }

    // The apply link goes through YC's sign-in and carries the job id, which is
    // what the apply skill needs to land on the right form after login.
    const applyUrl = /\((https:\/\/account\.ycombinator\.com\/authenticate[^)]+)\)/.exec(markdown)?.[1]
    if (applyUrl) detail.applyUrl = applyUrl.replace(/&amp;/g, '&')

    return detail
  },
}
