import { splitSections, textOfKinds, type Section } from './sections.js'
import { CASE_SENSITIVE_ALIASES, SKILL_TAXONOMY, type SkillEntry } from './taxonomy.js'

/**
 * Taxonomy-driven skill extraction with section weighting.
 *
 * Where a skill appears matters as much as whether it appears: "Python" under
 * "Requirements" is part of the job, the same word in a perks paragraph about
 * the internal book club is not. Each hit is scored by the section it landed
 * in, and the returned list is ordered by that score.
 */

export interface ExtractedSkill {
  name: string
  category: SkillEntry['category']
  confidence: number
  /** Where the strongest hit was found. */
  source: 'title' | 'requirements' | 'responsibilities' | 'description' | 'tags'
  /** The alias text that matched, used to drop subsumed generic matches. */
  alias: string
}

interface CompiledAlias {
  entry: SkillEntry
  alias: string
  lower: string
  pattern: RegExp
  caseSensitive: boolean
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * "Go" is a language and also the most common verb in a careers page. Case
 * sensitivity alone does not help — sentences start with "Go home" — so the
 * bare alias carries a negative lookahead for the words that follow the verb.
 */
const AMBIGUOUS_SUFFIX: Record<string, string> = {
  Go: '(?!\\s+(?:to|home|back|live|beyond|through|forward|above|and|the|a|an|on|in|for|with|deep|fast|further|big|remote|get|see|apply|ahead))',
}

function compile(entry: SkillEntry, alias: string): CompiledAlias {
  const caseSensitive = CASE_SENSITIVE_ALIASES.has(alias)
  // `\b` is defined in terms of word characters, so it misbehaves next to `+`,
  // `#` and `.` — the characters that appear in exactly the skill names people
  // care about. These lookarounds are applied only on the alphanumeric side.
  const prefix = /^[A-Za-z0-9]/.test(alias) ? '(?<![A-Za-z0-9_])' : ''
  const suffix = /[A-Za-z0-9]$/.test(alias) ? '(?![A-Za-z0-9_])' : ''
  const guard = AMBIGUOUS_SUFFIX[alias] ?? ''
  return {
    entry,
    alias,
    lower: alias.toLowerCase(),
    pattern: new RegExp(`${prefix}${escape(alias)}${suffix}${guard}`, caseSensitive ? '' : 'i'),
    caseSensitive,
  }
}

const COMPILED: CompiledAlias[] = SKILL_TAXONOMY.flatMap((entry) =>
  entry.aliases.map((alias) => compile(entry, alias)),
)

const WEIGHTS: Record<ExtractedSkill['source'], number> = {
  title: 1,
  requirements: 0.95,
  tags: 0.9,
  responsibilities: 0.75,
  description: 0.55,
}

interface Haystack {
  source: ExtractedSkill['source']
  text: string
  lower: string
}

function haystack(source: ExtractedSkill['source'], text: string): Haystack {
  return { source, text, lower: text.toLowerCase() }
}

export interface SkillExtractionInput {
  title?: string
  descriptionText?: string
  tags?: string[]
  /** Skills the source published directly; trusted above anything parsed. */
  declaredSkills?: string[]
  sections?: Section[]
  limit?: number
}

export function extractSkills(input: SkillExtractionInput): ExtractedSkill[] {
  const description = input.descriptionText ?? ''
  const sections = input.sections ?? (description ? splitSections(description) : [])
  const requirementsText = textOfKinds(sections, ['requirements', 'skills'])
  const responsibilitiesText = textOfKinds(sections, ['responsibilities'])

  const haystacks = [
    haystack('title', input.title ?? ''),
    haystack('tags', (input.tags ?? []).join(' , ')),
    haystack('requirements', requirementsText),
    haystack('responsibilities', responsibilitiesText),
    haystack('description', description),
  ].filter((item) => item.text.length > 0)

  const best = new Map<string, ExtractedSkill>()

  function record(
    entry: SkillEntry,
    source: ExtractedSkill['source'],
    confidence: number,
    alias: string,
  ): void {
    const existing = best.get(entry.name)
    if (existing && existing.confidence >= confidence) return
    best.set(entry.name, { name: entry.name, category: entry.category, confidence, source, alias })
  }

  for (const compiled of COMPILED) {
    for (const item of haystacks) {
      // Substring check first: it is an order of magnitude cheaper than the
      // regex, and most of the ~700 aliases miss every posting.
      if (!item.lower.includes(compiled.lower)) continue
      if (!compiled.pattern.test(item.text)) continue
      record(compiled.entry, item.source, WEIGHTS[item.source], compiled.alias)
      break
    }
  }

  // Anything the source itself declared outranks every parse.
  for (const declared of input.declaredSkills ?? []) {
    const clean = declared.trim()
    if (clean.length < 2 || clean.length > 60) continue
    const known = SKILL_TAXONOMY.find((entry) =>
      entry.aliases.some((alias) => alias.toLowerCase() === clean.toLowerCase()),
    )
    if (known) {
      best.set(known.name, { name: known.name, category: known.category, confidence: 1, source: 'tags', alias: clean })
    } else if (!best.has(clean)) {
      best.set(clean, { name: clean, category: 'practice', confidence: 0.8, source: 'tags', alias: clean })
    }
  }

  return dropSubsumed([...best.values()])
    .sort((left, right) => right.confidence - left.confidence || left.name.localeCompare(right.name))
    .slice(0, input.limit ?? 30)
}

/**
 * Removes a skill whose matched alias is contained in another skill's matched
 * alias.
 *
 * "Spring Boot" contains the word "Spring", so a posting mentioning only
 * Spring Boot came back with both Spring Boot *and* Spring Framework. Scoring
 * then counted Spring Framework as a requirement the candidate lacked — a
 * penalty invented entirely by the parser.
 */
function dropSubsumed(skills: ExtractedSkill[]): ExtractedSkill[] {
  return skills.filter((skill) => {
    const alias = skill.alias.toLowerCase()
    return !skills.some((other) => {
      if (other.name === skill.name) return false
      const otherAlias = other.alias.toLowerCase()
      if (otherAlias.length <= alias.length) return false
      // Word-boundary containment only: "React" inside "React Native" counts,
      // "C" inside "CI/CD" does not.
      return new RegExp(`(^|\\s)${escape(alias)}(\\s|$)`).test(otherAlias)
    })
  })
}

export function skillNames(skills: ExtractedSkill[]): string[] {
  return skills.map((skill) => skill.name)
}
