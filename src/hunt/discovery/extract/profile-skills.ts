import { SKILL_TAXONOMY } from './taxonomy.js'

/**
 * Cleans the skill list that comes out of a resume.
 *
 * A resume writes skills as prose lines — "Languages: Java, JavaScript,
 * TypeScript" or "Kafka (Clusters, MirrorMaker, Schema Registry)". Splitting
 * that on commas produces entries like `"Languages: Java"`, `"Kafka (Clusters"`
 * and `"Schema Registry)"`, none of which match anything. Scoring was
 * comparing job descriptions against that, so a genuinely strong match could
 * score as if the candidate knew nothing.
 */

/** Section labels resumes put in front of a skill list. */
const CATEGORY_PREFIX =
  /^(?:programming\s+)?(?:languages?|frameworks?|libraries|systems?|tools?|technologies|tech\s+stack|databases?|datastores?|cloud(?:\s*(?:&|and)\s*devops)?|devops|infrastructure|streaming(?:\s*(?:&|and)\s*messaging)?|messaging|observability|monitoring|testing|practices?|methodologies|other|misc(?:ellaneous)?|soft\s+skills?|core\s+competencies)\s*[:\-–]\s*/i

const NOISE = /^(?:and|or|etc\.?|others?|various|including|e\.g\.?|i\.e\.?)$/i

function splitPieces(raw: string): string[] {
  const coarse = raw
    // "Kafka (Clusters, MirrorMaker)" — the parenthetical is detail about the
    // skill, so keep the head and the inner items as separate candidates.
    .replace(/[()]/g, ',')
    .split(/[,;|]|\s+&\s+|\s+\+\s+/)
    .map((piece) => piece.trim())

  // Only split on "/" when the piece is not itself a known skill: "CI/CD" and
  // "TCP/IP" are single names, "Java/Kotlin" is two.
  return coarse.flatMap((piece) => {
    if (!piece.includes('/')) return [piece]
    return canonical(tidy(piece)) ? [piece] : piece.split('/').map((part) => part.trim())
  })
}

function tidy(value: string): string {
  return value
    .replace(CATEGORY_PREFIX, '')
    .replace(/^[^a-z0-9]+/i, '')
    .replace(/[^a-z0-9+#.)\]]+$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Canonical taxonomy name for a cleaned token, when there is one. */
function canonical(value: string): string | null {
  const lower = value.toLowerCase()
  for (const entry of SKILL_TAXONOMY) {
    if (entry.name.toLowerCase() === lower) return entry.name
    if (entry.aliases.some((alias) => alias.toLowerCase() === lower)) return entry.name
  }
  return null
}

export function normaliseProfileSkills(raw: string[]): string[] {
  const result = new Set<string>()

  for (const line of raw) {
    if (typeof line !== 'string') continue
    for (const piece of splitPieces(line)) {
      const cleaned = tidy(piece)
      if (cleaned.length < 2 || cleaned.length > 60) continue
      if (NOISE.test(cleaned)) continue
      // A leftover fragment with no letters ("3+", ")") is not a skill.
      if (!/[a-z]/i.test(cleaned)) continue

      const known = canonical(cleaned)
      if (known) {
        result.add(known)
        continue
      }
      // Unknown but plausible: keep it, since the taxonomy will never be
      // complete and the user may have typed something real.
      if (cleaned.split(/\s+/).length <= 4) result.add(cleaned)
    }
  }

  return [...result]
}
