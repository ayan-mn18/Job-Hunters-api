import crypto from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod/v4'
import { hasModelAccess } from '../../config/env.js'
import { db } from '../../db/client.js'
import { jobReranks } from '../../db/schema.js'
import { logger } from '../../lib/logger.js'
import { modelFor, structured } from '../../model/gateway.js'
import { hashText } from './normalise.js'

/**
 * Stage B: what the deterministic scorer cannot see.
 *
 * Stage A counts skill overlap, seniority and location. It is fast, free and
 * explainable, and it will happily rank a posting it does not understand — a
 * "Backend Engineer" role that is really three years of maintaining a legacy
 * PHP monolith scores the same as one building the thing this candidate wants
 * to build, because the words match.
 *
 * This reads the posting. It runs only on the shortlist, is cached on the
 * description hash so a reposted job is free, and is keyed by persona version
 * so editing the hunt spec invalidates the verdict rather than silently
 * keeping a stale one.
 *
 * Without a model configured it returns the input untouched. Discovery must
 * work without it.
 */

export interface RerankInput {
  jobId: string
  title: string
  company: string
  descriptionText: string | null
  descriptionHash: string | null
  /** The deterministic score, so the model sees what we already thought. */
  baseScore: number
}

export interface RerankVerdict {
  jobId: string
  fit: number
  rationale: string
  whyNot: string | null
}

export interface PersonaForRerank {
  roles: string[]
  locations: string[]
  skills: string[]
  maxYearsExperience: number
  dealBreakers: string[]
}

/**
 * A stable identity for "the person as they are configured right now". Change
 * a role or a deal-breaker and every cached verdict stops applying, which is
 * correct — the question being asked has changed.
 */
export function personaVersion(persona: PersonaForRerank): string {
  const canonical = JSON.stringify({
    roles: [...persona.roles].sort(),
    locations: [...persona.locations].sort(),
    skills: [...persona.skills].sort(),
    maxYearsExperience: persona.maxYearsExperience,
    dealBreakers: [...persona.dealBreakers].sort(),
  })
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

const verdictSchema = z.object({
  verdicts: z.array(
    z.object({
      index: z.number().int().describe('The index of the job in the list you were given'),
      fit: z.number().int().min(0).max(100).describe('How well this person could get and want this job'),
      rationale: z.string().max(240).describe('One sentence, concrete, citing the posting'),
      why_not: z
        .string()
        .max(240)
        .describe('The single strongest reason against, always filled in, even for a good match'),
    }),
  ),
})

const SYSTEM = `You assess how well a specific candidate fits specific job postings.

Judge two things together: whether this candidate could plausibly get the job, and whether they would want it given what they asked for. A posting that matches their keywords but is the wrong seniority, the wrong domain, or asks for a stack they do not have is a poor fit however many words overlap.

Rules:
- Cite the posting. Never invent a requirement it does not state.
- If the description is thin, say so and score conservatively rather than guessing.
- why_not is always filled in, even for a strong match. There is always something.
- Be blunt. A hedged assessment is useless to someone deciding where to spend an application.`

/** Jobs per request. Small enough that one bad posting cannot poison a batch. */
const BATCH_SIZE = 8
/** How much of a description the model needs. Beyond this is boilerplate. */
const DESCRIPTION_CHARS = 2_500

function promptFor(persona: PersonaForRerank, batch: RerankInput[]): string {
  const candidate = [
    `Target roles: ${persona.roles.join(', ') || 'not specified'}`,
    `Locations: ${persona.locations.join(', ') || 'not specified'}`,
    `Years of experience: up to ${persona.maxYearsExperience}`,
    `Skills: ${persona.skills.slice(0, 40).join(', ') || 'not specified'}`,
    persona.dealBreakers.length > 0 ? `Deal breakers: ${persona.dealBreakers.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const postings = batch
    .map((job, index) => {
      const description = (job.descriptionText ?? '').slice(0, DESCRIPTION_CHARS)
      return `--- index ${index}
Title: ${job.title}
Company: ${job.company}
Description: ${description || '(none published)'}`
    })
    .join('\n\n')

  return `CANDIDATE\n${candidate}\n\nPOSTINGS\n${postings}\n\nReturn one verdict per posting, using the index given.`
}

async function readCache(
  hashes: string[],
  version: string,
): Promise<Map<string, { fit: number; rationale: string; whyNot: string | null }>> {
  if (hashes.length === 0) return new Map()
  const rows = await db
    .select()
    .from(jobReranks)
    .where(and(inArray(jobReranks.descriptionHash, hashes), eq(jobReranks.personaVersion, version)))
  return new Map(
    rows.map((row) => [row.descriptionHash, { fit: row.fit, rationale: row.rationale, whyNot: row.whyNot }]),
  )
}

export async function rerank(
  userId: string,
  persona: PersonaForRerank,
  candidates: RerankInput[],
): Promise<Map<string, RerankVerdict>> {
  const out = new Map<string, RerankVerdict>()
  if (!hasModelAccess || candidates.length === 0) return out

  const version = personaVersion(persona)

  // A job with no description cannot be assessed by reading it, and asking
  // anyway would produce a confident guess — the failure mode this exists to
  // avoid.
  const readable = candidates.filter((job) => (job.descriptionText ?? '').length >= 200)
  const hashes = [...new Set(readable.map((job) => job.descriptionHash ?? hashText(job.title + job.company)))]
  const cached = await readCache(hashes, version).catch(() => new Map())

  const misses: RerankInput[] = []
  for (const job of readable) {
    const hash = job.descriptionHash ?? hashText(job.title + job.company)
    const hit = cached.get(hash)
    if (hit) {
      out.set(job.jobId, { jobId: job.jobId, fit: hit.fit, rationale: hit.rationale, whyNot: hit.whyNot })
    } else {
      misses.push(job)
    }
  }

  const batches: RerankInput[][] = []
  for (let offset = 0; offset < misses.length; offset += BATCH_SIZE) {
    batches.push(misses.slice(offset, offset + BATCH_SIZE))
  }

  const model = modelFor('rerank')
  const rows: Array<typeof jobReranks.$inferInsert> = []

  for (const batch of batches) {
    try {
      const answer = await structured(verdictSchema, {
        purpose: 'rerank',
        userId,
        system: SYSTEM,
        prompt: promptFor(persona, batch),
        // Reading a job description against a profile is a judgement, not a
        // puzzle. Low effort keeps a shortlist affordable.
        effort: 'low',
        maxTokens: 4_000,
      })

      for (const verdict of answer.verdicts) {
        const job = batch[verdict.index]
        if (!job) continue
        const whyNot = verdict.why_not.trim() || null
        out.set(job.jobId, {
          jobId: job.jobId,
          fit: verdict.fit,
          rationale: verdict.rationale.trim(),
          whyNot,
        })
        rows.push({
          descriptionHash: job.descriptionHash ?? hashText(job.title + job.company),
          personaVersion: version,
          fit: verdict.fit,
          rationale: verdict.rationale.trim(),
          whyNot,
          model,
        })
      }
    } catch (error) {
      // A failed batch means those jobs keep their stage-A score. Discovery
      // continuing with a slightly worse ordering beats a run that dies.
      logger.warn({ err: error, size: batch.length }, 'rerank batch failed; keeping stage-A scores')
    }
  }

  if (rows.length > 0) {
    await db.insert(jobReranks).values(rows).onConflictDoNothing().catch((error: unknown) => {
      logger.debug({ err: error }, 'could not cache rerank verdicts')
    })
  }

  return out
}

/**
 * Blends the two scores.
 *
 * Deliberately an average rather than a replacement. Stage A is auditable and
 * the user can see every component; handing the whole ranking to a model would
 * make "why is this job first" unanswerable. Half and half keeps the model
 * able to rescue a good posting the keywords missed, and to sink a bad one
 * they flattered, without either being able to act alone.
 */
export function blendScore(baseScore: number, fit: number): number {
  return Math.round(baseScore * 0.5 + fit * 0.5)
}
