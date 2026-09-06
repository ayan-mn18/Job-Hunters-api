import type { SearchQuery } from './types.js'

/**
 * Turns a person into a set of searches.
 *
 * This is the half of discovery that did not exist. `hunt_specs.roles` and
 * `.locations` were read only by the scorer, *after* results had already
 * arrived from a fixed list of company boards — so a user asking for "backend
 * engineer in Bangalore" got whatever those boards happened to be posting, then
 * had it ranked. The query never reached the network.
 *
 * The plan is deliberately small. Thirty queries at a few hundred results each
 * is already more than a person can review; the work is in choosing *which*
 * thirty.
 */

export interface PlannerInput {
  roles: string[]
  locations: string[]
  dreamCompanies: string[]
  /** Kit city and country, used when the spec names no location. */
  homeCity?: string | null
  homeCountry?: string | null
  /**
   * How the user wants to work. Remote is otherwise always added, which is
   * right for most people and wrong for anyone who said on-site only — they
   * were getting remote listings they had explicitly ruled out.
   */
  remotePreference?: 'remote' | 'hybrid' | 'onsite' | 'any'
}

export interface QueryPlan {
  queries: SearchQuery[]
  /** Board tokens worth resolving for the ATS tier. */
  dreamCompanies: string[]
  notes: string[]
}

/**
 * Total keyword searches per run, across every source.
 *
 * The sub-caps are set so this is the binding constraint: 8 × 5 is 40
 * possible pairs and only 30 are issued. Sizing them the other way round left
 * the budget dead — worth stating, because a constant that can never be
 * reached reads like a limit and is not one.
 */
const QUERY_BUDGET = 30
const MAX_TITLES = 8
const MAX_MARKETS = 5

/**
 * Title synonyms.
 *
 * Job boards do not agree on what to call the same job, and a keyword search
 * matches the words a posting actually used. Searching "SDE" alone misses
 * every posting that said "Software Engineer"; the reverse is just as true in
 * India, where SDE and its numbered variants are the house style.
 *
 * Kept deliberately short — these are search expansions, not a taxonomy. The
 * scorer already understands the difference between what came back.
 */
const TITLE_SYNONYMS: Array<{ match: RegExp; expand: string[] }> = [
  {
    match: /\b(?:backend|back[\s-]?end)\b/i,
    expand: ['backend engineer', 'backend developer', 'software engineer backend'],
  },
  {
    match: /\b(?:frontend|front[\s-]?end)\b/i,
    expand: ['frontend engineer', 'frontend developer', 'react developer'],
  },
  {
    match: /\b(?:full[\s-]?stack)\b/i,
    expand: ['full stack engineer', 'full stack developer'],
  },
  {
    match: /\b(?:sde|software\s+development\s+engineer)\b/i,
    expand: ['software engineer', 'sde', 'software development engineer'],
  },
  {
    match: /\b(?:software\s+engineer|software\s+developer|swe)\b/i,
    expand: ['software engineer', 'software developer', 'sde'],
  },
  {
    match: /\b(?:devops|sre|site\s+reliability|platform\s+engineer)\b/i,
    expand: ['devops engineer', 'site reliability engineer', 'platform engineer'],
  },
  {
    match: /\b(?:node|nodejs|node\.js)\b/i,
    expand: ['node.js developer', 'backend engineer node'],
  },
  { match: /\b(?:python)\b/i, expand: ['python developer', 'python engineer'] },
  { match: /\b(?:java)\b(?!script)/i, expand: ['java developer', 'java backend engineer'] },
]

/**
 * Location text to market code.
 *
 * Deliberately weighted to India, the Gulf, and remote — the markets this
 * product is aimed at — with the common English-speaking markets as a tail so
 * a user who types "Berlin" is not silently dropped.
 */
const MARKET_BY_PATTERN: Array<[RegExp, string]> = [
  [/\b(?:remote|anywhere|work\s+from\s+home|wfh)\b/i, 'remote'],
  [
    /\b(?:india|bengaluru|bangalore|hyderabad|pune|mumbai|delhi|noida|gurgaon|gurugram|chennai|kolkata|ahmedabad|jaipur|indore|kochi)\b/i,
    'IN',
  ],
  [/\b(?:uae|dubai|abu\s?dhabi|sharjah|emirates)\b/i, 'AE'],
  [/\b(?:saudi|riyadh|jeddah|ksa|dammam)\b/i, 'SA'],
  [/\b(?:qatar|doha)\b/i, 'QA'],
  [/\b(?:singapore)\b/i, 'SG'],
  [/\b(?:united\s+kingdom|uk|london|manchester|england)\b/i, 'GB'],
  [/\b(?:usa|united\s+states|us|new\s+york|san\s+francisco|seattle|austin)\b/i, 'US'],
  [/\b(?:germany|berlin|munich)\b/i, 'DE'],
  [/\b(?:canada|toronto|vancouver)\b/i, 'CA'],
  [/\b(?:australia|sydney|melbourne)\b/i, 'AU'],
  [/\b(?:netherlands|amsterdam)\b/i, 'NL'],
]

export function marketFor(location: string): string | null {
  for (const [pattern, market] of MARKET_BY_PATTERN) {
    if (pattern.test(location)) return market
  }
  return null
}

function normalise(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Expands the user's role words into the phrasings boards actually use. */
export function expandTitles(roles: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  const push = (title: string) => {
    const key = normalise(title)
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(key)
  }

  for (const role of roles) {
    const trimmed = role.trim()
    if (!trimmed) continue
    // What the user typed always goes first — they may know something the
    // synonym table does not.
    push(trimmed)
    for (const entry of TITLE_SYNONYMS) {
      if (entry.match.test(trimmed)) entry.expand.forEach(push)
    }
  }

  if (out.length === 0) push('software engineer')
  return out.slice(0, MAX_TITLES)
}

/**
 * Which markets to search. Explicit locations win; otherwise fall back to the
 * user's own city and country, and always include remote — a remote role is
 * available to someone in Bengaluru and someone in Dubai alike.
 */
export function resolveMarkets(input: PlannerInput): Array<{ market: string; locationText: string }> {
  const found: Array<{ market: string; locationText: string }> = []
  const seen = new Set<string>()
  const preference = input.remotePreference ?? 'any'

  const push = (market: string, locationText: string) => {
    if (seen.has(market)) return
    seen.add(market)
    found.push({ market, locationText })
  }

  // Someone who asked for remote only wants exactly one market. Searching
  // their home city as well would fill the list with jobs they cannot take.
  if (preference === 'remote') return [{ market: 'remote', locationText: 'Remote' }]

  for (const location of input.locations) {
    const market = marketFor(location)
    if (market === 'remote' && preference === 'onsite') continue
    if (market) push(market, location.trim())
  }

  if (found.length === 0) {
    const home = [input.homeCity, input.homeCountry].filter(Boolean).join(', ')
    const market = home ? marketFor(home) : null
    if (market) push(market, home)
  }

  // Remote is added for everyone else, because a remote role is open to
  // someone in Bengaluru and someone in Dubai alike — but not for someone who
  // told us they want to be in an office.
  if (preference !== 'onsite') push('remote', 'Remote')
  return found.slice(0, MAX_MARKETS)
}

export function planQueries(input: PlannerInput): QueryPlan {
  const notes: string[] = []
  const titles = expandTitles(input.roles)
  const markets = resolveMarkets(input)

  if (input.roles.length === 0) {
    notes.push('No target roles saved — searched for "software engineer" as a default.')
  }
  if (input.locations.length === 0) {
    notes.push('No locations saved — searched remote and your home market.')
  }

  // Round-robin over markets rather than exhausting the first one. A budget
  // spent entirely on India would make the Gulf and remote results vanish for
  // a user who asked for all three.
  const queries: SearchQuery[] = []
  outer: for (let titleIndex = 0; titleIndex < titles.length; titleIndex += 1) {
    for (const { market, locationText } of markets) {
      if (queries.length >= QUERY_BUDGET) break outer
      const title = titles[titleIndex]
      if (!title) continue
      queries.push({
        keywords: title,
        market,
        locationText,
        remoteOnly: market === 'remote',
      })
    }
  }

  const dreamCompanies = input.dreamCompanies
    .map((company) => company.trim())
    .filter(Boolean)
    .slice(0, 20)

  if (queries.length === QUERY_BUDGET) {
    notes.push(`Query budget of ${QUERY_BUDGET} reached — narrow your roles or locations for deeper coverage.`)
  }

  return { queries, dreamCompanies, notes }
}
