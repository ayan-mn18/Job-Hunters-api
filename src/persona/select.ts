import { desc } from 'drizzle-orm'
import { db } from '../db/client.js'
import { jobs } from '../db/schema.js'
import { rankJob, DEFAULT_WEIGHTS, type RankableJob, type RankingInput } from '../hunt/ranking.js'
import { planQueries } from '../hunt/discovery/planner.js'
import { isKnown, slotValue, type Persona } from './store.js'
import {
  CONFIDENT_ENOUGH,
  IMPACT_FLOOR,
  INTAKE_SLOTS,
  toStringList,
  type SlotDefinition,
} from './slots.js'

/**
 * Which question to ask next, if any.
 *
 * The rule is not "which slot are we least sure about". Uncertainty is cheap
 * to measure and the wrong objective: a question is only worth asking if the
 * answer changes *which jobs the user sees*, because that is the only thing
 * they experience.
 *
 * So each candidate slot is scored by simulating its plausible answers against
 * a pool of real postings and measuring how much the resulting top twenty
 * disagree. A slot whose branches produce the same twenty jobs is not asked,
 * however little we know about it.
 *
 * This is what removes most of the old wizard. "What is your notice period?"
 * cannot reorder anybody's top twenty, so it is never asked here — it is
 * collected at the first application, where it is actually needed.
 */

/** Postings to simulate against. Enough to be representative, small enough to rank in milliseconds. */
const POOL_SIZE = 300
const TOP_N = 20

export interface SlotImpact {
  slotId: string
  impact: number
  /** True when the number came from real postings rather than the prior. */
  measured: boolean
}

/**
 * Only the columns ranking reads.
 *
 * Selecting whole rows pulled `description_text` and `description_html` for
 * three hundred postings across a link with 137 ms of latency — tens of
 * megabytes, and the endpoint simply hung. The stored `skills` array is what
 * the extractor already produced from those descriptions, so the simulation
 * loses nothing by leaving the prose behind.
 */
interface PoolJob {
  id: string
  title: string
  company: string
  locations: unknown
  remoteMode: string
  skills: string[]
  experienceMin: number | null
  experienceMax: number | null
  experienceText: string | null
}

let poolCache: { at: number; rows: PoolJob[] } | null = null
const POOL_TTL_MS = 5 * 60_000

async function loadPool(): Promise<PoolJob[]> {
  if (poolCache && Date.now() - poolCache.at < POOL_TTL_MS) return poolCache.rows
  const rows = await db
    .select({
      id: jobs.id,
      title: jobs.title,
      company: jobs.company,
      locations: jobs.locations,
      remoteMode: jobs.remoteMode,
      skills: jobs.skills,
      experienceMin: jobs.experienceMin,
      experienceMax: jobs.experienceMax,
      experienceText: jobs.experienceText,
    })
    .from(jobs)
    .orderBy(desc(jobs.postedAt))
    .limit(POOL_SIZE)
  poolCache = { at: Date.now(), rows }
  return rows
}

function rankableFromPool(job: PoolJob): RankableJob {
  return {
    title: job.title,
    company: job.company,
    locations: (job.locations ?? []) as RankableJob['locations'],
    remote: job.remoteMode as RankableJob['remote'],
    skills: job.skills,
    experience: { min: job.experienceMin, max: job.experienceMax, text: job.experienceText },
    tags: [],
  }
}

export function clearPoolCache(): void {
  poolCache = null
}

/**
 * Branch values are always lists, because most slots hold lists. A scalar slot
 * like `location_mode` therefore arrives as `['remote']` during simulation and
 * as `'remote'` when stored — comparing the first against a bare string
 * silently fails, which is how that slot scored zero impact and became
 * unaskable.
 */
function asScalar(value: unknown, fallback: string): string {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : fallback
  return typeof value === 'string' ? value : fallback
}

/** Builds ranking input from the persona, with one slot forced to a branch value. */
export function rankingInputFor(
  persona: Persona,
  override?: { slot: string; value: string[] },
): RankingInput {
  const read = <T>(slot: string, fallback: T): T => {
    if (override && override.slot === slot) return override.value as unknown as T
    const value = slotValue<T>(persona, slot)
    return value === null ? fallback : value
  }

  const seniority = asScalar(read<unknown>('seniority', 'mid'), 'mid')
  const maxYears =
    seniority === 'junior' ? 2 : seniority === 'mid' ? 5 : seniority === 'senior' ? 9 : 15

  // `location_mode` has to reach the ranking input, or its branches all score
  // identically and the slot can never be asked about however unknown it is.
  // The scorer reads locations, so the mode expresses itself there.
  const mode = asScalar(read<unknown>('location_mode', 'any'), 'any')
  const markets = toStringList(read<unknown>('markets', []))
  const isRemoteEntry = (entry: string): boolean => /remote|anywhere|wfh/i.test(entry)
  const locations =
    mode === 'remote'
      ? ['Remote', ...markets.filter((entry) => !isRemoteEntry(entry))]
      : mode === 'onsite'
        ? markets.filter((entry) => !isRemoteEntry(entry))
        : markets

  return {
    roles: toStringList(read<unknown>('target_titles', [])),
    locations,
    dreamCompanies: [],
    dealBreakers: toStringList(read<unknown>('avoid', [])),
    skills: toStringList(read<unknown>('must_have_stack', [])),
    maxYearsExperience: maxYears,
    // Zero on purpose: we are comparing orderings, and a threshold that
    // rejected everything in one branch would make the sets trivially
    // disjoint and the impact look enormous.
    minMatchScore: 0,
    weights: DEFAULT_WEIGHTS,
  }
}

function topIds(pool: PoolJob[], input: RankingInput): Set<string> {
  const scored = pool.map((job) => ({
    id: job.id,
    score: rankJob(rankableFromPool(job), input).score,
  }))
  scored.sort((left, right) => right.score - left.score)
  return new Set(scored.slice(0, TOP_N).map((entry) => entry.id))
}

/**
 * The queries a branch would issue.
 *
 * A slot can change what is *found* without changing how an existing pool is
 * *ranked* — "remote only" is the clearest case: it rewrites the search plan,
 * while a pool of already-scraped postings reorders barely at all. Measuring
 * only the ranking scored that slot at exactly zero and made a question the
 * user genuinely needs to answer unaskable.
 *
 * So impact is the larger of the two effects: what changes in the search, and
 * what changes in the ordering.
 */
function planKeys(persona: Persona, override?: { slot: string; value: string[] }): Set<string> {
  const read = <T>(slot: string, fallback: T): T => {
    if (override && override.slot === slot) return override.value as unknown as T
    const value = slotValue<T>(persona, slot)
    return value === null ? fallback : value
  }

  const mode = asScalar(read<unknown>('location_mode', 'any'), 'any')
  const markets = toStringList(read<unknown>('markets', []))
  const locations =
    mode === 'remote'
      ? ['Remote', ...markets]
      : mode === 'onsite'
        ? markets.filter((entry) => !/remote|anywhere|wfh/i.test(entry))
        : markets

  const plan = planQueries({
    roles: toStringList(read<unknown>('target_titles', [])),
    locations,
    dreamCompanies: [],
    remotePreference: mode as 'remote' | 'hybrid' | 'onsite' | 'any',
  })
  return new Set(plan.queries.map((query) => `${query.keywords}|${query.market}`))
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1
  let shared = 0
  for (const value of left) if (right.has(value)) shared += 1
  const union = left.size + right.size - shared
  return union === 0 ? 1 : shared / union
}

/**
 * Plausible answers to simulate. Most come from the slot definition; the stack
 * slot's branches are built from the user's own skills, because "would
 * narrowing your stack change anything" is only answerable against their list.
 */
function branchesFor(slot: SlotDefinition, persona: Persona): string[][] {
  if (slot.id === 'must_have_stack') {
    const skills = toStringList(slotValue<unknown>(persona, 'must_have_stack'))
    if (skills.length < 4) return []
    return [skills, skills.slice(0, Math.ceil(skills.length / 3))]
  }
  return slot.branches
}

export async function scoreSlots(persona: Persona): Promise<SlotImpact[]> {
  const candidates = INTAKE_SLOTS.filter((slot) => !isKnown(persona, slot.id))
  if (candidates.length === 0) return []

  const pool = await loadPool()
  const impacts: SlotImpact[] = []

  for (const slot of candidates) {
    const branches = branchesFor(slot, persona)

    // No pool or no branches to compare: fall back to the declared prior, and
    // say so rather than dressing a guess as a measurement.
    if (pool.length < 20 || branches.length < 2) {
      impacts.push({ slotId: slot.id, impact: slot.prior, measured: false })
      continue
    }

    const rankSets = branches.map((value) =>
      topIds(pool, rankingInputFor(persona, { slot: slot.id, value })),
    )
    const planSets = branches.map((value) => planKeys(persona, { slot: slot.id, value }))

    let rankTotal = 0
    let planTotal = 0
    let pairs = 0
    for (let i = 0; i < branches.length; i += 1) {
      for (let j = i + 1; j < branches.length; j += 1) {
        const rankLeft = rankSets[i]
        const rankRight = rankSets[j]
        const planLeft = planSets[i]
        const planRight = planSets[j]
        if (!rankLeft || !rankRight || !planLeft || !planRight) continue
        rankTotal += 1 - jaccard(rankLeft, rankRight)
        planTotal += 1 - jaccard(planLeft, planRight)
        pairs += 1
      }
    }

    // The larger of the two: a slot that rewrites the search matters as much
    // as one that reorders the results.
    const measured = pairs === 0 ? slot.prior : Math.max(rankTotal / pairs, planTotal / pairs)
    // A slot we already have a decent guess at is worth less to ask about,
    // even if the branches disagree. Scale by how unsure we are.
    const entry = persona.slots.get(slot.id)
    const uncertainty = entry ? Math.max(0, 1 - entry.confidence / CONFIDENT_ENOUGH) : 1
    impacts.push({ slotId: slot.id, impact: measured * uncertainty, measured: pairs > 0 })
  }

  impacts.sort((left, right) => right.impact - left.impact)
  return impacts
}

/** The next slot worth asking about, or null when nothing is. */
export async function nextSlot(
  persona: Persona,
  alreadyAsked: string[],
): Promise<{ slot: SlotDefinition; impact: SlotImpact } | null> {
  const asked = new Set(alreadyAsked)
  const impacts = (await scoreSlots(persona)).filter((entry) => !asked.has(entry.slotId))

  const best = impacts[0]
  if (!best || best.impact < IMPACT_FLOOR) return null

  const slot = INTAKE_SLOTS.find((entry) => entry.id === best.slotId)
  return slot ? { slot, impact: best } : null
}
