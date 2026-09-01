import { extractSkills } from './discovery/extract/skills.js'
import { splitSections } from './discovery/extract/sections.js'
import { IMPLIED_BY, SKILL_TAXONOMY, TECHNICAL_CATEGORIES } from './discovery/extract/taxonomy.js'
import { keywordTokens } from './discovery/normalise.js'
import { classifyRole, type SoftwareFamily } from './role-filter.js'
import type { ExperienceRange, NormalisedLocation, RemoteMode } from './discovery/types.js'

/**
 * Scoring.
 *
 * The score answers one question: **can this candidate do this job?** So the
 * skill component measures how much of what the posting *asks for* the
 * candidate already has — not, as it did before, how many of the candidate's
 * skills happen to appear somewhere in the text. Those are different
 * questions, and the old one rewarded long postings for mentioning things.
 *
 * A posting that wants six technologies and the candidate has five of them
 * scores near the top. A posting that wants twenty, of which the candidate has
 * five, does not, even though the raw overlap is identical.
 *
 * Role suitability is not scored at all — `role-filter.ts` gates it, because a
 * product manager role is not a 60% software engineering job.
 */

export type RankingDecision =
  | 'eligible'
  | 'deal_breaker'
  | 'role_mismatch'
  | 'seniority_mismatch'
  | 'experience_mismatch'
  | 'insufficient_skills'
  | 'location_mismatch'
  | 'below_threshold'

export interface ScoreWeights {
  /** Share of the posting's required skills the candidate has. */
  coverage: number
  /** How much of the posting's stack is the candidate's own day-to-day stack. */
  stack: number
  experience: number
  seniority: number
  location: number
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  coverage: 45,
  stack: 20,
  experience: 12,
  seniority: 8,
  location: 15,
}

export function readWeights(value: unknown): ScoreWeights {
  if (!value || typeof value !== 'object') return DEFAULT_WEIGHTS
  const raw = value as Partial<Record<keyof ScoreWeights, unknown>>
  const weights = { ...DEFAULT_WEIGHTS }
  let touched = false
  for (const key of Object.keys(DEFAULT_WEIGHTS) as Array<keyof ScoreWeights>) {
    const candidate = Number(raw[key])
    if (Number.isFinite(candidate) && candidate >= 0 && candidate <= 100) {
      weights[key] = candidate
      touched = true
    }
  }
  if (!touched) return DEFAULT_WEIGHTS
  const total = Object.values(weights).reduce((sum, entry) => sum + entry, 0)
  if (total === 0) return DEFAULT_WEIGHTS
  // Normalise to 100 so a partial override cannot silently change the scale.
  const scale = 100 / total
  return {
    coverage: weights.coverage * scale,
    stack: weights.stack * scale,
    experience: weights.experience * scale,
    seniority: weights.seniority * scale,
    location: weights.location * scale,
  }
}

export interface RankableJob {
  title: string
  company: string
  locations: NormalisedLocation[]
  remote: RemoteMode
  /** Skills already extracted from the posting at scrape time. */
  skills: string[]
  experience: ExperienceRange
  descriptionText?: string | undefined
  tags?: string[]
}

export interface RankingInput {
  roles: string[]
  locations: string[]
  dreamCompanies: string[]
  dealBreakers: string[]
  skills: string[]
  maxYearsExperience: number
  minMatchScore: number
  weights?: ScoreWeights
}

export interface RankingResult {
  accepted: boolean
  decision: RankingDecision
  score: number
  matchedSkills: string[]
  /** Required skills the candidate does not have. */
  missingSkills: string[]
  breakdown: ScoreWeights
  reasons: string[]
}

const SENIOR_PATTERN = /\b(?:senior|sr\.?|staff|principal|lead|iii|iv|3|4)\b/i
const JUNIOR_PATTERN = /\b(?:junior|jr\.?|entry[\s-]?level|graduate|associate)\b|\b(?:engineer|developer|sde)\s*(?:i|1)\b/i

/**
 * Families closest to a backend/full-stack engineer's day job. A mobile or
 * data-engineering role is real software engineering and still a worse fit
 * than another backend role, so it is scaled rather than dropped.
 */
const FAMILY_FIT: Record<SoftwareFamily, number> = {
  backend: 1,
  fullstack: 1,
  generalist: 1,
  frontend: 0.95,
  platform: 0.9,
  devops: 0.7,
  'data-engineering': 0.7,
  mobile: 0.6,
  ml: 0.4,
  qa: 0.4,
}

const CORE_CATEGORIES = new Set(['language', 'frontend', 'backend', 'database', 'cloud', 'devops'])

const CANONICAL_BY_ALIAS = new Map<string, string>()
for (const entry of SKILL_TAXONOMY) {
  for (const alias of entry.aliases) CANONICAL_BY_ALIAS.set(alias.toLowerCase(), entry.name)
  CANONICAL_BY_ALIAS.set(entry.name.toLowerCase(), entry.name)
}

const CATEGORY_BY_NAME = new Map(SKILL_TAXONOMY.map((entry) => [entry.name, entry.category]))

function canonicalise(skill: string): string {
  return CANONICAL_BY_ALIAS.get(skill.trim().toLowerCase()) ?? skill.trim()
}

function canonicalSet(skills: string[]): Set<string> {
  return new Set(skills.map((skill) => canonicalise(skill)).filter(Boolean))
}

/**
 * The skills a posting actually asks for.
 *
 * Preference order is requirements section, then the posting's extracted skill
 * list. The cap matters: a JD that lists twenty five technologies is
 * describing a whole department, and letting the denominator run away makes
 * every such posting unmatchable regardless of fit.
 */
const MAX_REQUIRED = 12

function isTechnical(skill: string): boolean {
  const category = CATEGORY_BY_NAME.get(skill)
  // Unknown names come from a source's own skill list, which is technical far
  // more often than not; keeping them is the safer default.
  return category === undefined || TECHNICAL_CATEGORIES.has(category)
}

export function requiredSkillsOf(job: RankableJob): string[] {
  const text = job.descriptionText ?? ''
  if (text) {
    const sections = splitSections(text)
    const fromRequirements = extractSkills({
      title: job.title,
      descriptionText: text,
      sections,
      tags: job.tags ?? [],
      limit: 40,
    })
      .filter((skill) => skill.source === 'requirements' || skill.source === 'title' || skill.source === 'tags')
      .map((skill) => skill.name)
      .filter(isTechnical)
    if (fromRequirements.length >= 3) return fromRequirements.slice(0, MAX_REQUIRED)
  }
  return job.skills.map((skill) => canonicalise(skill)).filter(isTechnical).slice(0, MAX_REQUIRED)
}

/**
 * Expands a profile with the umbrella skills its concrete tools demonstrate,
 * so a posting asking for "Monitoring" is not counted against someone who runs
 * Grafana and Prometheus.
 */
function withImpliedSkills(profile: Set<string>): Set<string> {
  const expanded = new Set(profile)
  for (const [umbrella, evidence] of Object.entries(IMPLIED_BY)) {
    if (!expanded.has(umbrella) && evidence.some((skill) => profile.has(skill))) {
      expanded.add(umbrella)
    }
  }
  return expanded
}

interface Component {
  ratio: number
  reason: string
  weak: boolean
}

function scoreCoverage(required: string[], profile: Set<string>): Component & {
  matched: string[]
  missing: string[]
} {
  if (required.length === 0) {
    return {
      ratio: 0.5,
      reason: 'The posting does not list any recognisable skills',
      weak: false,
      matched: [],
      missing: [],
    }
  }
  const matched = required.filter((skill) => profile.has(skill))
  const missing = required.filter((skill) => !profile.has(skill))
  const ratio = matched.length / required.length
  return {
    ratio,
    reason: `You have ${matched.length} of the ${required.length} skills asked for${missing.length > 0 ? `; missing ${missing.slice(0, 5).join(', ')}` : ''}`,
    weak: ratio < 0.5,
    matched,
    missing,
  }
}

function scoreStack(job: RankableJob, profileCore: Set<string>): Component {
  const jobSkills = canonicalSet(job.skills)
  const shared = [...jobSkills].filter((skill) => profileCore.has(skill))
  // Five shared core technologies is a full mark: past that the posting is not
  // meaningfully more familiar, it is just longer.
  const ratio = Math.min(1, shared.length / 5)
  return {
    ratio,
    reason:
      shared.length > 0
        ? `Built on your stack: ${shared.slice(0, 6).join(', ')}`
        : 'None of your core technologies appear in this posting',
    weak: shared.length === 0,
  }
}

function scoreExperience(job: RankableJob, maxYears: number): Component {
  const required = job.experience.min
  if (required === null) {
    return { ratio: 0.7, reason: 'Years of experience not stated', weak: false }
  }
  if (required <= maxYears) {
    return { ratio: 1, reason: `Asks for ${required}+ years; within your ${maxYears}`, weak: false }
  }
  const over = required - maxYears
  if (over <= 1) return { ratio: 0.7, reason: `Asks for ${required} years, one above your ${maxYears}`, weak: false }
  if (over <= 3) return { ratio: 0.3, reason: `Asks for ${required} years, ${over} above your ${maxYears}`, weak: true }
  return { ratio: 0, reason: `Asks for ${required} years, far above your ${maxYears}`, weak: true }
}

function scoreSeniority(title: string, roles: string[]): Component {
  const wantsSenior = roles.some((role) => /\b(?:senior|sr\.?|staff|principal|lead)\b/i.test(role))
  const isJunior = JUNIOR_PATTERN.test(title)
  const isSenior = SENIOR_PATTERN.test(title)

  if (isJunior && wantsSenior) {
    return { ratio: 0.2, reason: 'Junior or associate level', weak: true }
  }
  if (wantsSenior && !isSenior) {
    return { ratio: 0.7, reason: 'Title does not state a seniority', weak: false }
  }
  return { ratio: 1, reason: isSenior ? 'Senior level matched' : 'Seniority matches', weak: false }
}

function scoreLocation(job: RankableJob, wanted: string[]): Component {
  if (wanted.length === 0) return { ratio: 1, reason: 'No location restriction', weak: false }

  const wantedText = wanted.join(' ').toLowerCase()
  const raw = job.locations.map((location) => location.raw).join(' ').toLowerCase()
  const wantedTokens = keywordTokens(wantedText).filter((token) => token !== 'remote')
  const locationTokens = keywordTokens(raw)
  if (wantedTokens.some((token) => locationTokens.includes(token))) {
    return { ratio: 1, reason: 'Preferred location matches', weak: false }
  }

  if (job.remote === 'remote') {
    const worldwide = /\b(anywhere|worldwide|global|any country)\b/i.test(raw) || raw.trim() === ''
    const countryRestricted = job.locations.some((location) => Boolean(location.countryCode))
    if (worldwide || !countryRestricted) {
      return { ratio: 1, reason: 'Worldwide remote role', weak: false }
    }
    return { ratio: 0.2, reason: 'Remote, but restricted to another country', weak: true }
  }
  if (job.remote === 'hybrid') {
    return { ratio: 0.15, reason: 'Hybrid, outside your locations', weak: true }
  }
  return { ratio: 0.05, reason: 'On-site outside your locations', weak: true }
}

export function rankJob(job: RankableJob, input: RankingInput): RankingResult {
  const weights = input.weights ?? DEFAULT_WEIGHTS
  const empty: ScoreWeights = { coverage: 0, stack: 0, experience: 0, seniority: 0, location: 0 }

  const verdict = classifyRole(job.title)
  if (verdict.kind === 'rejected') {
    return {
      accepted: false,
      decision: 'role_mismatch',
      score: 0,
      matchedSkills: [],
      missingSkills: [],
      breakdown: empty,
      reasons: [`Not a software engineering role: ${verdict.reason}`],
    }
  }

  const haystack = `${job.title} ${job.company} ${job.descriptionText ?? ''}`.toLowerCase()
  const blocker = input.dealBreakers
    .map((value) => value.trim())
    .filter(Boolean)
    .find((value) => haystack.includes(value.toLowerCase()))
  if (blocker) {
    return {
      accepted: false,
      decision: 'deal_breaker',
      score: 0,
      matchedSkills: [],
      missingSkills: [],
      breakdown: empty,
      reasons: [`Deal breaker matched: "${blocker}"`],
    }
  }

  const profile = withImpliedSkills(canonicalSet(input.skills))
  const profileCore = new Set(
    [...profile].filter((skill) => {
      const category = CATEGORY_BY_NAME.get(skill)
      return category !== undefined && CORE_CATEGORIES.has(category)
    }),
  )

  const required = requiredSkillsOf(job)
  const coverage = scoreCoverage(required, profile)
  const stack = scoreStack(job, profileCore.size > 0 ? profileCore : profile)
  const experience = scoreExperience(job, input.maxYearsExperience)
  const seniority = scoreSeniority(job.title, input.roles)
  const location = scoreLocation(job, input.locations)
  const familyFit = FAMILY_FIT[verdict.family]

  const breakdown: ScoreWeights = {
    // Family fit scales the two skill components rather than being its own
    // slice: a mobile role is not "missing points", it is a weaker version of
    // the same match.
    coverage: Math.round(coverage.ratio * familyFit * weights.coverage),
    stack: Math.round(stack.ratio * familyFit * weights.stack),
    experience: Math.round(experience.ratio * weights.experience),
    seniority: Math.round(seniority.ratio * weights.seniority),
    location: Math.round(location.ratio * weights.location),
  }
  const raw = Object.values(breakdown).reduce((sum, value) => sum + value, 0)
  // A job in the wrong place is not a slightly worse job — it is one that
  // cannot be taken. Losing fifteen points still left country-restricted
  // remote roles in the eighties, so a bad location caps the total instead.
  const LOCATION_CAP = 70
  const capped = location.ratio <= 0.2 ? Math.min(raw, LOCATION_CAP) : raw
  const score = Math.max(0, Math.min(100, capped))

  const reasons = [
    `${verdict.family === 'generalist' ? 'Software engineering' : verdict.family} role`,
    coverage.reason,
    stack.reason,
    experience.reason,
    seniority.reason,
    location.reason,
  ]

  if (score >= input.minMatchScore) {
    return {
      accepted: true,
      decision: 'eligible',
      score,
      matchedSkills: coverage.matched,
      missingSkills: coverage.missing,
      breakdown,
      reasons,
    }
  }

  const weakest: Array<[RankingDecision, Component, number]> = [
    ['insufficient_skills', coverage, weights.coverage],
    ['insufficient_skills', stack, weights.stack],
    ['experience_mismatch', experience, weights.experience],
    ['seniority_mismatch', seniority, weights.seniority],
    ['location_mismatch', location, weights.location],
  ]
  const worst = weakest
    .filter(([, component]) => component.weak)
    .sort((left, right) => (1 - left[1].ratio) * left[2] - (1 - right[1].ratio) * right[2])
    .at(-1)

  return {
    accepted: false,
    decision: worst?.[0] ?? 'below_threshold',
    score,
    matchedSkills: coverage.matched,
    missingSkills: coverage.missing,
    breakdown,
    reasons: [`Scored ${score}, below your minimum of ${input.minMatchScore}`, ...reasons],
  }
}
