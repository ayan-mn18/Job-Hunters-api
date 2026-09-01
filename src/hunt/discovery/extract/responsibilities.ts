import { htmlToText } from '../html.js'
import { isBullet, splitSections, stripBullet, type Section } from './sections.js'

/**
 * The "what will I actually be doing" summary.
 *
 * This is a brief — three to six lines — not a copy of the JD. The full text is
 * stored separately; what the dashboard needs is enough to judge a posting
 * without opening it.
 */

const MAX_BULLETS = 6
const MIN_BULLETS = 3
const MAX_LENGTH = 140

/** Boilerplate that shows up in responsibility lists and says nothing. */
const NOISE = [
  /^(?:and\s+)?other\s+duties\s+as\s+assigned/i,
  /^perform\s+other\s+related\s+duties/i,
  /^apply\s+(?:now|today)/i,
  /^equal\s+opportunity/i,
  /^we\s+are\s+an\s+equal/i,
  /^click\s+here/i,
]

function tidy(line: string): string {
  const clean = stripBullet(line)
    .replace(/\s+/g, ' ')
    .replace(/^[a-z]\)\s*/i, '')
    .trim()
  if (clean.length <= MAX_LENGTH) return clean
  // Cut on a word boundary rather than mid-word, and mark the truncation.
  const cut = clean.slice(0, MAX_LENGTH - 1)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > 60 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, '')}…`
}

function usable(line: string): boolean {
  if (line.length < 20 || line.length > 400) return false
  if (NOISE.some((pattern) => pattern.test(line))) return false
  // A line with no lowercase letters is almost always a heading in caps.
  return /[a-z]/.test(line)
}

function sentencesOf(body: string): string[] {
  return body
    .split(/(?<=[.!?])\s+(?=[A-Z])|\n+/)
    .map((sentence) => sentence.trim())
    .filter(usable)
}

function bulletsOf(section: Section): string[] {
  const bullets = section.lines.filter(isBullet).map(stripBullet).filter(usable)
  return bullets.length > 0 ? bullets : sentencesOf(section.body)
}

export interface ResponsibilitiesInput {
  descriptionText?: string
  sections?: Section[]
  /** schema.org `responsibilities`, which is usually an HTML fragment. */
  responsibilitiesHtml?: string
}

export function extractResponsibilities(input: ResponsibilitiesInput): string[] {
  const description = input.descriptionText ?? ''
  const sections = input.sections ?? (description ? splitSections(description) : [])

  const fromSource = input.responsibilitiesHtml
    ? htmlToText(input.responsibilitiesHtml)
        .split('\n')
        .map((line) => stripBullet(line))
        .filter(usable)
    : []
  if (fromSource.length >= MIN_BULLETS) {
    return fromSource.slice(0, MAX_BULLETS).map(tidy)
  }

  // "About the role" and "Responsibilities" are both duty sections, but only
  // one of them is usually a list. Taking the most bulleted section first stops
  // an intro paragraph from standing in for the actual duties.
  const responsibilitySections = sections
    .filter((section) => section.kind === 'responsibilities')
    .sort((left, right) => right.lines.filter(isBullet).length - left.lines.filter(isBullet).length)
  const collected: string[] = []
  for (const section of responsibilitySections) {
    collected.push(...bulletsOf(section))
    if (collected.length >= MAX_BULLETS) break
  }

  if (collected.length < MIN_BULLETS) {
    // No labelled section: fall back to the first substantial bulleted list
    // that is not requirements or benefits, which in practice is the duties.
    const fallback = sections.find(
      (section) =>
        section.kind !== 'requirements' &&
        section.kind !== 'benefits' &&
        section.kind !== 'skills' &&
        section.lines.filter(isBullet).length >= MIN_BULLETS,
    )
    if (fallback) collected.push(...fallback.lines.filter(isBullet).map(stripBullet).filter(usable))
  }

  if (collected.length === 0 && fromSource.length > 0) collected.push(...fromSource)

  const seen = new Set<string>()
  const result: string[] = []
  for (const line of collected) {
    const value = tidy(line)
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
    if (result.length === MAX_BULLETS) break
  }
  return result
}
