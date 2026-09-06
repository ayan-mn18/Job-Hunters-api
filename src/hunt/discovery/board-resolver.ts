import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { companyBoards, type CompanyBoard } from '../../db/schema.js'
import { logger } from '../../lib/logger.js'
import { fetchJson } from './fetcher.js'
import {
  ASHBY_BOARDS,
  companyNameFor,
  GREENHOUSE_BOARDS,
  LEVER_BOARDS,
  SMARTRECRUITERS_BOARDS,
  WORKABLE_BOARDS,
} from './boards.js'

/**
 * Which company boards to crawl, resolved from the database.
 *
 * The lists in `boards.ts` are now a *seed*, not the universe. They were the
 * reason discovery could only ever find what a fixed set of ~110 companies had
 * posted: a user naming a dream company the list did not contain got nothing,
 * with no indication why.
 *
 * Boards now arrive three ways — the original seed, a user's dream company
 * resolved by probing, and companies seen in tier-1 search results — and a
 * board that stops answering is retired rather than costing a request and a
 * warning on every run.
 */

export type Ats = 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters' | 'workable'

/** How many consecutive failures before a board is parked. */
const FAILURE_LIMIT = 5

/**
 * Cached for the life of a run. Discovery calls this once per ATS per run, and
 * a board list does not change mid-scrape.
 */
let cache: { at: number; boards: Map<Ats, string[]> } | null = null
const CACHE_TTL_MS = 60_000

export function clearBoardCache(): void {
  cache = null
}

export async function boardsFor(ats: Ats): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.boards.get(ats) ?? []
  }

  const rows = await db
    .select({ ats: companyBoards.ats, token: companyBoards.token })
    .from(companyBoards)
    .where(eq(companyBoards.isActive, true))
    .orderBy(desc(companyBoards.lastJobCount))

  const boards = new Map<Ats, string[]>()
  for (const row of rows) {
    const key = row.ats as Ats
    const list = boards.get(key)
    if (list) list.push(row.token)
    else boards.set(key, [row.token])
  }
  cache = { at: Date.now(), boards }
  return boards.get(ats) ?? []
}

/** Records what a board returned, so dead tokens stop costing a request. */
export async function recordBoardResult(
  ats: Ats,
  token: string,
  outcome: { ok: true; jobCount: number } | { ok: false },
): Promise<void> {
  const now = new Date()
  if (outcome.ok) {
    await db
      .update(companyBoards)
      .set({
        lastOkAt: now,
        lastCheckedAt: now,
        lastJobCount: outcome.jobCount,
        consecutiveFailures: 0,
        updatedAt: now,
      })
      .where(and(eq(companyBoards.ats, ats), eq(companyBoards.token, token)))
    return
  }

  await db
    .update(companyBoards)
    .set({
      lastCheckedAt: now,
      consecutiveFailures: sql`${companyBoards.consecutiveFailures} + 1`,
      // Park it once it has failed enough times in a row. Not deleted: a board
      // can come back, and the row records that we already know about it.
      isActive: sql`case when ${companyBoards.consecutiveFailures} + 1 >= ${FAILURE_LIMIT} then false else ${companyBoards.isActive} end`,
      updatedAt: now,
    })
    .where(and(eq(companyBoards.ats, ats), eq(companyBoards.token, token)))
}

/**
 * Bulk version, called once per ATS per run. Failures are recorded so a token
 * that has gone away stops costing a request and a warning every single run —
 * the original hardcoded lists had no way to express "this one is dead".
 */
export async function recordBoardResults(
  ats: Ats,
  results: Array<{ token: string; rows: unknown[]; error: string | null }>,
): Promise<void> {
  await Promise.all(
    results.map((result) =>
      recordBoardResult(
        ats,
        result.token,
        result.error ? { ok: false } : { ok: true, jobCount: result.rows.length },
      ).catch(() => undefined),
    ),
  )
}

/* ------------------------------------------------------------------ probing */

/** Candidate slugs for a company name, most likely first. */
export function slugCandidates(company: string): string[] {
  const base = company
    .trim()
    .toLowerCase()
    .replace(/\b(?:inc|llc|ltd|limited|corp|corporation|technologies|technology|labs|software)\b/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()

  const collapsed = base.replace(/\s+/g, '')
  const hyphenated = base.replace(/\s+/g, '-')
  return [...new Set([collapsed, hyphenated].filter((value) => value.length >= 2))]
}

interface ProbeResult {
  ats: Ats
  token: string
  jobCount: number
}

async function probeOne(ats: Ats, token: string): Promise<number | null> {
  const urls: Record<Ats, string> = {
    greenhouse: `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`,
    lever: `https://api.lever.co/v0/postings/${token}?mode=json&limit=1`,
    ashby: `https://api.ashbyhq.com/posting-api/job-board/${token}`,
    smartrecruiters: `https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=1`,
    workable: `https://apply.workable.com/api/v1/widget/accounts/${token}`,
  }

  try {
    const body = await fetchJson<unknown>(urls[ats], { timeoutMs: 10_000, retries: 0 })
    if (Array.isArray(body)) return body.length
    if (body && typeof body === 'object') {
      const record = body as Record<string, unknown>
      for (const key of ['jobs', 'content', 'jobPostings', 'postings']) {
        const value = record[key]
        if (Array.isArray(value)) return value.length
      }
      // Some endpoints answer 200 with a shape that carries no postings.
      return 0
    }
    return null
  } catch {
    return null
  }
}

/**
 * Finds which ATS a company uses, by asking each one whether it has a board
 * under a slug derived from the name.
 *
 * A guess, and it says so: only a board that actually returns postings is
 * stored. The alternative is asking the user to know what applicant tracking
 * system their dream employer runs, which nobody knows.
 */
export async function probeCompany(company: string): Promise<ProbeResult | null> {
  const candidates = slugCandidates(company)
  const platforms: Ats[] = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable']

  for (const token of candidates) {
    for (const ats of platforms) {
      const jobCount = await probeOne(ats, token)
      // Zero postings means the board exists but is empty today — still worth
      // keeping, because it will not be empty forever.
      if (jobCount !== null) return { ats, token, jobCount }
    }
  }
  return null
}

/**
 * Makes sure each named company has a board row, probing for any that do not.
 * Returns the ones it could not place, so the caller can tell the user rather
 * than silently dropping them.
 */
export async function ensureDreamCompanyBoards(companies: string[]): Promise<{
  resolved: string[]
  unresolved: string[]
}> {
  if (companies.length === 0) return { resolved: [], unresolved: [] }

  const existing = await db
    .select({ company: companyBoards.company })
    .from(companyBoards)
    .where(
      inArray(
        sql`lower(${companyBoards.company})`,
        companies.map((company) => company.trim().toLowerCase()),
      ),
    )
  const known = new Set(existing.map((row) => row.company.toLowerCase()))

  const resolved: string[] = []
  const unresolved: string[] = []

  for (const company of companies) {
    if (known.has(company.trim().toLowerCase())) {
      resolved.push(company)
      continue
    }
    const found = await probeCompany(company)
    if (!found) {
      unresolved.push(company)
      continue
    }
    await db
      .insert(companyBoards)
      .values({
        ats: found.ats,
        token: found.token,
        company: company.trim(),
        source: 'dream-company',
        lastOkAt: new Date(),
        lastCheckedAt: new Date(),
        lastJobCount: found.jobCount,
      })
      .onConflictDoNothing()
    resolved.push(company)
    logger.info({ company, ats: found.ats, token: found.token }, 'resolved a dream company board')
  }

  clearBoardCache()
  return { resolved, unresolved }
}

/* ------------------------------------------------------------------ seeding */

const SEED: Array<{ ats: Ats; tokens: readonly string[] }> = [
  { ats: 'greenhouse', tokens: GREENHOUSE_BOARDS },
  { ats: 'lever', tokens: LEVER_BOARDS },
  { ats: 'ashby', tokens: ASHBY_BOARDS },
  { ats: 'smartrecruiters', tokens: SMARTRECRUITERS_BOARDS },
  { ats: 'workable', tokens: WORKABLE_BOARDS },
]

/** Idempotent. Moves the original hardcoded lists into the table. */
export async function seedCompanyBoards(): Promise<number> {
  const values = SEED.flatMap(({ ats, tokens }) =>
    tokens.map((token) => ({
      ats,
      token,
      company: companyNameFor(token),
      source: 'seed',
    })),
  )
  if (values.length === 0) return 0

  const inserted = await db
    .insert(companyBoards)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: companyBoards.id })
  clearBoardCache()
  return inserted.length
}

export async function listBoards(): Promise<CompanyBoard[]> {
  return db.select().from(companyBoards).orderBy(companyBoards.ats, companyBoards.token)
}
