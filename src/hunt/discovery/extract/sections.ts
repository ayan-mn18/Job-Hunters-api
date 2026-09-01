/**
 * Splits a plain-text job description into labelled sections.
 *
 * Almost every posting is the same handful of blocks — about the company, what
 * you'll do, what we're looking for, benefits — under headings that vary only
 * in wording. Finding those boundaries is what lets the extractors weight a
 * skill named under "Requirements" above one mentioned in a perks list, and is
 * the only reliable way to pull responsibilities without dragging in the
 * benefits bullets.
 */

export type SectionKind =
  | 'responsibilities'
  | 'requirements'
  | 'skills'
  | 'benefits'
  | 'about'
  | 'other'

export interface Section {
  kind: SectionKind
  heading: string
  body: string
  lines: string[]
}

const HEADING_PATTERNS: Array<[SectionKind, RegExp]> = [
  [
    'responsibilities',
    /^(?:key\s+|core\s+|main\s+|your\s+|primary\s+)?(?:responsibilities|duties|what\s+you(?:'|’)?ll\s+(?:do|be\s+doing)|what\s+you\s+will\s+do|the\s+role|your\s+role|role\s+overview|in\s+this\s+role|day[\s-]to[\s-]day|about\s+the\s+(?:role|job|position)|job\s+description|scope\s+of\s+work)\b/i,
  ],
  [
    'requirements',
    /^(?:minimum\s+|basic\s+|preferred\s+|desired\s+|key\s+|essential\s+)?(?:requirements|qualifications|what\s+we(?:'|’)?re\s+looking\s+for|what\s+you(?:'|’)?ll\s+need|what\s+you\s+bring|who\s+you\s+are|about\s+you|you\s+(?:should\s+)?have|experience\s+required|must[\s-]haves?|nice[\s-]to[\s-]haves?|ideal\s+candidate|candidate\s+profile|eligibility)\b/i,
  ],
  [
    'skills',
    /^(?:required\s+|technical\s+|core\s+|key\s+)?(?:skills?|tech(?:nical)?\s+stack|technologies|our\s+stack|toolset|competencies)\b/i,
  ],
  [
    'benefits',
    /^(?:benefits|perks|what\s+we\s+offer|why\s+(?:join|work)|compensation(?:\s+and\s+benefits)?|we\s+offer|our\s+offer|salary\s+(?:and|&)\s+benefits)\b/i,
  ],
  [
    'about',
    /^(?:about\s+(?:us|the\s+company|[a-z0-9][\w.& -]{1,40})|who\s+we\s+are|company\s+overview|our\s+(?:mission|story|team))\b/i,
  ],
]

const BULLET_PREFIX = /^\s*(?:[•‣▪●·*+–—-]|\d{1,2}[.)])\s+/

export function isBullet(line: string): boolean {
  return BULLET_PREFIX.test(line)
}

export function stripBullet(line: string): string {
  return line.replace(BULLET_PREFIX, '').trim()
}

function classify(line: string): SectionKind | null {
  // A heading is short, and is not itself a bullet in a list.
  const trimmed = line.trim().replace(/[:：]\s*$/, '')
  if (!trimmed || trimmed.length > 80 || isBullet(line)) return null
  const words = trimmed.split(/\s+/).length
  if (words > 9) return null
  for (const [kind, pattern] of HEADING_PATTERNS) {
    if (pattern.test(trimmed)) return kind
  }
  return null
}

export function splitSections(text: string): Section[] {
  const lines = text.split('\n')
  const sections: Section[] = []
  let current: Section = { kind: 'other', heading: '', body: '', lines: [] }

  for (const line of lines) {
    const kind = classify(line)
    if (kind) {
      if (current.lines.length > 0 || current.heading) {
        sections.push({ ...current, body: current.lines.join('\n').trim() })
      }
      current = { kind, heading: line.trim(), body: '', lines: [] }
      continue
    }
    if (line.trim()) current.lines.push(line.trim())
  }
  sections.push({ ...current, body: current.lines.join('\n').trim() })
  return sections.filter((section) => section.heading || section.body)
}

/** Concatenated body of every section of the given kinds. */
export function textOfKinds(sections: Section[], kinds: SectionKind[]): string {
  const wanted = new Set(kinds)
  return sections
    .filter((section) => wanted.has(section.kind))
    .map((section) => section.body)
    .join('\n')
}
