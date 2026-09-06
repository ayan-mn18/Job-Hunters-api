import { decodeEntities } from './html.js'
import type { EmploymentType, RawSalary } from './types.js'

/**
 * schema.org `JobPosting` reader.
 *
 * Most job pages — including every board that renders its postings for Google
 * for Jobs — ship a JSON-LD block with the description, the employment type,
 * the salary and often the required experience already structured. Reading it
 * is both more accurate and far less brittle than scraping the rendered DOM,
 * so it is the default detail path for every source without a native API.
 */

export interface JobPostingLd {
  title?: string
  company?: string
  descriptionHtml?: string
  employmentType?: EmploymentType
  datePosted?: string
  validThrough?: string
  locationText?: string
  isRemote?: boolean
  salary?: RawSalary
  /** schema.org expresses this in months; callers convert. */
  experienceMonths?: number
  experienceText?: string
  skills?: string[]
  responsibilitiesHtml?: string
  qualificationsHtml?: string
  applyUrl?: string
}

type JsonValue = Record<string, unknown>

const SCRIPT_PATTERN = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi

/**
 * Some sites emit JSON-LD with trailing commas or raw newlines inside strings,
 * which `JSON.parse` rejects. One repair pass is worth it — the alternative is
 * discarding the richest data on the page over a stray comma.
 */
function parseLoose(raw: string): unknown {
  const text = decodeEntities(raw.trim().replace(/^<!\[CDATA\[|\]\]>$/g, ''))
  try {
    return JSON.parse(text)
  } catch {
    try {
      return JSON.parse(text.replace(/,\s*([}\]])/g, '$1').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' '))
    } catch {
      return null
    }
  }
}

function flatten(node: unknown, out: JsonValue[], depth = 0): void {
  if (!node || depth > 6) return
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, out, depth + 1)
    return
  }
  if (typeof node !== 'object') return
  const value = node as JsonValue
  out.push(value)
  if ('@graph' in value) flatten(value['@graph'], out, depth + 1)
}

export function extractJsonLdNodes(html: string): JsonValue[] {
  const nodes: JsonValue[] = []
  for (const match of html.matchAll(SCRIPT_PATTERN)) {
    const body = match[1]
    if (!body) continue
    flatten(parseLoose(body), nodes)
  }
  return nodes
}

function typeOf(node: JsonValue): string[] {
  const value = node['@type'] ?? node.type
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return []
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number') return String(value)
  return undefined
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[,\s]/g, ''))
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const EMPLOYMENT_TYPES: Array<[RegExp, EmploymentType]> = [
  [/full[\s_-]?time|\bft\b|permanent/i, 'full_time'],
  [/part[\s_-]?time/i, 'part_time'],
  [/contract|contractor|freelance|consultan/i, 'contract'],
  [/intern/i, 'internship'],
  [/temporary|temp\b|seasonal/i, 'temporary'],
]

export function normaliseEmploymentType(value: unknown): EmploymentType | undefined {
  const raw = Array.isArray(value) ? value.map((item) => String(item)).join(' ') : text(value)
  if (!raw) return undefined
  for (const [pattern, type] of EMPLOYMENT_TYPES) {
    if (pattern.test(raw)) return type
  }
  return undefined
}

const PERIOD_MAP: Array<[RegExp, NonNullable<RawSalary['period']>]> = [
  [/hour|hourly|\/\s?hr\b/i, 'hour'],
  [/\bday|daily\b/i, 'day'],
  [/week/i, 'week'],
  [/month|\/\s?mo\b/i, 'month'],
  [/year|annual|yearly|\/\s?yr\b|p\.?a\.?/i, 'year'],
]

export function normalisePeriod(value: unknown): RawSalary['period'] {
  const raw = text(value)
  if (!raw) return null
  for (const [pattern, period] of PERIOD_MAP) {
    if (pattern.test(raw)) return period
  }
  return null
}

function readSalary(node: JsonValue): RawSalary | undefined {
  const source = (node.baseSalary ?? node.estimatedSalary) as JsonValue | undefined
  if (!source || typeof source !== 'object') return undefined
  const currency =
    text(source.currency) ??
    text((source.value as JsonValue | undefined)?.currency) ??
    text(node.salaryCurrency)
  const value = (source.value ?? source) as JsonValue
  const min = numeric(value.minValue)
  const max = numeric(value.maxValue)
  const single = numeric(value.value)
  const period = normalisePeriod(value.unitText ?? source.unitText ?? node.salaryUnit)
  const low = min ?? single
  const high = max ?? single
  if (low === null && high === null) return undefined
  return {
    min: low,
    max: high,
    currency: currency?.toUpperCase() ?? null,
    period,
    text: null,
  }
}

function readLocation(node: JsonValue): { locationText?: string; isRemote?: boolean } {
  const isRemote = /telecommute/i.test(String(node.jobLocationType ?? ''))
  const raw = node.jobLocation
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : []
  const parts: string[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const address = ((entry as JsonValue).address ?? entry) as JsonValue
    const chunk = [
      text(address.addressLocality),
      text(address.addressRegion),
      text(address.addressCountry) ??
        text((address.addressCountry as JsonValue | undefined)?.name),
    ]
      .filter(Boolean)
      .join(', ')
    if (chunk) parts.push(chunk)
  }
  if (parts.length === 0 && isRemote) {
    const requirements = node.applicantLocationRequirements
    const list = Array.isArray(requirements) ? requirements : requirements ? [requirements] : []
    for (const item of list) {
      const name = text((item as JsonValue)?.name)
      if (name) parts.push(`Remote, ${name}`)
    }
  }
  const result: { locationText?: string; isRemote?: boolean } = {}
  if (parts.length > 0) result.locationText = [...new Set(parts)].join('; ')
  if (isRemote) result.isRemote = true
  return result
}

function readExperience(node: JsonValue): { months?: number; textValue?: string } {
  const requirements = node.experienceRequirements
  if (!requirements) return {}
  if (typeof requirements === 'string') return { textValue: requirements }
  if (typeof requirements === 'object') {
    const value = requirements as JsonValue
    const months = numeric(value.monthsOfExperience)
    const description = text(value.description) ?? text(value.name)
    const result: { months?: number; textValue?: string } = {}
    if (months !== null && months >= 0 && months <= 600) result.months = months
    if (description) result.textValue = description
    return result
  }
  return {}
}

function readSkills(node: JsonValue): string[] | undefined {
  const raw = node.skills ?? node.knowsAbout
  if (!raw) return undefined
  const values = Array.isArray(raw) ? raw : [raw]
  const list = values
    .map((item) => (typeof item === 'object' && item ? text((item as JsonValue).name) : text(item)))
    .filter((item): item is string => Boolean(item))
    // A single comma-joined string is the common shape, so split it back out.
    .flatMap((item) => (item.includes(',') ? item.split(',') : [item]))
    .map((item) => item.trim())
    .filter((item) => item.length > 1 && item.length <= 60)
  return list.length > 0 ? [...new Set(list)] : undefined
}

/** Picks the JobPosting node out of a page's JSON-LD and maps it. */
export function readJobPosting(html: string): JobPostingLd | null {
  const nodes = extractJsonLdNodes(html)
  const node = nodes.find((item) => typeOf(item).some((value) => /jobposting/i.test(value)))
  if (!node) return null

  const organisation = node.hiringOrganization as JsonValue | undefined
  const experience = readExperience(node)
  const location = readLocation(node)
  const posting: JobPostingLd = {}

  const title = text(node.title) ?? text(node.name)
  if (title) posting.title = title
  const company = text(organisation?.name)
  if (company) posting.company = company
  const description = text(node.description)
  if (description) posting.descriptionHtml = description
  const employmentType = normaliseEmploymentType(node.employmentType)
  if (employmentType) posting.employmentType = employmentType
  const datePosted = text(node.datePosted)
  if (datePosted) posting.datePosted = datePosted
  const validThrough = text(node.validThrough)
  if (validThrough) posting.validThrough = validThrough
  if (location.locationText) posting.locationText = location.locationText
  if (location.isRemote) posting.isRemote = true
  const salary = readSalary(node)
  if (salary) posting.salary = salary
  if (experience.months !== undefined) posting.experienceMonths = experience.months
  if (experience.textValue) posting.experienceText = experience.textValue
  const skills = readSkills(node)
  if (skills) posting.skills = skills
  const responsibilities = text(node.responsibilities)
  if (responsibilities) posting.responsibilitiesHtml = responsibilities
  const qualifications = text(node.qualifications)
  if (qualifications) posting.qualificationsHtml = qualifications
  const applyUrl = text(node.url) ?? text((node.potentialAction as JsonValue | undefined)?.target)
  if (applyUrl) posting.applyUrl = applyUrl

  return posting
}
