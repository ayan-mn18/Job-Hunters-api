/**
 * Polite HTTP client. One shared connection pool, per-host serialisation with a
 * configurable delay, retry with exponential backoff plus jitter, and
 * conditional GET so a daily sweep mostly costs 304s.
 *
 * undici rather than global fetch: we want an explicit Agent (connection reuse,
 * per-host limits, our own timeouts) and undici is the same engine Node's fetch
 * is built on, minus the parts we cannot configure.
 */
import { Agent, interceptors, request } from 'undici'

const agent = new Agent({
  connections: 8,
  keepAliveTimeout: 10_000,
  headersTimeout: 20_000,
  bodyTimeout: 30_000,
})
  // Follow redirects (WWR and several ATS boards 301 to a canonical host) and
  // transparently gunzip, so adapters only ever see final, decoded bodies.
  .compose(
    interceptors.redirect({ maxRedirections: 5 }),
    interceptors.decompress(),
  )

/**
 * Identify honestly. A real contact string in the UA is what separates a
 * well-behaved daily sweep from something that looks like an attack, and it
 * gives an operator someone to email instead of someone to block.
 */
export const USER_AGENT =
  'JobHuntersBot/0.1 (personal job-search agent; +https://github.com/ayan-mn18/Job-Hunters-api)'

interface HostState {
  /** Resolves when the next request to this host may start. */
  chain: Promise<void>
  minDelayMs: number
}

const hosts = new Map<string, HostState>()

/** Default gap between two requests to the same host. */
const DEFAULT_DELAY_MS = 1_100

export function setHostDelay(host: string, ms: number): void {
  const s = hosts.get(host)
  if (s) s.minDelayMs = ms
  else hosts.set(host, { chain: Promise.resolve(), minDelayMs: ms })
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Serialise requests per host with a minimum gap. Callers can fire off as many
 * fetches as they like; this keeps us to one in flight per host.
 */
function withHostLock<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const state = hosts.get(host) ?? { chain: Promise.resolve(), minDelayMs: DEFAULT_DELAY_MS }
  hosts.set(host, state)

  const result = state.chain.then(fn)
  // Advance the chain regardless of whether this request succeeded.
  state.chain = result.then(
    () => sleep(state.minDelayMs),
    () => sleep(state.minDelayMs),
  )
  return result
}

export interface CacheEntry {
  etag?: string
  lastModified?: string
  body: string
}

/**
 * In-memory for the spike. In the real worker this is a Redis hash keyed by
 * URL — that is what makes the 06:00 sweep cheap and keeps us off the portals'
 * radar, since an unchanged feed costs one 304.
 */
const conditionalCache = new Map<string, CacheEntry>()

export interface FetchOptions {
  headers?: Record<string, string>
  /** Send If-None-Match / If-Modified-Since from cache, and store the result. */
  conditional?: boolean
  retries?: number
  timeoutMs?: number
}

export interface FetchResult {
  status: number
  body: string
  headers: Record<string, string | string[] | undefined>
  /** True when the server answered 304 and `body` came from cache. */
  fromCache: boolean
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504])

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const { conditional = true, retries = 3 } = opts
  const host = new URL(url).host

  return withHostLock(host, async () => {
    let lastErr: unknown

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff with full jitter, so parallel adapters that trip
        // the same rate limit do not retry in lockstep.
        const base = Math.min(30_000, 1_000 * 2 ** (attempt - 1))
        await sleep(Math.random() * base)
      }

      try {
        const cached = conditional ? conditionalCache.get(url) : undefined
        const headers: Record<string, string> = {
          'user-agent': USER_AGENT,
          accept: '*/*',
          'accept-encoding': 'gzip, deflate',
          ...opts.headers,
        }
        if (cached?.etag) headers['if-none-match'] = cached.etag
        if (cached?.lastModified) headers['if-modified-since'] = cached.lastModified

        const res = await request(url, {
          method: 'GET',
          headers,
          dispatcher: agent,
        })

        if (res.statusCode === 304 && cached) {
          res.body.dump()
          return { status: 304, body: cached.body, headers: res.headers, fromCache: true }
        }

        // Honour Retry-After before we decide to give up.
        if (RETRYABLE.has(res.statusCode)) {
          const retryAfter = res.headers['retry-after']
          res.body.dump()
          if (attempt < retries) {
            const wait = Number(Array.isArray(retryAfter) ? retryAfter[0] : retryAfter)
            if (Number.isFinite(wait) && wait > 0) await sleep(Math.min(wait * 1000, 60_000))
            lastErr = new Error(`HTTP ${res.statusCode}`)
            continue
          }
          throw new Error(`HTTP ${res.statusCode} after ${retries} retries: ${url}`)
        }

        const body = await res.body.text()

        if (res.statusCode >= 400) {
          throw new Error(`HTTP ${res.statusCode}: ${url}`)
        }

        if (conditional) {
          const etag = res.headers['etag']
          const lastModified = res.headers['last-modified']
          conditionalCache.set(url, {
            etag: Array.isArray(etag) ? etag[0] : etag,
            lastModified: Array.isArray(lastModified) ? lastModified[0] : lastModified,
            body,
          })
        }

        return { status: res.statusCode, body, headers: res.headers, fromCache: false }
      } catch (err) {
        lastErr = err
        if (attempt === retries) break
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  })
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const res = await fetchText(url, {
    ...opts,
    headers: { accept: 'application/json', ...opts.headers },
  })
  return JSON.parse(res.body) as T
}

export async function closeHttp(): Promise<void> {
  await agent.close()
}
