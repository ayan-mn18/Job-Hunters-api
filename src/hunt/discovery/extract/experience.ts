import { splitSections, textOfKinds, type Section } from './sections.js'
import type { ExperienceRange } from '../types.js'

/**
 * Years-of-experience parsing.
 *
 * The old version only ever produced a single number and only from a handful
 * of shapes, so "2 to 4 years", "minimum three (3) years" and "freshers
 * welcome" all came back as "unknown" — and unknown meant the job silently
 * passed the experience gate. This returns a range, keeps the phrase it came
 * from, and prefers a match inside the requirements section over a stray
 * mention in the company blurb.
 */

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15,
}

const NUMBER = '(\\d{1,2}|zero|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen)'
const YEARS = '(?:\\+\\s*)?(?:years?|yrs?)'
/**
 * What has to sit near the number for it to be about the candidate.
 *
 * This was a fixed list of allowed qualifiers ("relevant", "professional", …),
 * which missed every posting that wrote something else — "7+ years of
 * enterprise SaaS sales experience", "2 years of clinical experience". Any run
 * of words is allowed now, but only up to 60 characters and never across a
 * sentence boundary, so it still cannot reach into the next thought.
 */
const CONTEXT = '(?:of\\s+)?[^.;\\n]{0,60}?(?:experience|expertise|background|track\\s+record|proven\\s+success|\\bexp\\b)'

interface Candidate {
  min: number | null
  max: number | null
  text: string
  weight: number
  /** Character offset of the match, used to find the headline requirement. */
  at: number
}

function toNumber(token: string | undefined): number | null {
  if (!token) return null
  const word = WORD_NUMBERS[token.toLowerCase()]
  if (word !== undefined) return word
  const value = Number(token)
  return Number.isInteger(value) && value >= 0 && value <= 50 ? value : null
}

/** `3-5 years of experience`, `2 to 4 yrs experience` */
const RANGE = new RegExp(
  `\\b${NUMBER}\\s*(?:[-–—]|to|and)\\s*${NUMBER}\\s*${YEARS}\\s*${CONTEXT}`,
  'gi',
)
/** `5+ years of experience`, `minimum of three (3) years experience` */
const SINGLE = new RegExp(
  `\\b(?:minimum(?:\\s+of)?|min\\.?|at\\s+least|over|more\\s+than|upwards\\s+of)?\\s*${NUMBER}\\s*(?:\\(\\s*\\d{1,2}\\s*\\)\\s*)?(\\+|\\s+or\\s+more)?\\s*${YEARS}\\s*${CONTEXT}`,
  'gi',
)
/** `experience: 3+ years`, `experience of at least 2 years` */
const TRAILING = new RegExp(
  `\\bexperience\\s*(?:of|:|-|–)?\\s*(?:at\\s+least\\s+|minimum\\s+(?:of\\s+)?)?${NUMBER}\\s*(\\+)?\\s*${YEARS}`,
  'gi',
)
/** `3+ years building distributed systems` — no "experience" noun at all. */
const ACTIVITY = new RegExp(
  `\\b${NUMBER}\\s*(\\+)?\\s*${YEARS}\\s+(?:of\\s+)?(?:building|developing|writing|shipping|leading|managing|designing|selling|working\\s+(?:with|on|in|as)|as\\s+an?\\b|in\\s+[a-z][^.;\\n]{0,40}|with\\s+[a-z][^.;\\n]{0,40})`,
  'gi',
)

const FRESHER =
  /\b(?:fresher|freshers|fresh\s+graduates?|entry[\s-]level|no\s+(?:prior\s+)?experience\s+(?:is\s+)?(?:required|necessary)|0\s*[-–]\s*1\s*years?)\b/i

function collect(text: string, weight: number, into: Candidate[]): void {
  for (const match of text.matchAll(RANGE)) {
    const min = toNumber(match[1])
    const max = toNumber(match[2])
    if (min === null && max === null) continue
    into.push({ min, max, text: match[0].trim(), weight: weight + 0.2, at: match.index ?? 0 })
  }
  const withoutRanges = text.replace(RANGE, ' ')
  for (const pattern of [SINGLE, TRAILING, ACTIVITY]) {
    for (const match of withoutRanges.matchAll(pattern)) {
      const min = toNumber(match[1])
      if (min === null) continue
      const openEnded = /\+|at\s+least|minimum|\bmin\b|over|more\s+than|or\s+more|upwards/i.test(match[0])
      into.push({
        min,
        max: openEnded ? null : min,
        text: match[0].trim(),
        weight,
        at: match.index ?? 0,
      })
    }
  }
}

export interface ExperienceInput {
  title?: string
  descriptionText?: string
  sections?: Section[]
  /** schema.org `experienceRequirements.monthsOfExperience`, when published. */
  monthsFromSource?: number
  experienceTextFromSource?: string
}

export function extractExperience(input: ExperienceInput): ExperienceRange {
  if (input.monthsFromSource !== undefined && input.monthsFromSource >= 0) {
    const years = Math.round(input.monthsFromSource / 12)
    return {
      min: years,
      max: null,
      text: input.experienceTextFromSource ?? `${input.monthsFromSource} months of experience`,
    }
  }

  const description = input.descriptionText ?? ''
  const sections = input.sections ?? (description ? splitSections(description) : [])
  const requirements = textOfKinds(sections, ['requirements', 'skills'])

  const candidates: Candidate[] = []
  if (input.title) collect(input.title, 1.2, candidates)
  if (requirements) collect(requirements, 1, candidates)
  if (input.experienceTextFromSource) collect(input.experienceTextFromSource, 1.1, candidates)
  if (description) collect(description, 0.6, candidates)

  if (candidates.length === 0) {
    const fresher = FRESHER.exec(`${input.title ?? ''}\n${description}`)
    if (fresher) return { min: 0, max: 1, text: fresher[0] }
    return { min: null, max: null, text: null }
  }

  // Highest-weight section wins; within it, the *first* mention is the
  // headline requirement. Taking the lowest number instead looked safer but
  // was wrong on any posting that enumerates per-skill minimums after the main
  // bar — a role asking for five years read as one because it later mentioned
  // "1 year of experience leading technical initiatives".
  candidates.sort((left, right) => right.weight - left.weight || left.at - right.at)
  const winner = candidates[0]
  if (!winner) return { min: null, max: null, text: null }
  const min = winner.min
  const max = winner.max !== null && min !== null && winner.max < min ? null : winner.max
  return { min, max, text: winner.text.replace(/\s+/g, ' ').slice(0, 160) }
}

/** Convenience for the ranking code, which only cares about the entry bar. */
export function requiredYears(range: ExperienceRange): number | null {
  return range.min
}
