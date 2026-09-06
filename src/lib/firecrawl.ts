import { env, hasFirecrawl } from '../config/env.js'
import { logger } from './logger.js'

/**
 * Firecrawl: the read lane.
 *
 * Discovery has three ways to reach a job, and they are not interchangeable.
 * A board with a documented JSON API (Greenhouse, Lever, Ashby) is read
 * directly and always will be — it is free, it is clean, and putting a paid
 * scraper in front of it would buy worse data. A page that needs a session is
 * a browser's problem, not this file's. What is left is the middle: public
 * HTML that renders with JavaScript, sits behind a bot check, or simply
 * changes shape often enough that a hand-written parser rots. That is what
 * comes through here.
 *
 * Billing is per page — one credit a scrape, two per ten search results — so
 * every function in this file is something a caller should be able to count.
 * Nothing retries more than twice, and nothing crawls: `crawl` bills a credit
 * for every page it discovers, which is the easy way to spend a month's quota
 * on one misconfigured site.
 */

export class FirecrawlUnavailableError extends Error {
  constructor() {
    super('FIRECRAWL_API_KEY is not set — Firecrawl-backed sources are disabled.')
    this.name = 'FirecrawlUnavailableError'
  }
}

export class FirecrawlError extends Error {
  constructor(readonly status: number, message: string) {
    super(`Firecrawl ${status}: ${message}`)
    this.name = 'FirecrawlError'
  }
}

/** Formats we ask for. `json` is schema-constrained extraction, done by them. */
export type ScrapeFormat = 'markdown' | 'html' | 'rawHtml' | 'links' | 'summary'

export interface ScrapeOptions {
  formats?: ScrapeFormat[]
  /** Drops nav, footer and chrome. On by default — it is most of the noise. */
  onlyMainContent?: boolean
  /** A JSON Schema plus an optional prompt; the result arrives in `.json`. */
  extract?: { schema: unknown; prompt?: string }
  /**
   * `basic` is a plain fetch, `enhanced` pays for the anti-bot path, `auto`
   * starts basic and escalates on failure. Auto is the default because the
   * escalation is exactly the judgement call a per-site skill should not have
   * to encode.
   */
  proxy?: 'basic' | 'enhanced' | 'auto'
  /** Milliseconds to let the page settle before reading it. */
  waitFor?: number
  timeoutMs?: number
  /** Country code for geo-sensitive listings, e.g. an India-only board. */
  country?: string
}

export interface ScrapeResult {
  markdown: string | null
  html: string | null
  links: string[]
  json: unknown
  metadata: { title?: string; sourceURL?: string; statusCode?: number }
}

interface FirecrawlEnvelope<T> {
  success?: boolean
  data?: T
  error?: string
  warning?: string
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504])

async function call<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  if (!hasFirecrawl) throw new FirecrawlUnavailableError()

  let lastError: unknown
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(`${env.FIRECRAWL_API_BASE}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.FIRECRAWL_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })

      const json = (await response.json()) as FirecrawlEnvelope<T>
      if (response.ok && json.success !== false) {
        if (json.warning) logger.debug({ path, warning: json.warning }, 'firecrawl warning')
        return json.data as T
      }

      const error = new FirecrawlError(response.status, json.error ?? 'unknown error')
      if (!RETRYABLE.has(response.status) || attempt === 2) throw error
      lastError = error
    } catch (error) {
      if (error instanceof FirecrawlError && !RETRYABLE.has(error.status)) throw error
      if (attempt === 2) throw error
      lastError = error
    }
    // 1.2s then 3.6s, plus jitter. Their free tier allows ten calls a minute,
    // so a tight retry loop is itself the thing that produces the next 429.
    await new Promise((resolve) => setTimeout(resolve, 1_200 * 3 ** attempt + Math.random() * 400))
  }
  throw lastError instanceof Error ? lastError : new Error('Firecrawl request failed')
}

interface RawScrape {
  markdown?: string
  html?: string
  rawHtml?: string
  links?: string[]
  json?: unknown
  metadata?: { title?: string; sourceURL?: string; statusCode?: number }
}

/** One page, one credit. */
export async function scrape(url: string, options: ScrapeOptions = {}): Promise<ScrapeResult> {
  const formats: unknown[] = [...(options.formats ?? ['markdown'])]
  if (options.extract) {
    formats.push({
      type: 'json',
      schema: options.extract.schema,
      ...(options.extract.prompt ? { prompt: options.extract.prompt } : {}),
    })
  }

  const raw = await call<RawScrape>(
    '/scrape',
    {
      url,
      formats,
      onlyMainContent: options.onlyMainContent ?? true,
      proxy: options.proxy ?? 'auto',
      ...(options.waitFor ? { waitFor: options.waitFor } : {}),
      ...(options.country ? { location: { country: options.country } } : {}),
    },
    options.timeoutMs ?? 90_000,
  )

  return {
    markdown: raw.markdown ?? null,
    html: raw.html ?? raw.rawHtml ?? null,
    links: raw.links ?? [],
    json: raw.json ?? null,
    metadata: raw.metadata ?? {},
  }
}

export interface SearchHit {
  url: string
  title: string
  description: string
  markdown: string | null
}

/**
 * Web search, optionally scraping each hit in the same call.
 *
 * Two credits per ten results, and a great deal more if `scrapeResults` is on —
 * every scraped hit bills as its own page. The planner uses this to reach
 * postings on sites nobody has written an adapter for.
 */
export async function search(
  query: string,
  options: { limit?: number; country?: string; scrapeResults?: boolean; timeoutMs?: number } = {},
): Promise<SearchHit[]> {
  const raw = await call<{ web?: Array<{ url: string; title?: string; description?: string; markdown?: string }> }>(
    '/search',
    {
      query,
      limit: options.limit ?? 10,
      ...(options.country ? { location: options.country } : {}),
      ...(options.scrapeResults
        ? { scrapeOptions: { formats: ['markdown'], onlyMainContent: true } }
        : {}),
    },
    options.timeoutMs ?? 120_000,
  )

  return (raw.web ?? []).map((hit) => ({
    url: hit.url,
    title: hit.title ?? '',
    description: hit.description ?? '',
    markdown: hit.markdown ?? null,
  }))
}

/**
 * Every URL on a site, without fetching any of them.
 *
 * This is how a company's careers page becomes a list of posting URLs when the
 * company runs its own board. Cheap relative to crawling, and it is the only
 * safe way to answer "what is on this site" — `crawl` would bill a credit per
 * page discovered.
 */
export async function map(
  url: string,
  options: { search?: string; limit?: number; timeoutMs?: number } = {},
): Promise<string[]> {
  const raw = await call<{ links?: Array<string | { url: string }> }>(
    '/map',
    {
      url,
      ...(options.search ? { search: options.search } : {}),
      limit: options.limit ?? 200,
    },
    options.timeoutMs ?? 60_000,
  )
  return (raw.links ?? []).map((link) => (typeof link === 'string' ? link : link.url)).filter(Boolean)
}

export const firecrawl = { scrape, search, map }
