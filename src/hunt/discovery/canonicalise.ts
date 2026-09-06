import type { ScrapedJob } from './types.js'

/**
 * Collapses the same posting arriving from several sources.
 *
 * Fingerprint dedupe already catches byte-identical repeats. It does not catch
 * the common case: Greenhouse publishes a role, an aggregator republishes it
 * with a shortened description and a tracking URL, and Google indexes both. To
 * the fingerprint they are three jobs. To a person they are one, listed three
 * times, eating three slots in a list they have to read.
 *
 * Which copy survives matters more than it looks. The aggregator's URL usually
 * lands on an interstitial that the apply runtime cannot complete, while the
 * ATS copy is a form it can fill. Keeping the wrong one turns an applicable
 * job into a dead end.
 */

/** Hosts whose postings can actually be applied to programmatically. */
const ATS_HOSTS = [
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'smartrecruiters.com',
  'workable.com',
  'myworkdayjobs.com',
  'workday.com',
]

export function isAtsUrl(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const host = new URL(url).hostname.toLowerCase()
    return ATS_HOSTS.some((ats) => host === ats || host.endsWith(`.${ats}`))
  } catch {
    return false
  }
}

function normaliseCompany(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(?:inc|llc|ltd|limited|corp|corporation|gmbh|pvt|private|technologies|technology)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
}

function normaliseTitle(value: string): string {
  return value
    .toLowerCase()
    // Roman and arabic seniority markers are the same job: "Engineer II" and
    // "Engineer 2" must collapse, or every posting appears twice.
    .replace(/\b(?:i{1,3}|iv|v)\b/g, (match) => String(['i', 'ii', 'iii', 'iv', 'v'].indexOf(match) + 1))
    .replace(/[^a-z0-9]/g, '')
}

/** Same company, same role, posted within a few days: one job. */
function canonicalKey(job: ScrapedJob): string {
  const week = Math.floor(Date.parse(job.postedAt) / (7 * 86_400_000))
  return `${normaliseCompany(job.company)}|${normaliseTitle(job.title)}|${week}`
}

/**
 * Ranks two copies of the same posting. Higher wins.
 *
 * An applicable URL beats a longer description: a rich listing nobody can
 * apply through is worth less than a thin one they can.
 */
function score(job: ScrapedJob): number {
  let value = 0
  if (isAtsUrl(job.applyUrl ?? job.url)) value += 1_000_000
  if (job.detailFetched) value += 100_000
  value += Math.min(job.descriptionText?.length ?? 0, 50_000)
  return value
}

export function canonicalise(jobs: ScrapedJob[]): ScrapedJob[] {
  const best = new Map<string, ScrapedJob>()

  for (const job of jobs) {
    const key = canonicalKey(job)
    const existing = best.get(key)
    if (!existing) {
      best.set(key, job)
      continue
    }
    const winner = score(job) > score(existing) ? job : existing
    const loser = winner === job ? existing : job
    // Keep the discarded copy's source visible: the user should still see that
    // this role was also on LinkedIn, even though we kept the Greenhouse one.
    const tags = new Set([...winner.tags, ...loser.tags])
    best.set(key, { ...winner, tags: [...tags] })
  }

  return [...best.values()]
}
