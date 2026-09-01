/**
 * Whether a posting is a software engineering job at all.
 *
 * Scoring used to decide this by degree — a copywriter simply scored low. That
 * is the wrong shape for the question: nobody wants a 74%-matching product
 * designer, they want it gone. This is a gate, applied at scrape time, before
 * anything is stored as a candidate.
 *
 * It reads the title only. A JD for a marketing role is full of the word
 * "platform" and a JD for an engineering role is full of the word "product";
 * the title is the one field that reliably says what the job is.
 */

export type RoleVerdict =
  | { kind: 'software'; family: SoftwareFamily }
  | { kind: 'rejected'; reason: string }

export type SoftwareFamily =
  | 'backend'
  | 'frontend'
  | 'fullstack'
  | 'generalist'
  | 'platform'
  | 'mobile'
  | 'data-engineering'
  | 'ml'
  | 'qa'
  | 'devops'

/**
 * Titles that are never the job we want, checked first. Order matters: a
 * "Product Manager, Developer Platform" contains "developer" and would
 * otherwise sneak through the allowlist.
 */
const REJECT: Array<[RegExp, string]> = [
  [/\b(?:product|program|project|delivery|engagement|account|community|office|general)\s+manager\b/i, 'management, not engineering'],
  [/\b(?:product\s+owner|scrum\s+master|business\s+analyst|systems?\s+analyst|functional\s+analyst)\b/i, 'analysis or agile role'],
  [/\b(?:technical\s+program|technical\s+project|tpm)\b/i, 'technical program management'],
  [/\b(?:designer|design\s+lead|ux|ui\/ux|user\s+experience|creative\s+director|illustrator|animator)\b/i, 'design'],
  [/\b(?:copywriter|content\s+(?:writer|strategist|manager)|editor|journalist|blogger)\b/i, 'writing or content'],
  [/\b(?:marketing|growth\s+(?:lead|manager|marketer)|seo|sem|demand\s+gen|brand|social\s+media|communications)\b/i, 'marketing'],
  [/\b(?:sales|account\s+executive|business\s+development|partnerships?|revenue|deal\s+desk)\b/i, 'sales'],
  [/\b(?:recruiter|talent|people\s+ops|human\s+resources|\bhr\b)\b/i, 'recruiting or HR'],
  [/\b(?:customer\s+(?:success|support|experience)|technical\s+support|help\s?desk|service\s+desk|support\s+engineer)\b/i, 'support'],
  [/\b(?:developer\s+(?:relations|advocate|advocacy)|devrel|developer\s+evangelist|technical\s+evangelist)\b/i, 'developer relations'],
  [/\b(?:accountant|bookkeeper|controller|finance|payroll|auditor|underwrit|actuar|compliance|legal|counsel|paralegal)\b/i, 'finance, legal or compliance'],
  [/\b(?:nurse|clinical|therapist|physician|medical|dental|pharmac|caregiver|teacher|tutor|instructor|professor)\b/i, 'clinical or teaching'],
  [/\b(?:driver|warehouse|logistics|supply\s+chain|procurement|technician|electrician|mechanic|installer|operator)\b/i, 'operations or trades'],
  [/\b(?:executive\s+assistant|administrative|receptionist|office\s+admin|virtual\s+assistant)\b/i, 'administrative'],
  [/\b(?:data\s+(?:scientist|analyst)|research\s+scientist|quantitative\s+researcher|statistician|economist)\b/i, 'research or analysis'],
  // `engineer(?:ing)?` matters: "Solutions Engineering" was slipping through a
  // `\bengineer\b` that cannot match the middle of "engineering".
  [/\b(?:solutions?\s+(?:consultant|engineer(?:ing)?|architect)|sales\s+engineer(?:ing)?|pre[\s-]?sales|field\s+engineer|implementation\s+consultant|forward\s+deployed)\b/i, 'pre-sales or consulting'],
  // "Software Development Engineer in Test" reads as a software title right up
  // to the last two words, so it needs its own rule ahead of the allowlist.
  [/\bin\s+test\b|\bsdet\b|\btest\s+automation\b|\bautomation\s+engineer\b/i, 'testing or QA'],
  [/\b(?:intern|internship|apprentice|trainee|working\s+student|co[\s-]?op)\b/i, 'internship'],
  [/\b(?:director|vp|vice\s+president|head\s+of|chief|cto\b|founding\s+engineer)\b/i, 'executive'],
  [/\b(?:engineering|development|software)\s+manager\b/i, 'engineering management'],
]

/**
 * What counts as software engineering. Each entry maps to a family so scoring
 * can prefer the ones closest to the candidate's own work.
 */
const ACCEPT: Array<[RegExp, SoftwareFamily]> = [
  [/\bback[\s-]?end\b|\bserver[\s-]?side\b|\bapi\s+(?:engineer|developer)\b/i, 'backend'],
  [/\bfront[\s-]?end\b|\bweb\s+(?:engineer|developer)\b|\bui\s+(?:engineer|developer)\b/i, 'frontend'],
  [/\bfull[\s-]?stack\b/i, 'fullstack'],
  [/\b(?:android|ios|mobile|react\s+native|flutter)\s+(?:engineer|developer)\b/i, 'mobile'],
  [/\b(?:platform|infrastructure|systems?|distributed\s+systems?)\s+(?:engineer|developer)\b/i, 'platform'],
  [/\b(?:devops|sre|site\s+reliability|cloud)\s+engineer\b/i, 'devops'],
  [/\bdata\s+engineer\b|\banalytics\s+engineer\b/i, 'data-engineering'],
  [/\b(?:machine\s+learning|ml|ai|deep\s+learning|nlp)\s+engineer\b|\bmlops\s+engineer\b/i, 'ml'],
  [/\b(?:qa|quality|test|sdet|automation)\s+engineer\b/i, 'qa'],
  // Language-led titles: "Java Developer", "TypeScript Engineer".
  [/\b(?:java|kotlin|scala|python|golang|go|ruby|rails|php|node(?:\.js)?|javascript|typescript|react|angular|vue|\.net|c\+\+|c#|rust|elixir)\s+(?:engineer|developer|programmer)\b/i, 'generalist'],
  // The plain forms, last so the specific families win.
  [/\b(?:software|application)\s+(?:engineer|developer)\b|\bsde\b|\bswe\b|\bsoftware\s+development\s+engineer\b/i, 'generalist'],
  [/\b(?:engineer|developer|programmer)\b/i, 'generalist'],
]

/** Families the user has said are not their domain. */
const EXCLUDED_FAMILIES = new Set<SoftwareFamily>(['ml', 'qa'])

export function classifyRole(title: string): RoleVerdict {
  const clean = title.replace(/[([{][^)\]}]*[)\]}]/g, ' ').trim()

  for (const [pattern, reason] of REJECT) {
    if (pattern.test(clean)) return { kind: 'rejected', reason }
  }
  for (const [pattern, family] of ACCEPT) {
    if (pattern.test(clean)) {
      if (EXCLUDED_FAMILIES.has(family)) {
        return { kind: 'rejected', reason: family === 'ml' ? 'machine learning' : 'testing or QA' }
      }
      return { kind: 'software', family }
    }
  }
  return { kind: 'rejected', reason: 'not a software engineering title' }
}

export function isSoftwareRole(title: string): boolean {
  return classifyRole(title).kind === 'software'
}
