/**
 * Location and text normalisation shared by every adapter, plus the
 * cross-portal fingerprint.
 *
 * The dedupe problem in one line: the same Senior Backend Engineer role at the
 * same company shows up on RemoteOK, We Work Remotely, the company's Greenhouse
 * board and LinkedIn, with four different ids, four different URLs and four
 * slightly different titles. We want one job.
 */
import { createHash } from 'node:crypto'
import type { NormalisedLocation, RemoteMode, ScrapedJob } from './types.ts'

const COUNTRY_PATTERNS: Array<[RegExp, string]> = [
  [/\b(uae|u\.a\.e|united arab emirates|dubai|abu dhabi|sharjah|ajman)\b/i, 'AE'],
  [/\b(saudi|ksa|riyadh|jeddah|dammam|khobar|neom)\b/i, 'SA'],
  [/\b(qatar|doha)\b/i, 'QA'],
  [/\b(kuwait)\b/i, 'KW'],
  [/\b(bahrain|manama)\b/i, 'BH'],
  [/\b(oman|muscat)\b/i, 'OM'],
  [/\b(india|bengaluru|bangalore|mumbai|delhi|gurgaon|gurugram|noida|hyderabad|pune|chennai|kolkata)\b/i, 'IN'],
  [/\b(egypt|cairo)\b/i, 'EG'],
  [/\b(pakistan|karachi|lahore|islamabad)\b/i, 'PK'],
  [/\b(jordan|amman)\b/i, 'JO'],
  [/\b(united kingdom|uk|london|england)\b/i, 'GB'],
  [/\b(united states|usa|u\.s\.|new york|san francisco|austin|seattle)\b/i, 'US'],
  [/\b(singapore)\b/i, 'SG'],
  [/\b(germany|berlin|munich)\b/i, 'DE'],
]

/** Countries the user is actually targeting: the Gulf, plus home market. */
export const GULF_COUNTRIES = new Set(['AE', 'SA', 'QA', 'KW', 'BH', 'OM'])

const REMOTE_RE = /\b(remote|anywhere|work from home|wfh|distributed|worldwide)\b/i
const HYBRID_RE = /\bhybrid\b/i

export function normaliseLocation(raw: string): NormalisedLocation {
  const clean = (raw ?? '').trim()
  const isRemote = REMOTE_RE.test(clean)

  let countryCode: string | undefined
  for (const [re, code] of COUNTRY_PATTERNS) {
    if (re.test(clean)) {
      countryCode = code
      break
    }
  }

  const parts = clean.split(/[,|]/).map((p) => p.trim()).filter(Boolean)
  return {
    raw: clean,
    city: parts.length > 1 ? parts[0] : undefined,
    country: parts.length > 1 ? parts[parts.length - 1] : undefined,
    countryCode,
    isRemote,
  }
}

/** Split the multi-location strings boards use ("Dubai, UAE; Cairo, Egypt"). */
export function normaliseLocations(raw: string): NormalisedLocation[] {
  const clean = (raw ?? '').trim()
  if (!clean) return [{ raw: '', isRemote: false }]
  const chunks = clean.split(/\s*;\s*|\s+\/\s+/).filter(Boolean)
  return (chunks.length ? chunks : [clean]).map(normaliseLocation)
}

export function inferRemoteMode(text: string, locations: NormalisedLocation[]): RemoteMode {
  if (locations.some((l) => l.isRemote)) return 'remote'
  if (HYBRID_RE.test(text)) return 'hybrid'
  if (REMOTE_RE.test(text)) return 'remote'
  return locations.length && locations[0]?.raw ? 'onsite' : 'unknown'
}

export function stripHtml(html: string | undefined): string | undefined {
  if (!html) return undefined
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Reduce a title to its meaningful core so "Senior Backend Engineer (Remote)",
 * "Sr. Backend Engineer" and "Backend Engineer - Senior" collapse together.
 */
export function canonicalTitle(title: string): string {
  return title
    .toLowerCase()
    // Drop parentheticals and bracketed noise: "(Remote)", "[Contract]".
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    // Drop everything after a separator — usually location or department.
    .replace(/\s+[-–—|/]\s+.*$/, ' ')
    .replace(/\bsr\.?\b/g, 'senior')
    .replace(/\bjr\.?\b/g, 'junior')
    .replace(/\beng\.?\b/g, 'engineer')
    .replace(/\bdev\.?\b/g, 'developer')
    .replace(/\bmgr\.?\b/g, 'manager')
    .replace(/\b(m\/f\/d|m\/w\/d|h\/f|all genders?|full[- ]?time|part[- ]?time|contract|remote|hybrid|onsite|urgent|hiring|new)\b/g, ' ')
    .replace(/[^a-z0-9+#. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const COMPANY_SUFFIXES =
  /\b(inc|llc|ltd|limited|gmbh|bv|b\.v|plc|corp|corporation|co|company|technologies|technology|tech|labs|lab|group|holdings|fz|fze|fzco|llc-fz|dmcc|pjsc|pvt|private)\b/g

export function canonicalCompany(company: string): string {
  return company
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(COMPANY_SUFFIXES, ' ')
    .replace(/[^a-z0-9+& ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The cross-portal dedupe key.
 *
 * Deliberately *excludes* portal, url, id, description and salary — those are
 * exactly the fields that differ between two listings of the same role. It
 * includes a coarse country bucket so a genuinely different Dubai vs Bengaluru
 * opening at the same company stays two jobs.
 */
export function fingerprintOf(input: {
  title: string
  company: string
  locations: NormalisedLocation[]
}): string {
  const country =
    input.locations.find((l) => l.countryCode)?.countryCode ??
    (input.locations.some((l) => l.isRemote) ? 'REMOTE' : 'UNKNOWN')

  const key = [canonicalCompany(input.company), canonicalTitle(input.title), country].join('::')
  return createHash('sha1').update(key).digest('hex').slice(0, 16)
}

/**
 * Portal preference when the same job arrives from several sources. Lower wins.
 * Company ATS beats aggregator, because the ATS is where the apply actually
 * happens and its data is first-hand.
 */
const PORTAL_RANK: Record<string, number> = {
  'gulf-ats': 0,
  greenhouse: 0,
  ashby: 0,
  remoteok: 1,
  weworkremotely: 1,
}

/**
 * Collapse duplicates across adapters, keeping the best copy and recording
 * where else it was seen.
 */
export interface DedupedJob extends ScrapedJob {
  /** Every portal this job was found on, including the winning one. */
  alsoSeenOn: string[]
  duplicateCount: number
}

export function dedupe(jobs: ScrapedJob[]): DedupedJob[] {
  const groups = new Map<string, ScrapedJob[]>()
  for (const job of jobs) {
    const g = groups.get(job.fingerprint)
    if (g) g.push(job)
    else groups.set(job.fingerprint, [job])
  }

  const out: DedupedJob[] = []
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => {
      const ra = PORTAL_RANK[a.portal] ?? 5
      const rb = PORTAL_RANK[b.portal] ?? 5
      if (ra !== rb) return ra - rb
      // Then prefer the copy with the most trustworthy timestamp.
      const pa = a.postedAtPrecision === 'exact' ? 0 : 1
      const pb = b.postedAtPrecision === 'exact' ? 0 : 1
      if (pa !== pb) return pa - pb
      // Then the richer record.
      return (b.descriptionText?.length ?? 0) - (a.descriptionText?.length ?? 0)
    })

    const winner = sorted[0]!
    out.push({
      ...winner,
      alsoSeenOn: [...new Set(group.map((j) => j.portal))],
      duplicateCount: group.length,
    })
  }

  return out.sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt))
}
