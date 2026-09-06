/**
 * Who can actually refer you, ranked.
 *
 * The instinct is to reach the most senior person available. That is wrong
 * twice over: a VP is less able to speak to your work than the senior engineer
 * on the team, and much likelier to ignore the message. The weights below
 * encode that, and two of them carry a real opinion.
 */

export type Relationship = 'first_degree' | 'strong_mutual' | 'alumni' | 'ex_colleague' | 'cold'

export interface Prospect {
  profileUrl: string
  name: string
  title: string | null
  degree: 1 | 2 | 3
  relationship: Relationship
  /** Same function as the target role — a backend engineer for a backend job. */
  sameFunction: boolean
  /** Their level relative to the target: -1 below, 0 same, +1 one above, +2 further. */
  levelDelta: number
  /** Recruiter or hiring manager, which is a different kind of ask. */
  isRecruiter: boolean
  sharedSchool: boolean
  sharedEmployer: boolean
  sharedCity: boolean
  skillOverlap: number
  mutualConnections: number
  /** Months since they joined this company, when known. */
  monthsAtCompany: number | null
  activeRecently: boolean
  openProfile: boolean
}

export interface RankedProspect extends Prospect {
  score: number
  signals: string[]
}

const RELATIONSHIP_SCORE: Record<Relationship, number> = {
  // Already connected: no invite needed, no risk taken, highest conversion.
  first_degree: 1,
  strong_mutual: 0.75,
  // A shared employer or school is the strongest cold open there is.
  ex_colleague: 0.7,
  alumni: 0.6,
  cold: 0.2,
}

/**
 * Authority caps at one level above.
 *
 * Someone at your level or just above can vouch for the work. Two levels up
 * they are approving a headcount, not reading your code, and the referral is
 * worth less even when it lands.
 */
export function authorityScore(input: Prospect): number {
  if (input.isRecruiter) return 0.55
  if (!input.sameFunction) return 0.25
  if (input.levelDelta < 0) return 0.35
  if (input.levelDelta === 0) return 0.9
  if (input.levelDelta === 1) return 1
  return 0.4
}

/**
 * Recency rewards recent joiners.
 *
 * Someone eighteen months in has a referral bonus to claim and no particular
 * loyalty to protect. Someone who has been there nine years is being asked to
 * spend social capital they have accumulated carefully.
 */
export function recencyScore(input: Prospect): number {
  let score = input.activeRecently ? 0.5 : 0.2
  const months = input.monthsAtCompany
  if (months !== null) {
    if (months <= 18) score += 0.5
    else if (months <= 36) score += 0.3
    else score += 0.1
  }
  return Math.min(1, score)
}

export function affinityScore(input: Prospect): number {
  let score = 0
  if (input.sharedEmployer) score += 0.4
  if (input.sharedSchool) score += 0.35
  if (input.sharedCity) score += 0.1
  score += Math.min(0.15, input.skillOverlap * 0.03)
  return Math.min(1, score)
}

export function reachabilityScore(input: Prospect): number {
  if (input.degree === 1) return 1
  let score = input.openProfile ? 0.6 : 0.3
  score += Math.min(0.4, input.mutualConnections * 0.08)
  return Math.min(1, score)
}

const WEIGHTS = {
  relationship: 0.35,
  authority: 0.25,
  affinity: 0.15,
  recency: 0.15,
  reachability: 0.1,
}

/** The one true, checkable thing a draft can open with. */
export function signalsFor(input: Prospect): string[] {
  const signals: string[] = []
  if (input.relationship === 'first_degree') signals.push('already connected')
  if (input.sharedEmployer) signals.push('worked at the same company')
  if (input.sharedSchool) signals.push('same school')
  if (input.mutualConnections > 0) {
    signals.push(`${input.mutualConnections} mutual connection${input.mutualConnections === 1 ? '' : 's'}`)
  }
  if (input.monthsAtCompany !== null && input.monthsAtCompany <= 18) signals.push('joined recently')
  if (input.sameFunction) signals.push('same kind of role')
  if (input.isRecruiter) signals.push('recruits for this team')
  return signals
}

export function scoreProspect(input: Prospect): RankedProspect {
  const score =
    WEIGHTS.relationship * RELATIONSHIP_SCORE[input.relationship] +
    WEIGHTS.authority * authorityScore(input) +
    WEIGHTS.affinity * affinityScore(input) +
    WEIGHTS.recency * recencyScore(input) +
    WEIGHTS.reachability * reachabilityScore(input)

  return {
    ...input,
    score: Math.round(score * 100),
    signals: signalsFor(input),
  }
}

/**
 * How many people to approach per company.
 *
 * Small on purpose. However this engine fails, it will not be from talking to
 * too few people — and five strangers from one company hearing from you the
 * same week is the pattern that gets noticed.
 */
export const MAX_PER_COMPANY = 8

export function rankProspects(prospects: Prospect[], limit = MAX_PER_COMPANY): RankedProspect[] {
  return prospects
    .map(scoreProspect)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
}

/**
 * A prospect with no signal at all is a cold message to a stranger, which is
 * the kind of outreach that gets reported rather than answered.
 */
export function worthContacting(prospect: RankedProspect): boolean {
  if (prospect.relationship === 'first_degree') return true
  return prospect.signals.length > 0 && prospect.score >= 35
}
