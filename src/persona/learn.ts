import { and, desc, eq, gte, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { huntCandidates, huntRunJobs, huntSpecs, jobs, preferenceEvents } from '../db/schema.js'
import { logger } from '../lib/logger.js'
import { DEFAULT_WEIGHTS, readWeights, type ScoreWeights } from '../hunt/ranking.js'
import { rankableFromJob } from '../hunt/discovery/service.js'
import { rankJob } from '../hunt/ranking.js'
import { rankingInputFor } from './select.js'
import { loadPersona } from './store.js'

/**
 * Learning what this person actually wants from what they do.
 *
 * The signal was already there and already stored. Every approve and reject on
 * the Hunt screen is a labelled example, and the feature vector behind it —
 * `hunt_run_jobs.score_breakdown` — has been written on every scored job since
 * the first run. Nothing read it. This is mostly a matter of consuming what the
 * product was already generating and throwing away.
 *
 * The update is deliberately conservative. A user's weights drifting because
 * they rejected three jobs on a Tuesday would be worse than not learning at
 * all, so each refit moves a limited distance and the components stay
 * normalised to 100 — which keeps the score on the scale the UI already shows.
 */

const COMPONENTS: Array<keyof ScoreWeights> = [
  'coverage',
  'stack',
  'experience',
  'seniority',
  'location',
]

/** How far weights may move in one refit, as a fraction of their value. */
const MAX_STEP = 0.25
/** Below this many examples the sample is noise, not preference. */
const MIN_EXAMPLES = 8

function breakdownOf(value: unknown): Partial<ScoreWeights> {
  if (!value || typeof value !== 'object') return {}
  return value as Partial<ScoreWeights>
}

/** Rescales so the components still sum to 100 and the score keeps its meaning. */
function normalise(weights: ScoreWeights): ScoreWeights {
  const total = COMPONENTS.reduce((sum, key) => sum + Math.max(0, weights[key]), 0)
  if (total <= 0) return DEFAULT_WEIGHTS
  const scale = 100 / total
  return {
    coverage: Math.max(0, weights.coverage) * scale,
    stack: Math.max(0, weights.stack) * scale,
    experience: Math.max(0, weights.experience) * scale,
    seniority: Math.max(0, weights.seniority) * scale,
    location: Math.max(0, weights.location) * scale,
  }
}

/**
 * Records a pairwise choice as the difference between the two feature vectors.
 *
 * A difference rather than two rows because that is what the comparison
 * actually says: not "this job is good", but "this one beat that one", which is
 * the trade-off information a form cannot capture.
 */
export async function recordPairwise(
  userId: string,
  chosenJobId: string,
  rejectedJobId: string,
): Promise<void> {
  const persona = await loadPersona(userId)
  const input = rankingInputFor(persona)

  const rows = await db.select().from(jobs).where(inArray(jobs.id, [chosenJobId, rejectedJobId]))
  const chosen = rows.find((row) => row.id === chosenJobId)
  const rejected = rows.find((row) => row.id === rejectedJobId)
  if (!chosen || !rejected) return

  const chosenBreakdown = rankJob(rankableFromJob(chosen), input).breakdown
  const rejectedBreakdown = rankJob(rankableFromJob(rejected), input).breakdown

  const difference: Record<string, number> = {}
  for (const key of COMPONENTS) {
    difference[key] = (chosenBreakdown[key] ?? 0) - (rejectedBreakdown[key] ?? 0)
  }

  await db.insert(preferenceEvents).values({
    userId,
    kind: 'pairwise',
    features: difference,
    label: 1,
    jobId: chosenJobId,
    comparedJobId: rejectedJobId,
  })
}

/**
 * Turns the Hunt screen's approve and reject decisions into examples.
 *
 * Called by the nightly refit rather than at click time: a decision is only
 * meaningful next to the ones around it, and batching keeps a burst of
 * rejections from being written as fifty separate signals.
 */
async function collectDecisionExamples(
  userId: string,
  since: Date,
): Promise<Array<{ features: Partial<ScoreWeights>; label: number }>> {
  const rows = await db
    .select({
      status: huntCandidates.status,
      breakdown: huntCandidates.scoreBreakdown,
    })
    .from(huntCandidates)
    .where(and(eq(huntCandidates.userId, userId), gte(huntCandidates.updatedAt, since)))

  return rows.flatMap((row) => {
    // Only decisions the user actually made. `discovered` means untouched.
    if (row.status === 'rejected') return [{ features: breakdownOf(row.breakdown), label: 0 }]
    if (['approved', 'tailored', 'queued', 'applying', 'applied'].includes(row.status)) {
      return [{ features: breakdownOf(row.breakdown), label: 1 }]
    }
    return []
  })
}

export interface RefitResult {
  userId: string
  examples: number
  changed: boolean
  weights: ScoreWeights
}

/**
 * Refits one user's score weights.
 *
 * A single gradient step on a logistic objective rather than a fit to
 * convergence: with a few dozen examples, converging would mean overfitting to
 * last week's mood. Each component moves toward the average of what was
 * approved and away from what was rejected, capped so no single night can
 * rewrite the ranking.
 */
export async function refitWeights(userId: string, lookbackDays = 30): Promise<RefitResult> {
  const since = new Date(Date.now() - lookbackDays * 86_400_000)

  const [pairwise, decisions, [spec]] = await Promise.all([
    db
      .select()
      .from(preferenceEvents)
      .where(and(eq(preferenceEvents.userId, userId), gte(preferenceEvents.createdAt, since)))
      .orderBy(desc(preferenceEvents.createdAt))
      .limit(200),
    collectDecisionExamples(userId, since),
    db.select().from(huntSpecs).where(eq(huntSpecs.userId, userId)).limit(1),
  ])

  const current = readWeights(spec?.scoreWeights)
  const examples = [
    ...pairwise.map((row) => ({ features: breakdownOf(row.features), label: row.label })),
    ...decisions,
  ]

  if (examples.length < MIN_EXAMPLES) {
    return { userId, examples: examples.length, changed: false, weights: current }
  }

  // Average feature value among wanted vs unwanted. A component that is
  // consistently higher on the jobs someone took matters more to them than the
  // default assumed.
  const wanted = examples.filter((entry) => entry.label === 1)
  const unwanted = examples.filter((entry) => entry.label === 0)

  const next: ScoreWeights = { ...current }
  for (const key of COMPONENTS) {
    const mean = (list: typeof examples): number =>
      list.length === 0 ? 0 : list.reduce((sum, entry) => sum + (entry.features[key] ?? 0), 0) / list.length

    // With no rejections there is nothing to contrast against, so a pairwise
    // difference stands on its own and a one-sided approve set does not.
    const signal = unwanted.length === 0 && pairwise.length === 0 ? 0 : mean(wanted) - mean(unwanted)
    if (signal === 0) continue

    const direction = Math.sign(signal)
    const magnitude = Math.min(Math.abs(signal) / 100, 1)
    next[key] = current[key] * (1 + direction * magnitude * MAX_STEP)
  }

  const weights = normalise(next)
  const changed = COMPONENTS.some((key) => Math.abs(weights[key] - current[key]) > 0.5)

  if (changed) {
    await db
      .insert(huntSpecs)
      .values({ userId, scoreWeights: weights })
      .onConflictDoUpdate({
        target: huntSpecs.userId,
        set: { scoreWeights: weights, updatedAt: new Date() },
      })
    logger.info({ userId, examples: examples.length, weights }, 'refit score weights')
  }

  return { userId, examples: examples.length, changed, weights }
}

/** Refits every user who has produced any signal. Run nightly. */
export async function refitAllWeights(): Promise<number> {
  const since = new Date(Date.now() - 30 * 86_400_000)
  const active = await db
    .selectDistinct({ userId: huntRunJobs.userId })
    .from(huntRunJobs)
    .where(gte(huntRunJobs.updatedAt, since))

  let changed = 0
  for (const row of active) {
    const result = await refitWeights(row.userId).catch((error: unknown) => {
      logger.warn({ err: error, userId: row.userId }, 'weight refit failed')
      return null
    })
    if (result?.changed) changed += 1
  }
  return changed
}
