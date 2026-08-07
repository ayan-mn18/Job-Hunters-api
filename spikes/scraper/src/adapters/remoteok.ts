/**
 * RemoteOK — Tier 1, sanctioned.
 *
 * Public JSON API at https://remoteok.com/api. No key, no auth. The first
 * element of the array is a legal notice rather than a job; the rest carry an
 * `epoch` field, so freshness is exact to the second.
 *
 * Their terms (returned in that first element, and mirrored at
 * https://remoteok.com/legal) require that we link back to the RemoteOK posting
 * URL with a direct, followed link and credit RemoteOK as the source. We keep
 * `url` pointing at RemoteOK for exactly that reason — the UI must render it as
 * the source link. robots.txt sets Crawl-delay: 1, which we honour.
 */
import { fetchJson, setHostDelay } from '../http.ts'
import {
  fingerprintOf,
  inferRemoteMode,
  normaliseLocations,
  stripHtml,
} from '../normalise.ts'
import { isWithinWindow, representativeInstant, toInterval } from '../freshness.ts'
import type { AdapterContext, AdapterResult, PortalAdapter, ScrapedJob } from '../types.ts'

const ENDPOINT = 'https://remoteok.com/api'

interface RemoteOkLegal {
  legal: string
  last_updated?: number
}

interface RemoteOkJob {
  id?: string
  slug?: string
  epoch?: number
  date?: string
  company?: string
  company_logo?: string
  position?: string
  tags?: string[]
  description?: string
  location?: string
  salary_min?: number
  salary_max?: number
  url?: string
  apply_url?: string
}

type RemoteOkRow = Partial<RemoteOkLegal> & RemoteOkJob

export const remoteOkAdapter: PortalAdapter = {
  id: 'remoteok',
  label: 'RemoteOK',
  tier: 1,
  legal: 'sanctioned',
  legalNote:
    'Public JSON API, no auth. Terms require crediting RemoteOK and a direct followed link back to the posting.',

  async fetchRecent(ctx: AdapterContext): Promise<AdapterResult> {
    const started = Date.now()
    const warnings: string[] = []
    setHostDelay('remoteok.com', 1_100) // robots.txt Crawl-delay: 1

    try {
      const rows = await fetchJson<RemoteOkRow[]>(ENDPOINT)
      if (!Array.isArray(rows)) throw new Error('expected an array from /api')

      // Row 0 is the legal notice. Guard structurally rather than by index, in
      // case they ever drop or move it.
      const postings = rows.filter((r): r is RemoteOkJob => !('legal' in r && r.legal))
      const legalRow = rows.find((r) => 'legal' in r && r.legal)
      if (!legalRow) warnings.push('legal notice row missing — API shape may have changed')
      if (postings.length === 0) warnings.push('zero postings returned — likely a shape change')

      const jobs: ScrapedJob[] = []
      const fetchedAt = new Date().toISOString()

      for (const row of postings) {
        const interval = toInterval(row.epoch ?? row.date, ctx.now)
        if (!interval) {
          warnings.push(`no parseable date on ${row.id ?? row.slug ?? 'unknown'}`)
          continue
        }
        if (!isWithinWindow(interval, ctx.since, ctx.now)) continue

        const title = row.position?.trim()
        const company = row.company?.trim()
        if (!title || !company) {
          warnings.push(`missing title/company on ${row.id ?? 'unknown'}`)
          continue
        }

        const locationRaw = row.location?.trim() || 'Remote'
        const locations = normaliseLocations(locationRaw)
        const descriptionText = stripHtml(row.description)

        jobs.push({
          sourceId: String(row.id ?? row.slug),
          portal: 'remoteok',
          // Attribution requirement: this must be the link the UI renders.
          url: row.url ?? `https://remoteok.com/remote-jobs/${row.slug ?? row.id}`,
          applyUrl: row.apply_url,
          title,
          company,
          locations,
          remote: inferRemoteMode(`${locationRaw} ${title}`, locations),
          descriptionHtml: row.description,
          descriptionText,
          tags: (row.tags ?? []).map((t) => String(t).toLowerCase()),
          salary:
            row.salary_min || row.salary_max
              ? { min: row.salary_min, max: row.salary_max, currency: 'USD', period: 'year' }
              : undefined,
          postedAt: representativeInstant(interval, ctx.now).toISOString(),
          postedAtPrecision: interval.precision,
          fetchedAt,
          fingerprint: fingerprintOf({ title, company, locations }),
          raw: row,
        })

        if (jobs.length >= ctx.maxItems) break
      }

      return {
        portal: 'remoteok',
        seen: postings.length,
        jobs,
        warnings,
        durationMs: Date.now() - started,
      }
    } catch (err) {
      return {
        portal: 'remoteok',
        seen: 0,
        jobs: [],
        warnings,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      }
    }
  },
}
