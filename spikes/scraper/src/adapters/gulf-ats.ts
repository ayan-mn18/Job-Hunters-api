/**
 * Gulf / UAE — Tier 1, sanctioned.
 *
 * The finding that shaped this adapter: every Gulf-native *job board* is closed
 * to automation. Bayt's robots.txt disallows /en/jobs/, GulfTalent answers 403
 * from Akamai on every path including robots.txt, NaukriGulf refuses the
 * connection outright, and Dubizzle disallows /api/. There is no Gulf
 * equivalent of the RemoteOK API.
 *
 * But Gulf *employers* — Careem, Tamara, and the global remote companies that
 * staff Dubai and Riyadh — publish through the same ATSes everyone else uses,
 * and those ATSes expose documented public board APIs with exact publish
 * timestamps. Greenhouse's boards-api and Ashby's posting-api are the endpoints
 * that power the companies' own careers pages, so reading them is the intended
 * use, not a workaround.
 *
 * So: instead of fighting a hostile aggregator, we keep a curated registry of
 * employers that actually hire in the Gulf and read each one's board directly.
 * Adding a company is one line. The tradeoff is honest — this is high-precision
 * and low-recall, and recall depends entirely on how well the registry is
 * maintained.
 */
import { fetchJson } from '../http.ts'
import {
  GULF_COUNTRIES,
  fingerprintOf,
  inferRemoteMode,
  normaliseLocations,
  stripHtml,
} from '../normalise.ts'
import { isWithinWindow, representativeInstant, toInterval } from '../freshness.ts'
import type { AdapterContext, AdapterResult, PortalAdapter, ScrapedJob } from '../types.ts'

type AtsKind = 'greenhouse' | 'ashby'

interface RegistryEntry {
  /** Board token as it appears in the ATS URL. */
  token: string
  ats: AtsKind
  company: string
  /** Why it is in the registry — verified Gulf hiring, or global-remote. */
  note: string
}

/**
 * Verified live on 2026-08-07. Every entry here returned 200 and at least one
 * posting in a Gulf location. Grow this list; that is the maintenance cost of
 * the approach.
 */
export const GULF_EMPLOYERS: RegistryEntry[] = [
  { token: 'careem', ats: 'greenhouse', company: 'Careem', note: 'Dubai HQ, ride-hailing/super-app' },
  { token: 'tamara', ats: 'greenhouse', company: 'Tamara', note: 'Riyadh/Dubai fintech, BNPL' },
  { token: 'gitlab', ats: 'greenhouse', company: 'GitLab', note: 'all-remote, staffs Gulf roles' },
]

interface GreenhouseJob {
  id: number
  title: string
  absolute_url: string
  location: { name: string }
  first_published?: string
  updated_at?: string
  company_name?: string
  metadata?: unknown
}

interface AshbyJob {
  id: string
  title: string
  location?: string
  secondaryLocations?: Array<{ location?: string }>
  jobUrl?: string
  applyUrl?: string
  publishedAt?: string
  employmentType?: string
  descriptionHtml?: string
  descriptionPlain?: string
  isRemote?: boolean
  isListed?: boolean
  department?: string
  team?: string
}

/** Keep a posting only if it touches the Gulf, or is remote-and-plausible. */
function isGulfRelevant(locations: ReturnType<typeof normaliseLocations>): boolean {
  return locations.some(
    (l) => (l.countryCode && GULF_COUNTRIES.has(l.countryCode)) || l.isRemote,
  )
}

async function fetchGreenhouse(
  entry: RegistryEntry,
  ctx: AdapterContext,
  warnings: string[],
): Promise<{ seen: number; jobs: ScrapedJob[] }> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${entry.token}/jobs`
  const data = await fetchJson<{ jobs?: GreenhouseJob[] }>(url)
  const rows = data.jobs ?? []
  if (rows.length === 0) warnings.push(`${entry.company}: greenhouse board empty`)

  const fetchedAt = new Date().toISOString()
  const jobs: ScrapedJob[] = []

  for (const row of rows) {
    // first_published is the posting date; updated_at moves on any edit and
    // would make every job look fresh, so it is only a fallback.
    const interval = toInterval(row.first_published ?? row.updated_at, ctx.now)
    if (!interval) {
      warnings.push(`${entry.company}: no date on job ${row.id}`)
      continue
    }
    if (!isWithinWindow(interval, ctx.since, ctx.now)) continue

    const locationRaw = row.location?.name ?? ''
    const locations = normaliseLocations(locationRaw)
    if (!isGulfRelevant(locations)) continue

    const company = row.company_name?.trim() || entry.company
    jobs.push({
      sourceId: String(row.id),
      portal: 'gulf-ats',
      url: row.absolute_url,
      title: row.title.trim(),
      company,
      locations,
      remote: inferRemoteMode(locationRaw, locations),
      tags: ['greenhouse', entry.token],
      postedAt: representativeInstant(interval, ctx.now).toISOString(),
      postedAtPrecision: interval.precision,
      fetchedAt,
      fingerprint: fingerprintOf({ title: row.title, company, locations }),
      raw: row,
    })
  }

  return { seen: rows.length, jobs }
}

async function fetchAshby(
  entry: RegistryEntry,
  ctx: AdapterContext,
  warnings: string[],
): Promise<{ seen: number; jobs: ScrapedJob[] }> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${entry.token}?includeCompensation=true`
  const data = await fetchJson<{ jobs?: AshbyJob[] }>(url)
  const rows = (data.jobs ?? []).filter((j) => j.isListed !== false)
  if (rows.length === 0) warnings.push(`${entry.company}: ashby board empty`)

  const fetchedAt = new Date().toISOString()
  const jobs: ScrapedJob[] = []

  for (const row of rows) {
    const interval = toInterval(row.publishedAt, ctx.now)
    if (!interval) {
      warnings.push(`${entry.company}: no publishedAt on ${row.id}`)
      continue
    }
    if (!isWithinWindow(interval, ctx.since, ctx.now)) continue

    const locationRaw = [row.location, ...(row.secondaryLocations ?? []).map((s) => s?.location)]
      .filter(Boolean)
      .join('; ')
    const locations = normaliseLocations(locationRaw)
    if (!isGulfRelevant(locations)) continue

    jobs.push({
      sourceId: row.id,
      portal: 'gulf-ats',
      url: row.jobUrl ?? row.applyUrl ?? url,
      applyUrl: row.applyUrl,
      title: row.title.trim(),
      company: entry.company,
      locations,
      remote: row.isRemote ? 'remote' : inferRemoteMode(locationRaw, locations),
      employmentType: row.employmentType,
      descriptionHtml: row.descriptionHtml,
      descriptionText: row.descriptionPlain ?? stripHtml(row.descriptionHtml),
      tags: ['ashby', entry.token, row.department, row.team].filter(Boolean).map(String),
      postedAt: representativeInstant(interval, ctx.now).toISOString(),
      postedAtPrecision: interval.precision,
      fetchedAt,
      fingerprint: fingerprintOf({ title: row.title, company: entry.company, locations }),
      raw: row,
    })
  }

  return { seen: rows.length, jobs }
}

export const gulfAtsAdapter: PortalAdapter = {
  id: 'gulf-ats',
  label: 'Gulf employers (Greenhouse + Ashby boards)',
  tier: 1,
  legal: 'sanctioned',
  legalNote:
    'Documented public board APIs that power the employers’ own careers pages. No auth, no scraping of a third-party aggregator.',

  async fetchRecent(ctx: AdapterContext): Promise<AdapterResult> {
    const started = Date.now()
    const warnings: string[] = []
    const jobs: ScrapedJob[] = []
    let seen = 0

    for (const entry of GULF_EMPLOYERS) {
      if (jobs.length >= ctx.maxItems) break
      try {
        const res =
          entry.ats === 'greenhouse'
            ? await fetchGreenhouse(entry, ctx, warnings)
            : await fetchAshby(entry, ctx, warnings)
        seen += res.seen
        jobs.push(...res.jobs)
      } catch (err) {
        // One dead board must not sink the sweep — a company can change ATS at
        // any time, and that shows up here as a 404.
        warnings.push(
          `${entry.company} (${entry.ats}/${entry.token}) failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }

    return {
      portal: 'gulf-ats',
      seen,
      jobs: jobs.slice(0, ctx.maxItems),
      warnings,
      durationMs: Date.now() - started,
    }
  },
}
