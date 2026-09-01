import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { huntSpecs, intakeSessions, jobs, type IntakeSession } from '../db/schema.js'
import { badRequest } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { nextSlot, rankingInputFor } from './select.js'
import { rankJob } from '../hunt/ranking.js'
import { loadPersona, seedPersonaFromProfile, setSlot, slotValue, type Persona } from './store.js'
import { INTAKE_SLOTS, QUESTION_CAP, slotById, toStringList, type Question } from './slots.js'
import { recordPairwise } from './learn.js'

/**
 * One intake, start to finish.
 *
 * The server decides what to ask; the client only renders. That is deliberate
 * — the question list is a function of what the resume already said and what
 * would change the results, and neither is knowable in the browser.
 */

export interface IntakeStep {
  done: boolean
  /** How many have been asked, and the ceiling. For the progress bar. */
  asked: number
  cap: number
  slotId?: string
  question?: Question
  /** Current value, so the user confirms rather than recalls. */
  current?: unknown
  /** Why this is being asked. Shown small, and it is honest. */
  because?: string
}

async function openSession(userId: string): Promise<IntakeSession> {
  const [open] = await db
    .select()
    .from(intakeSessions)
    .where(and(eq(intakeSessions.userId, userId), isNull(intakeSessions.completedAt)))
    .orderBy(desc(intakeSessions.createdAt))
    .limit(1)
  if (open) return open

  // First call seeds from the resume and kit, so the intake starts already
  // knowing most of the answer.
  const seeded = await seedPersonaFromProfile(userId)
  logger.info({ userId, seeded: seeded.seeded.length, gaps: seeded.skipped.length }, 'persona seeded')

  const [created] = await db.insert(intakeSessions).values({ userId }).returning()
  if (!created) throw new Error('Could not open an intake session')
  return created
}

/** Chip options that depend on the person, not on the catalogue. */
function fillOptions(slotId: string, question: Question, persona: Persona): Question {
  if (slotId !== 'must_have_stack') return question
  const skills = slotValue<string[]>(persona, 'must_have_stack') ?? []
  return {
    ...question,
    options: skills.map((skill) => ({ value: skill, label: skill })),
  }
}

export async function nextQuestion(userId: string): Promise<IntakeStep> {
  const session = await openSession(userId)
  const asked = [...((session.asked as string[]) ?? [])]

  if (asked.length >= QUESTION_CAP) {
    return { done: true, asked: asked.length, cap: QUESTION_CAP }
  }

  const persona = await loadPersona(userId)

  // A chips question whose options come from the person — "which of your
  // skills do you want to keep using" — has nothing to show when we never
  // learned any. Showing it anyway offers an empty card and asks the user to
  // skip a question we should not have asked. Step over it instead.
  const skipped: string[] = []
  for (let attempt = 0; attempt < INTAKE_SLOTS.length; attempt += 1) {
    const choice = await nextSlot(persona, [...asked, ...skipped])
    if (!choice) break

    const question = fillOptions(choice.slot.id, choice.slot.question, persona)
    if (question.kind === 'chips' && (question.options ?? []).length === 0) {
      skipped.push(choice.slot.id)
      continue
    }

    return {
      done: false,
      asked: asked.length,
      cap: QUESTION_CAP,
      slotId: choice.slot.id,
      question,
      current: persona.slots.get(choice.slot.id)?.value ?? null,
      because: choice.impact.measured
        ? 'Your answer changes which jobs you see.'
        : 'We could not work this out from your resume.',
    }
  }

  return { done: true, asked: asked.length, cap: QUESTION_CAP }
}

export async function submitAnswer(
  userId: string,
  slotId: string,
  value: unknown,
): Promise<IntakeStep> {
  const definition = slotById(slotId)
  if (!definition) throw badRequest(`Unknown question: ${slotId}`)

  const session = await openSession(userId)
  const asked = new Set([...((session.asked as string[]) ?? []), slotId])

  // An answer the user typed is the highest-confidence thing we have.
  await setSlot(userId, slotId, value, 1, 'asked')
  await db
    .update(intakeSessions)
    .set({ asked: [...asked], questionsAsked: asked.size, updatedAt: new Date() })
    .where(eq(intakeSessions.id, session.id))

  await syncSpecFromPersona(userId)
  return nextQuestion(userId)
}

export async function completeIntake(userId: string): Promise<{ questionsAsked: number }> {
  const session = await openSession(userId)
  await db
    .update(intakeSessions)
    .set({ completedAt: new Date(), updatedAt: new Date() })
    .where(eq(intakeSessions.id, session.id))
  await syncSpecFromPersona(userId)
  return { questionsAsked: session.questionsAsked }
}

/**
 * Pushes the persona into `hunt_specs`, which is what discovery reads.
 *
 * The persona is the richer model, but the query planner and scorer already
 * read the spec and there is no value in two sources of truth for the same
 * three lists.
 */
export async function syncSpecFromPersona(userId: string): Promise<void> {
  const persona = await loadPersona(userId)
  const roles = slotValue<string[]>(persona, 'target_titles')
  const markets = slotValue<string[]>(persona, 'markets')
  const avoid = slotValue<unknown>(persona, 'avoid')
  const locationMode = slotValue<string>(persona, 'location_mode')

  const locations = [...(markets ?? [])]
  // "Remote only" has to reach the planner as a location, or a remote-only
  // user gets searched for in whichever city their resume mentioned.
  if (locationMode === 'remote' && !locations.some((entry) => /remote/i.test(entry))) {
    locations.unshift('Remote')
  }

  const dealBreakers = toStringList(avoid)

  const patch: Record<string, unknown> = {}
  if (roles && roles.length > 0) patch.roles = roles
  if (locations.length > 0) patch.locations = locations
  if (dealBreakers.length > 0) patch.dealBreakers = dealBreakers
  if (Object.keys(patch).length === 0) return

  await db
    .insert(huntSpecs)
    .values({ userId, ...patch })
    .onConflictDoUpdate({ target: huntSpecs.userId, set: { ...patch, updatedAt: new Date() } })
}

/* ----------------------------------------------------------------- pairwise */

export interface PairwiseCard {
  left: { jobId: string; title: string; company: string; location: string; skills: string[] }
  right: { jobId: string; title: string; company: string; location: string; skills: string[] }
  round: number
  rounds: number
}

/** Three rounds. Enough to move the weights, few enough to stay a game. */
export const PAIRWISE_ROUNDS = 3

/** What the card shows, plus what scoring needs to compare two postings. */
interface PairJob {
  id: string
  title: string
  company: string
  locations: unknown
  skills: string[]
  remoteMode: string
  experienceMin: number | null
  experienceMax: number | null
  experienceText: string | null
}

function cardFor(job: PairJob) {
  const locations = (job.locations as Array<{ raw?: string }>) ?? []
  return {
    jobId: job.id,
    title: job.title,
    company: job.company,
    location: locations.map((entry) => entry.raw).filter(Boolean).join('; ') || 'Not stated',
    skills: job.skills.slice(0, 6),
  }
}

/**
 * Two real postings, as different from each other as we can find.
 *
 * Comparing two near-identical jobs teaches nothing. The pair is picked to
 * disagree — different companies, different skill sets — because the whole
 * point is to surface a trade-off the user could not have stated on a form.
 */
export async function nextPairwise(userId: string, round: number): Promise<PairwiseCard | null> {
  if (round > PAIRWISE_ROUNDS) return null

  const pool = await db
    .select({
      id: jobs.id,
      title: jobs.title,
      company: jobs.company,
      locations: jobs.locations,
      skills: jobs.skills,
      remoteMode: jobs.remoteMode,
      experienceMin: jobs.experienceMin,
      experienceMax: jobs.experienceMax,
      experienceText: jobs.experienceText,
    })
    .from(jobs)
    .orderBy(desc(jobs.postedAt))
    .limit(120)
  if (pool.length < 2) return null

  // Score every posting first. The pair is then chosen to disagree on the
  // *components the learning reads* — picking on skill overlap instead
  // produced comparisons where both jobs scored identically on every
  // component, so the answer carried no information at all.
  const persona = await loadPersona(userId)
  const input = rankingInputFor(persona)
  const scored = pool.map((job) => ({
    job,
    breakdown: rankJob(
      {
        title: job.title,
        company: job.company,
        locations: (job.locations ?? []) as never,
        remote: job.remoteMode as never,
        skills: job.skills,
        experience: { min: job.experienceMin, max: job.experienceMax, text: job.experienceText },
        tags: [],
      },
      input,
    ).breakdown,
  }))

  const components = ['coverage', 'stack', 'experience', 'seniority', 'location'] as const
  const spread = (a: (typeof scored)[number], b: (typeof scored)[number]): number =>
    components.reduce((sum, key) => sum + Math.abs((a.breakdown[key] ?? 0) - (b.breakdown[key] ?? 0)), 0)

  let best: { left: PairJob; right: PairJob; distance: number } | null = null
  // Offset by the round so each round shows a different part of the pool.
  const stride = Math.max(1, Math.floor(scored.length / (PAIRWISE_ROUNDS + 1)))
  const start = ((round - 1) * stride) % scored.length

  for (let i = start; i < Math.min(start + stride + 20, scored.length); i += 1) {
    for (let j = i + 1; j < Math.min(start + stride + 20, scored.length); j += 1) {
      const left = scored[i]
      const right = scored[j]
      if (!left || !right || left.job.company === right.job.company) continue
      const distance = spread(left, right)
      if (!best || distance > best.distance) {
        best = { left: left.job, right: right.job, distance }
      }
    }
  }

  // Two postings that score identically on every component teach nothing, so
  // there is no card worth showing this round.
  if (best && best.distance === 0) return null

  if (!best) return null
  return { left: cardFor(best.left), right: cardFor(best.right), round, rounds: PAIRWISE_ROUNDS }
}

export async function answerPairwise(
  userId: string,
  chosenJobId: string,
  rejectedJobId: string,
): Promise<void> {
  await recordPairwise(userId, chosenJobId, rejectedJobId)
}
