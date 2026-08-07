import crypto from 'node:crypto'
import type { NormalisedLocation, RemoteMode } from './types.js'

const COUNTRY_PATTERNS: Array<[RegExp, string]> = [
  [/\b(uae|u\.a\.e|united arab emirates|dubai|abu dhabi|sharjah|ajman)\b/i, 'AE'],
  [/\b(saudi|ksa|riyadh|jeddah|dammam|khobar|neom)\b/i, 'SA'],
  [/\b(qatar|doha)\b/i, 'QA'],
  [/\b(kuwait)\b/i, 'KW'],
  [/\b(bahrain|manama)\b/i, 'BH'],
  [/\b(oman|muscat)\b/i, 'OM'],
  [/\b(india|bengaluru|bangalore|mumbai|delhi|gurgaon|gurugram|noida|hyderabad|pune|chennai|kolkata|indore)\b/i, 'IN'],
  [/\b(united kingdom|uk|london|england)\b/i, 'GB'],
  [/\b(united states|usa|u\.s\.|new york|san francisco|austin|seattle)\b/i, 'US'],
  [/\b(canada|toronto|vancouver)\b/i, 'CA'],
  [/\b(germany|berlin|munich)\b/i, 'DE'],
  [/\b(singapore)\b/i, 'SG'],
]

const REMOTE_RE = /\b(remote|anywhere|work from home|wfh|distributed|worldwide)\b/i
const HYBRID_RE = /\bhybrid\b/i

const SKILL_NAMES = [
  'TypeScript', 'JavaScript', 'React', 'Next.js', 'Node.js', 'Express.js', 'Python',
  'Java', 'Go', 'Golang', 'C++', 'C#', 'Ruby', 'PHP', 'Swift', 'Kotlin', 'Android',
  'iOS', 'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'AWS', 'Azure', 'GCP', 'Docker',
  'Kubernetes', 'Terraform', 'GraphQL', 'REST', 'Machine Learning', 'Data Science',
  'Generative AI', 'LLM', 'LangChain', 'RAG', 'Figma', 'Product Management', 'SQL',
]

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

export function normaliseLocations(raw: string): NormalisedLocation[] {
  const chunks = raw.trim().split(/\s*;\s*|\s+\/\s+/).filter(Boolean)
  return (chunks.length > 0 ? chunks : ['']).map((value) => {
    const clean = value.trim()
    let countryCode: string | undefined
    for (const [pattern, code] of COUNTRY_PATTERNS) {
      if (pattern.test(clean)) {
        countryCode = code
        break
      }
    }
    const parts = clean.split(/[,|]/).map((part) => part.trim()).filter(Boolean)
    return {
      raw: clean,
      city: parts.length > 1 ? parts[0] : undefined,
      country: parts.length > 1 ? parts.at(-1) : undefined,
      countryCode,
      isRemote: REMOTE_RE.test(clean),
    }
  })
}

export function inferRemoteMode(text: string, locations: NormalisedLocation[]): RemoteMode {
  if (locations.some((location) => location.isRemote)) return 'remote'
  if (HYBRID_RE.test(text)) return 'hybrid'
  if (REMOTE_RE.test(text)) return 'remote'
  return locations.some((location) => location.raw.length > 0) ? 'onsite' : 'unknown'
}

function canonicalTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/\s+[-–—|/]\s+.*$/, ' ')
    .replace(/\bsr\.?\b/g, 'senior')
    .replace(/\bjr\.?\b/g, 'junior')
    .replace(/\beng\.?\b/g, 'engineer')
    .replace(/\bdev\.?\b/g, 'developer')
    .replace(/[^a-z0-9+#. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function canonicalCompany(company: string): string {
  return company
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(inc|llc|ltd|limited|gmbh|plc|corp|corporation|company|technologies|technology|labs|group|holdings|fz|fze|fzco|dmcc|pjsc|pvt|private)\b/g, ' ')
    .replace(/[^a-z0-9+& ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function fingerprintOf(title: string, company: string, locations: NormalisedLocation[]): string {
  const country = locations.find((location) => location.countryCode)?.countryCode
    ?? (locations.some((location) => location.isRemote) ? 'REMOTE' : 'UNKNOWN')
  return crypto
    .createHash('sha256')
    .update(`${canonicalCompany(company)}::${canonicalTitle(title)}::${country}`)
    .digest('hex')
}

export function hashText(text: string): string {
  return crypto.createHash('sha256').update(text.trim().replace(/\s+/g, ' ')).digest('hex')
}

export function extractSkills(text: string): string[] {
  const found = new Set<string>()
  for (const skill of SKILL_NAMES) {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text)) found.add(skill)
  }
  return [...found]
}

export function keywordTokens(text: string): string[] {
  const ignored: Record<string, true> = {
    and: true, the: true, for: true, with: true, from: true, this: true, that: true,
    engineer: true, developer: true, senior: true, junior: true, role: true,
  }
  return [...new Set(text.toLowerCase().match(/[a-z0-9+#.]{3,}/g) ?? [])]
    .filter((token) => ignored[token] !== true)
}
