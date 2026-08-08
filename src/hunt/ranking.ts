import { keywordTokens } from './discovery/normalise.js'
import type { NormalisedLocation, ScrapedJob } from './discovery/types.js'

export type RankingDecision =
  | 'eligible'
  | 'deal_breaker'
  | 'role_mismatch'
  | 'seniority_mismatch'
  | 'experience_mismatch'
  | 'insufficient_skills'
  | 'location_mismatch'
  | 'below_threshold'

export interface RankingInput {
  roles: string[]
  locations: string[]
  dreamCompanies: string[]
  dealBreakers: string[]
  skills: string[]
  maxYearsExperience: number
  minMatchScore: number
}

export interface RankingResult {
  accepted: boolean
  decision: RankingDecision
  score: number
  matchedSkills: string[]
  breakdown: {
    title: number
    seniority: number
    skills: number
    location: number
    company: number
  }
  reasons: string[]
}

const SOFTWARE_ROLE_PATTERNS = [
  /\bsoftware\b.*\b(?:engineer|developer)\b/i,
  /\b(?:front[ -]?end|back[ -]?end|full[ -]?stack)\b.*\b(?:engineer|developer)\b/i,
  /\b(?:engineer|developer)\b.*\b(?:front[ -]?end|back[ -]?end|full[ -]?stack)\b/i,
  /\b(?:sde|software development engineer)\s*(?:i{1,4}|[1-4])?\b/i,
  /\b(?:java|react|node(?:\.js)?|typescript|javascript)\s+(?:engineer|developer)\b/i,
  /\bweb\s+(?:application\s+)?developer\b/i,
]

const EXCLUDED_ROLE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(?:qa|quality assurance|quality engineer|test engineer|tester|testing|sdet)\b|\b(?:engineer|developer)\b.*\btest\b/i, label: 'testing or QA' },
  { pattern: /\b(?:principal|staff|lead)\b/i, label: 'principal, staff, or lead seniority' },
  { pattern: /\b(?:working student|intern|internship|trainee|apprentice|graduate engineer)\b/i, label: 'student or internship' },
  { pattern: /\b(?:product manager|product owner|product analyst|project manager|program manager)\b/i, label: 'product or project management' },
  { pattern: /\b(?:marketing|sales|account executive|account manager|business development)\b/i, label: 'marketing or sales' },
  { pattern: /\b(?:customer success|customer support|technical support|support engineer)\b/i, label: 'customer support' },
  { pattern: /\b(?:data scientist|data analyst|business analyst|financial analyst)\b/i, label: 'data or business analysis' },
  { pattern: /\b(?:designer|recruiter|human resources|talent acquisition)\b/i, label: 'design or recruiting' },
  { pattern: /\b(?:devops|site reliability|sre|cloud engineer|security engineer|network engineer)\b/i, label: 'infrastructure or security' },
  { pattern: /\b(?:solutions? architect|enterprise architect|consultant|specialist)\b/i, label: 'architecture or specialist work' },
  { pattern: /\b(?:android|ios|mobile|embedded|firmware)\s+(?:engineer|developer)\b/i, label: 'mobile or embedded development' },
  { pattern: /\b(?:engineering manager|development manager|director of engineering|head of engineering)\b/i, label: 'engineering management' },
]

const JUNIOR_PATTERNS = [
  /\b(?:junior|jr\.?|entry[ -]?level|graduate|intern|trainee|apprentice|working student)\b/i,
  /\b(?:sde|software engineer|developer)\s*(?:i|1)\b/i,
]

const SENIOR_PATTERNS = [
  /\b(?:senior|sr\.?)\b/i,
  /\b(?:sde|software engineer|developer)\s*(?:iii|iv|3|4)\b/i,
]

const SKILL_ALIASES: Record<string, string[]> = {
  react: ['react', 'react.js', 'reactjs'],
  typescript: ['typescript'],
  javascript: ['javascript', 'ecmascript'],
  'node.js': ['node.js', 'nodejs', 'node js'],
  java: ['java', 'spring boot', 'spring framework'],
  postgresql: ['postgresql', 'postgres'],
  aws: ['aws', 'amazon web services'],
  docker: ['docker', 'containerization'],
  graphql: ['graphql'],
  redis: ['redis'],
  'ci/cd': ['ci/cd', 'continuous integration', 'continuous delivery'],
  python: ['python'],
  kubernetes: ['kubernetes', 'k8s'],
}

function emptyResult(decision: Exclude<RankingDecision, 'eligible' | 'below_threshold'>, reason: string): RankingResult {
  return {
    accepted: false,
    decision,
    score: 0,
    matchedSkills: [],
    breakdown: { title: 0, seniority: 0, skills: 0, location: 0, company: 0 },
    reasons: [reason],
  }
}

function overlap(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0
  const rightSet = new Set(right.map((value) => value.toLowerCase()))
  return left.filter((value) => rightSet.has(value.toLowerCase())).length
}

function locationScore(job: ScrapedJob, wanted: string[]): { matched: boolean; score: number; reason: string } {
  if (wanted.length === 0) return { matched: true, score: 15, reason: 'No location restriction' }
  const wantedText = wanted.join(' ').toLowerCase()
  const raw = job.locations.map((location) => location.raw).join(' ').toLowerCase()
  const wantedTokens = keywordTokens(wantedText).filter((token) => token !== 'remote')
  const locationTokens = keywordTokens(raw)
  if (overlap(wantedTokens, locationTokens) > 0) {
    return { matched: true, score: 15, reason: 'Preferred location matches' }
  }

  if (job.remote === 'remote' && wantedText.includes('remote')) {
    const explicitlyGlobal = /\b(anywhere|worldwide|global|any country)\b/i.test(raw)
    const countryRestricted = job.locations.some(
      (location: NormalisedLocation) => Boolean(location.countryCode),
    )
    if (explicitlyGlobal || !countryRestricted) {
      return { matched: true, score: 15, reason: 'Worldwide remote role' }
    }
    return { matched: false, score: 0, reason: 'Remote role is restricted to another country' }
  }
  return { matched: false, score: 0, reason: 'Location does not match preferences' }
}

function matchesSoftwareRole(title: string): boolean {
  return SOFTWARE_ROLE_PATTERNS.some((pattern) => pattern.test(title))
}

function matchProfileSkills(job: ScrapedJob, profileSkills: string[]): string[] {
  const text = `${job.title} ${job.descriptionText ?? ''} ${job.tags.join(' ')}`.toLowerCase()
  const matches: string[] = []
  for (const skill of [...new Set(profileSkills)]) {
    const key = skill.toLowerCase()
    const aliases = SKILL_ALIASES[key] ?? [key]
    if (aliases.some((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text)
    })) matches.push(skill)
  }
  return matches
}

export function extractRequiredExperienceYears(text: string): number | null {
  const rangePattern = /\b(\d{1,2})\s*(?:[-–—]|to)\s*\d{1,2}\s*(?:years?|yrs?)\s+(?:of\s+)?(?:relevant\s+|professional\s+|work\s+|hands-on\s+)?experience\b/gi
  const requirements: number[] = []
  for (const match of text.matchAll(rangePattern)) {
    const years = Number(match[1])
    if (Number.isInteger(years) && years >= 0 && years <= 50) requirements.push(years)
  }

  const withoutRanges = text.replace(rangePattern, ' ')
  const patterns = [
    /\b(?:minimum(?:\s+of)?|at\s+least)?\s*(\d{1,2})\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:relevant\s+|professional\s+|work\s+|hands-on\s+|software\s+engineering\s+)?experience\b/gi,
    /\bexperience\s*(?:of|:)?\s*(?:at\s+least\s*)?(\d{1,2})\+?\s*(?:years?|yrs?)\b/gi,
    /\b(\d{1,2})\+?\s*(?:years?|yrs?)\s+(?:building|developing|working\s+with|in\s+software\s+development|in\s+software\s+engineering)\b/gi,
  ]
  for (const pattern of patterns) {
    for (const match of withoutRanges.matchAll(pattern)) {
      const years = Number(match[1])
      if (Number.isInteger(years) && years >= 0 && years <= 50) requirements.push(years)
    }
  }
  return requirements.length > 0 ? Math.max(...requirements) : null
}

export function rankJob(job: ScrapedJob, input: RankingInput): RankingResult {
  const haystack = `${job.title} ${job.company} ${job.descriptionText ?? ''}`.toLowerCase()
  const blocker = input.dealBreakers.find((value) => haystack.includes(value.toLowerCase()))
  if (blocker) return emptyResult('deal_breaker', `Deal breaker matched: ${blocker}`)

  const excludedRole = EXCLUDED_ROLE_PATTERNS.find(({ pattern }) => pattern.test(job.title))
  if (excludedRole) {
    return emptyResult('role_mismatch', `Excluded role family: ${excludedRole.label}`)
  }
  if (!matchesSoftwareRole(job.title)) {
    return emptyResult('role_mismatch', 'Title is not software, frontend, backend, or full-stack engineering')
  }

  const wantsSenior = input.roles.some((role) => /\b(?:senior|sr\.?)\b/i.test(role))
  const matchedSkills = matchProfileSkills(job, input.skills)
  const location = locationScore(job, input.locations)
  const title = 35
  const company = input.dreamCompanies.some(
    (value) => value.toLowerCase() === job.company.toLowerCase(),
  ) ? 5 : 0
  const partialSkills = Math.min(30, matchedSkills.length * 5)

  if (wantsSenior && JUNIOR_PATTERNS.some((pattern) => pattern.test(job.title))) {
    return {
      accepted: false,
      decision: 'seniority_mismatch',
      score: Math.min(100, title + partialSkills + (location.matched ? location.score : 0) + company),
      matchedSkills,
      breakdown: { title, seniority: 0, skills: partialSkills, location: location.matched ? location.score : 0, company },
      reasons: ['Junior, student, or internship seniority is excluded'],
    }
  }
  if (wantsSenior && !SENIOR_PATTERNS.some((pattern) => pattern.test(job.title))) {
    return {
      accepted: false,
      decision: 'seniority_mismatch',
      score: Math.min(100, title + partialSkills + (location.matched ? location.score : 0) + company),
      matchedSkills,
      breakdown: { title, seniority: 0, skills: partialSkills, location: location.matched ? location.score : 0, company },
      reasons: ['Title does not indicate senior-level responsibility'],
    }
  }
  const requiredExperienceYears = extractRequiredExperienceYears(`${job.title} ${job.descriptionText ?? ''}`)
  if (requiredExperienceYears !== null && requiredExperienceYears > input.maxYearsExperience) {
    const seniority = wantsSenior ? 15 : 10
    return {
      accepted: false,
      decision: 'experience_mismatch',
      score: Math.min(100, title + seniority + partialSkills + (location.matched ? location.score : 0) + company),
      matchedSkills,
      breakdown: { title, seniority, skills: partialSkills, location: location.matched ? location.score : 0, company },
      reasons: [`Requires ${requiredExperienceYears} years; your maximum is ${input.maxYearsExperience}`],
    }
  }

  const seniority = wantsSenior ? 15 : 10
  const minimumSkillMatches = Math.min(3, input.skills.length)
  if (matchedSkills.length < minimumSkillMatches) {
    return {
      accepted: false,
      decision: 'insufficient_skills',
      score: Math.min(100, title + seniority + partialSkills + (location.matched ? location.score : 0) + company),
      matchedSkills,
      breakdown: { title, seniority, skills: partialSkills, location: location.matched ? location.score : 0, company },
      reasons: [`Only ${matchedSkills.length} confirmed skills matched; ${minimumSkillMatches} required`],
    }
  }

  const skills = Math.min(35, 15 + matchedSkills.length * 5)
  if (!location.matched) {
    return {
      accepted: false,
      decision: 'location_mismatch',
      score: Math.min(100, title + seniority + skills + company),
      matchedSkills,
      breakdown: { title, seniority, skills, location: 0, company },
      reasons: [location.reason, `${matchedSkills.length} confirmed skills matched: ${matchedSkills.join(', ')}`],
    }
  }

  const score = Math.min(100, title + seniority + skills + location.score + company)
  const reasons = [
    'Software engineering title matched',
    wantsSenior ? 'Senior-level title matched' : 'Requested seniority matched',
    `${matchedSkills.length} confirmed skills matched: ${matchedSkills.join(', ')}`,
    location.reason,
    ...(company > 0 ? ['Preferred company'] : []),
  ]

  return {
    accepted: score >= input.minMatchScore,
    decision: score >= input.minMatchScore ? 'eligible' : 'below_threshold',
    score,
    matchedSkills,
    breakdown: { title, seniority, skills, location: location.score, company },
    reasons,
  }
}
