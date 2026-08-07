import { keywordTokens } from './discovery/normalise.js'
import type { NormalisedLocation, ScrapedJob } from './discovery/types.js'

export interface RankingInput {
  roles: string[]
  locations: string[]
  dreamCompanies: string[]
  dealBreakers: string[]
  skills: string[]
  minMatchScore: number
}

export interface RankingResult {
  accepted: boolean
  score: number
  breakdown: {
    title: number
    skills: number
    location: number
    company: number
  }
  reasons: string[]
}

function overlap(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0
  const rightSet = new Set(right.map((value) => value.toLowerCase()))
  return left.filter((value) => rightSet.has(value.toLowerCase())).length
}

function locationScore(job: ScrapedJob, wanted: string[]): { score: number; reason: string } {
  if (wanted.length === 0) return { score: 20, reason: 'No location restriction' }
  const wantedText = wanted.join(' ').toLowerCase()
  const raw = job.locations.map((location) => location.raw).join(' ').toLowerCase()
  const wantedTokens = keywordTokens(wantedText)
  const locationTokens = keywordTokens(raw)
  const specificWanted = wantedTokens.filter((token) => token !== 'remote')
  if (overlap(specificWanted, locationTokens) > 0) {
    return { score: 20, reason: 'Preferred location matches' }
  }

  if (job.remote === 'remote' && wantedText.includes('remote')) {
    const explicitlyGlobal = /\b(anywhere|worldwide|global|any country)\b/i.test(raw)
    const countryRestricted = job.locations.some(
      (location: NormalisedLocation) => Boolean(location.countryCode),
    )
    if (explicitlyGlobal || !countryRestricted) return { score: 20, reason: 'Remote location matches' }
    return { score: 5, reason: 'Remote role appears country-restricted' }
  }
  return { score: 0, reason: 'Location does not match preferences' }
}

export function rankJob(job: ScrapedJob, input: RankingInput): RankingResult {
  const haystack = `${job.title} ${job.company} ${job.descriptionText ?? ''}`.toLowerCase()
  const blocker = input.dealBreakers.find((value) => haystack.includes(value.toLowerCase()))
  if (blocker) {
    return {
      accepted: false,
      score: 0,
      breakdown: { title: 0, skills: 0, location: 0, company: 0 },
      reasons: [`Deal breaker matched: ${blocker}`],
    }
  }

  const titleTokens = keywordTokens(job.title)
  const wantedRoleTokens = keywordTokens(input.roles.join(' '))
  const titleHits = overlap(titleTokens, wantedRoleTokens)
  const title = input.roles.length === 0 ? 35 : Math.min(35, titleHits * 12)

  const jobTokens = keywordTokens(`${job.descriptionText ?? ''} ${job.tags.join(' ')}`)
  const skillTokens = keywordTokens(input.skills.join(' '))
  const skillHits = overlap(jobTokens, skillTokens)
  const skills = skillTokens.length === 0 ? 15 : Math.min(35, Math.round((skillHits / skillTokens.length) * 70))

  const location = locationScore(job, input.locations)
  const company = input.dreamCompanies.some(
    (value) => value.toLowerCase() === job.company.toLowerCase(),
  ) ? 10 : 0

  const score = Math.min(100, title + skills + location.score + company)
  const reasons = [
    title > 0 ? `Role overlap contributes ${title}` : 'Role title has weak overlap',
    skillHits > 0 ? `${skillHits} profile skill matches` : 'No confirmed skill overlap',
    location.reason,
    ...(company > 0 ? ['Preferred company'] : []),
  ]

  return {
    accepted: score >= input.minMatchScore && location.score > 0,
    score,
    breakdown: { title, skills, location: location.score, company },
    reasons,
  }
}
