import { logger } from '../../lib/logger.js'

/**
 * The one place discovery is allowed to touch the network.
 *
 * Every adapter went straight to `fetch()` before this file existed, which
 * meant nothing enforced politeness: a run could open fifty connections to the
 * same board in the same millisecond. Detail-stage scraping makes that a real
 * problem — it multiplies request count by the number of jobs — so all traffic
 * now funnels through a per-host gate with a rate limit, bounded concurrency,
 * retries, and a robots.txt check.
 */

export const USER_AGENT =
  'Huntly/0.2 (personal job-search assistant; +https://github.com/job-hunters)'

interface HostPolicy {
  /** Minimum gap between two request *starts* to the same host. */
  minIntervalMs: number
  maxConcurrent: number
}

/**
 * Documented public JSON APIs get a shorter gap than HTML pages we are merely
 * allowed to read. The defaults are deliberately slow: a run that takes twenty
 * extra seconds is cheaper than a board that blocks us.
 */
const HOST_POLICIES: Record<string, HostPolicy> = {
  'boards-api.greenhouse.io': { minIntervalMs: 120, maxConcurrent: 6 },
  'api.lever.co': { minIntervalMs: 150, maxConcurrent: 5 },
  'api.ashbyhq.com': { minIntervalMs: 200, maxConcurrent: 4 },
  'apply.workable.com': { minIntervalMs: 300, maxConcurrent: 4 },
  'api.smartrecruiters.com': { minIntervalMs: 200, maxConcurrent: 4 },
  'remotive.com': { minIntervalMs: 400, maxConcurrent: 3 },
  'www.arbeitnow.com': { minIntervalMs: 400, maxConcurrent: 3 },
  'jobicy.com': { minIntervalMs: 400, maxConcurrent: 3 },
  'remoteok.com': { minIntervalMs: 1200, maxConcurrent: 2 },
  'weworkremotely.com': { minIntervalMs: 1200, maxConcurrent: 2 },
  'www.workatastartup.com': { minIntervalMs: 1000, maxConcurrent: 2 },
}

const DEFAULT_POLICY: HostPolicy = { minIntervalMs: 1500, maxConcurrent: 2 }

function policyFor(host: string): HostPolicy {
  return HOST_POLICIES[host] ?? DEFAULT_POLICY
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* --------------------------------------------------------------- host gate */

class HostGate {
  private active = 0
  private lastStart = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly policy: HostPolicy) {}

  async acquire(): Promise<void> {
    if (this.active >= this.policy.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }
    this.active += 1
    const wait = this.lastStart + this.policy.minIntervalMs - Date.now()
    if (wait > 0) await sleep(wait)
    this.lastStart = Date.now()
  }

  release(): void {
    this.active -= 1
    this.waiting.shift()?.()
  }
}

const gates = new Map<string, HostGate>()

function gateFor(host: string): HostGate {
  let gate = gates.get(host)
  if (!gate) {
    gate = new HostGate(policyFor(host))
    gates.set(host, gate)
  }
  return gate
}

/* --------------------------------------------------------------- robots.txt */

interface RobotsRules {
  disallow: string[]
  allow: string[]
}

const robotsCache = new Map<string, Promise<RobotsRules>>()

/**
 * A deliberately small robots.txt reader: it honours `User-agent: *` and any
 * group naming us, and understands Allow/Disallow prefixes. It does not
 * implement crawl-delay (the host gate above is stricter than any value we
 * have seen) or wildcards beyond a trailing `*`.
 */
function parseRobots(body: string): RobotsRules {
  const rules: RobotsRules = { disallow: [], allow: [] }
  let applies = false
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? ''
    if (!line) continue
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const field = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    if (field === 'user-agent') {
      applies = value === '*' || value.toLowerCase().includes('huntly')
      continue
    }
    if (!applies) continue
    if (field === 'disallow' && value) rules.disallow.push(value)
    if (field === 'allow' && value) rules.allow.push(value)
  }
  return rules
}

async function robotsFor(origin: string): Promise<RobotsRules> {
  let pending = robotsCache.get(origin)
  if (!pending) {
    pending = (async () => {
      try {
        const response = await fetch(`${origin}/robots.txt`, {
          headers: { 'user-agent': USER_AGENT, accept: 'text/plain' },
          signal: AbortSignal.timeout(8000),
        })
        // A missing or server-errored robots.txt means "no rules published",
        // which is the same as permitted.
        if (!response.ok) return { disallow: [], allow: [] }
        return parseRobots(await response.text())
      } catch {
        return { disallow: [], allow: [] }
      }
    })()
    robotsCache.set(origin, pending)
  }
  return pending
}

function matchesRule(path: string, rule: string): boolean {
  if (rule.endsWith('*')) return path.startsWith(rule.slice(0, -1))
  return path.startsWith(rule)
}

export async function isAllowedByRobots(url: string): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const rules = await robotsFor(parsed.origin)
  const path = parsed.pathname + parsed.search
  // Longest matching rule wins, and Allow beats Disallow at equal length.
  let decision: { allowed: boolean; length: number } | null = null
  for (const rule of rules.disallow) {
    if (matchesRule(path, rule) && (!decision || rule.length > decision.length)) {
      decision = { allowed: false, length: rule.length }
    }
  }
  for (const rule of rules.allow) {
    if (matchesRule(path, rule) && (!decision || rule.length >= decision.length)) {
      decision = { allowed: true, length: rule.length }
    }
  }
  return decision?.allowed ?? true
}

/* ------------------------------------------------------------------ request */

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

export class RobotsDisallowedError extends Error {
  constructor(readonly url: string) {
    super(`robots.txt disallows ${url}`)
    this.name = 'RobotsDisallowedError'
  }
}

export interface FetchOptions {
  accept?: string
  timeoutMs?: number
  /** Attempts *after* the first one. */
  retries?: number
  /** Skip the robots.txt check — only for documented public API endpoints. */
  skipRobots?: boolean
  /** Extra request headers, e.g. an API key. Merged over the defaults. */
  headers?: Record<string, string>
  /** Defaults to GET. A few search APIs take their query in a POST body. */
  method?: 'GET' | 'POST'
  body?: string
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 15_000)
  }
  // 600ms, 1.8s, 5.4s — plus jitter so parallel adapters do not resynchronise.
  return Math.min(600 * 3 ** attempt, 8000) + Math.random() * 250
}

export async function request(url: string, options: FetchOptions = {}): Promise<Response> {
  const {
    accept = '*/*',
    timeoutMs = 15_000,
    retries = 2,
    skipRobots = false,
    headers = {},
    method = 'GET',
    body,
  } = options
  if (!skipRobots && !(await isAllowedByRobots(url))) throw new RobotsDisallowedError(url)

  const host = new URL(url).host
  const gate = gateFor(host)
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await gate.acquire()
    try {
      const response = await fetch(url, {
        method,
        headers: {
          accept,
          'user-agent': USER_AGENT,
          'accept-language': 'en-US,en;q=0.9',
          ...headers,
        },
        ...(body === undefined ? {} : { body }),
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.ok) return response
      const error = new HttpError(response.status, url, `${response.status} ${response.statusText} from ${host}`)
      if (!RETRYABLE_STATUS.has(response.status) || attempt === retries) throw error
      lastError = error
      // Drain the body so the socket can be reused instead of hanging around.
      await response.arrayBuffer().catch(() => undefined)
      await sleep(retryDelayMs(attempt, response.headers.get('retry-after')))
    } catch (error) {
      if (error instanceof HttpError && !RETRYABLE_STATUS.has(error.status)) throw error
      if (attempt === retries) throw error
      lastError = error
      await sleep(retryDelayMs(attempt, null))
    } finally {
      gate.release()
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Could not fetch ${url}`)
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const response = await request(url, { accept: 'application/json', skipRobots: true, ...options })
  return response.json() as Promise<T>
}

export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const response = await request(url, { accept: 'text/plain, */*;q=0.8', ...options })
  return response.text()
}

export async function fetchXml(url: string, options: FetchOptions = {}): Promise<string> {
  const response = await request(url, {
    accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
    skipRobots: true,
    ...options,
  })
  return response.text()
}

export async function fetchHtml(url: string, options: FetchOptions = {}): Promise<string> {
  const response = await request(url, {
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    ...options,
  })
  return response.text()
}

/* -------------------------------------------------------------- concurrency */

/**
 * Runs `worker` over `items` with at most `limit` in flight. Results keep the
 * input order; a rejected worker yields `null` rather than sinking the batch,
 * because one unreachable job page must never lose the other forty-nine.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<R | null>> {
  const results = new Array<R | null>(items.length).fill(null)
  let cursor = 0

  async function run(): Promise<void> {
    for (;;) {
      const index = cursor
      cursor += 1
      const item = items[index]
      if (index >= items.length || item === undefined) return
      try {
        results[index] = await worker(item, index)
      } catch (error) {
        logger.debug({ err: error, index }, 'concurrent worker failed')
        results[index] = null
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run))
  return results
}

/** Test seam — the gates and robots cache are module-level singletons. */
export function resetFetcherState(): void {
  gates.clear()
  robotsCache.clear()
}
