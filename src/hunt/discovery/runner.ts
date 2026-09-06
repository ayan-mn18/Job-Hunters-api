import { logger } from '../../lib/logger.js'
import { buildScrapedJob } from './enrich.js'
import { fetchHtml, mapWithConcurrency, RobotsDisallowedError } from './fetcher.js'
import { htmlToInlineText } from './html.js'
import { readJobPosting } from './jsonld.js'
import { isSoftwareRole } from '../role-filter.js'
import type {
  AdapterResult,
  DiscoveryAdapter,
  DiscoveryContext,
  JobDetail,
  JobStub,
  ScrapedJob,
} from './types.js'

/**
 * The shared two-stage pipeline every source runs through.
 *
 * Stage one lists stubs, stage two fetches each job's own page. Adapters only
 * implement the parts that differ; freshness, capping, concurrency, caching,
 * enrichment and error accounting all live here so no source can quietly skip
 * them.
 */

export interface SourceAdapter {
  id: string
  label: string
  list(context: DiscoveryContext): Promise<{ stubs: JobStub[]; seen: number; warnings?: string[] }>
  /**
   * Optional. Sources whose list endpoint already returns the whole posting
   * (Greenhouse, Lever, Ashby and the remote-job APIs) leave this out — a
   * second request would cost time and politeness budget for nothing.
   */
  detail?: (stub: JobStub) => Promise<JobDetail | null>
  /** Detail requests in flight for this source. */
  detailConcurrency?: number
}

const DETAIL_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const detailCache = new Map<string, { at: number; detail: JobDetail | null }>()

function cacheKey(stub: JobStub): string {
  return `${stub.portal}:${stub.sourceId}:${stub.detailUrl ?? stub.url}`
}

export function clearDetailCache(): void {
  detailCache.clear()
}

/**
 * Generic detail reader for any source that renders a public job page: pull
 * the page and read its schema.org JobPosting block.
 */
export async function jsonLdDetail(url: string): Promise<JobDetail | null> {
  const html = await fetchHtml(url, { timeoutMs: 15_000, retries: 1 })
  const posting = readJobPosting(html)
  if (!posting) return null

  const detail: JobDetail = {}
  if (posting.descriptionHtml) detail.descriptionHtml = posting.descriptionHtml
  if (posting.employmentType) detail.employmentType = posting.employmentType
  if (posting.salary) detail.salary = posting.salary
  if (posting.locationText) detail.locationText = posting.locationText
  if (posting.isRemote) detail.remote = 'remote'
  if (posting.skills) detail.skills = posting.skills
  if (posting.datePosted) {
    const parsed = Date.parse(posting.datePosted)
    if (!Number.isNaN(parsed)) detail.postedAt = new Date(parsed).toISOString()
  }
  if (posting.experienceMonths !== undefined || posting.experienceText) {
    detail.experience = {
      min: posting.experienceMonths !== undefined ? Math.round(posting.experienceMonths / 12) : null,
      max: null,
      text: posting.experienceText ?? null,
    }
  }
  return detail
}

function withinWindow(stub: JobStub, context: DiscoveryContext): boolean {
  if (stub.postedAtPrecision === 'first-seen') return true
  const value = Date.parse(stub.postedAt)
  if (Number.isNaN(value)) return false
  // A six-hour grace on the upper bound: some boards stamp postings in a
  // timezone ahead of ours and would otherwise look like they are from
  // tomorrow.
  return value >= context.since.getTime() && value <= context.now.getTime() + 21_600_000
}

/** True when the stub already carries a full posting, so detail adds nothing. */
function alreadyComplete(stub: JobStub): boolean {
  const length = stub.descriptionHtml
    ? htmlToInlineText(stub.descriptionHtml).length
    : (stub.descriptionText?.length ?? 0)
  return length >= 900
}

/**
 * Some feeds mix company profile pages and placeholder listings in with real
 * postings — "Open Vacancies", "Our vacancies", a 404 body. They are not jobs,
 * and letting them through means the dashboard shows rows nobody can apply to.
 */
const NON_JOB_TITLES =
  /^(?:various|open\s+vacancies|our\s+vacanc(?:y|ies)|vacancies|careers?|jobs?|we(?:'|’)?re\s+hiring|hiring|join\s+us|apply\s+now|think\s+we\s+could\s+be\s+a\s+good\s+fit|company\s+profile)\b/i

const JUNK_BODY = /oops,?\s+it\s+looks\s+like\s+there(?:'|’)?s\s+nothing\s+here|page\s+not\s+found|404\s+error/i

function looksLikeJob(job: ScrapedJob): boolean {
  const title = job.title.trim()
  if (title.length < 3 || title.length > 160) return false
  if (NON_JOB_TITLES.test(title)) return false
  // Real job titles are either multi-word or a long single word ("Accountant",
  // "Recruiter"). "Test" and "Demo" are neither.
  if (!title.includes(' ') && title.length < 8) return false
  if (JUNK_BODY.test(job.descriptionText ?? '')) return false
  // A posting with no description, no skills and no duties carries nothing a
  // person could act on.
  const length = job.descriptionText?.length ?? 0
  if (length < 200 && job.skills.length < 2 && job.responsibilities.length === 0) return false
  return true
}

export function toDiscoveryAdapter(source: SourceAdapter): DiscoveryAdapter {
  return {
    id: source.id,
    label: source.label,
    async fetchRecent(context: DiscoveryContext): Promise<AdapterResult> {
      const started = Date.now()
      const warnings: string[] = []
      let detailFetched = 0
      let detailFailed = 0

      let listed: Awaited<ReturnType<SourceAdapter['list']>>
      try {
        listed = await source.list(context)
      } catch (error) {
        return {
          portal: source.id,
          seen: 0,
          jobs: [],
          warnings,
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - started,
          detailFetched: 0,
          detailFailed: 0,
        }
      }
      warnings.push(...(listed.warnings ?? []))

      // The role gate runs on the title, before the detail stage. At tens of
      // thousands of listings, fetching a job page for a copywriter posting we
      // are about to discard is the single most expensive thing we could do.
      const inWindow = listed.stubs.filter((stub) => withinWindow(stub, context))
      const wanted = context.softwareOnly === false
        ? inWindow
        : inWindow.filter((stub) => isSoftwareRole(stub.title))
      const rejectedByRole = inWindow.length - wanted.length
      const fresh = wanted.slice(0, context.maxItems)
      const fetchedAt = context.now.toISOString()

      const details = await mapWithConcurrency(
        fresh,
        source.detailConcurrency ?? 4,
        async (stub): Promise<JobDetail | null> => {
          if (context.skipDetail || !source.detail || alreadyComplete(stub)) return null
          const key = cacheKey(stub)
          const cached = detailCache.get(key)
          if (cached && Date.now() - cached.at < DETAIL_CACHE_TTL_MS) {
            if (cached.detail) detailFetched += 1
            return cached.detail
          }
          try {
            const detail = await source.detail(stub)
            detailCache.set(key, { at: Date.now(), detail })
            if (detail) detailFetched += 1
            else detailFailed += 1
            return detail
          } catch (error) {
            detailFailed += 1
            if (error instanceof RobotsDisallowedError) {
              // Recorded once per portal rather than once per job.
              if (!warnings.some((warning) => warning.startsWith('robots.txt'))) {
                warnings.push(`robots.txt blocks detail pages; using list data only`)
              }
            } else {
              logger.debug({ err: error, url: stub.url, portal: stub.portal }, 'detail fetch failed')
            }
            return null
          }
        },
      )

      const built = fresh.map((stub, index) => buildScrapedJob(stub, details[index] ?? null, fetchedAt))

      // Boards routinely list one posting several times — once per location on
      // Lever, once per region elsewhere. Deduplicating here rather than at
      // insert time keeps the counts honest and stops five copies of the same
      // role eating the run's item budget.
      const byFingerprint = new Map<string, ScrapedJob>()
      let dropped = 0
      for (const job of built) {
        if (!looksLikeJob(job)) {
          dropped += 1
          continue
        }
        const existing = byFingerprint.get(job.fingerprint)
        // Keep whichever copy carries more description.
        if (!existing || (job.descriptionText?.length ?? 0) > (existing.descriptionText?.length ?? 0)) {
          byFingerprint.set(job.fingerprint, job)
        }
      }
      const jobs = [...byFingerprint.values()]
      const duplicates = built.length - dropped - jobs.length
      if (dropped > 0) warnings.push(`${dropped} listing${dropped === 1 ? '' : 's'} skipped as non-jobs`)
      if (duplicates > 0) warnings.push(`${duplicates} duplicate posting${duplicates === 1 ? '' : 's'} merged`)
      if (rejectedByRole > 0) warnings.push(`${rejectedByRole} non-software role${rejectedByRole === 1 ? '' : 's'} filtered out`)

      return {
        portal: source.id,
        seen: listed.seen,
        jobs,
        warnings,
        durationMs: Date.now() - started,
        detailFetched,
        detailFailed,
      }
    },
  }
}
