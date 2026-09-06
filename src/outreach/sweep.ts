import { and, eq } from 'drizzle-orm'
import type { BrowserContext } from 'playwright-core'
import { db } from '../db/client.js'
import { employments, kits, outreachTargets, userSchedules } from '../db/schema.js'
import { logger } from '../lib/logger.js'
import { findProspects, type CandidateContext } from '../skills/linkedin/find.js'
import { discoverProspects } from './sequence.js'

/**
 * One prospecting pass, run in the same locked job as the referral sweep.
 *
 * Sequential, never concurrent. The invariant everywhere else in this codebase
 * is one live session per user per resource, and the user lock is held across
 * both passes — so the account never has two sets of LinkedIn traffic in
 * flight at once, which is exactly the pattern the caps exist to avoid.
 */

const SENIOR = /\b(?:senior|sr\.?|staff|principal|lead)\b/i

/** Companies looked at per sweep. Low: each one is a real search. */
const MAX_TARGETS_PER_SWEEP = 2

async function candidateContextFor(userId: string): Promise<CandidateContext> {
  const [[kit], history] = await Promise.all([
    db.select().from(kits).where(eq(kits.userId, userId)).limit(1),
    db
      .select({ company: employments.company, role: employments.role })
      .from(employments)
      .where(eq(employments.userId, userId)),
  ])

  return {
    targetRole: kit?.headline ?? null,
    targetIsSenior: SENIOR.test(kit?.headline ?? '') || (kit?.maxYearsExperience ?? 0) >= 5,
    pastEmployers: history.map((row) => row.company).filter(Boolean),
    schools: [],
    city: kit?.city ?? null,
    skills: kit?.skills ?? [],
  }
}

export interface SweepOutcome {
  companiesLookedAt: number
  prospectsFound: number
}

export async function sweepOutreachTargets(
  userId: string,
  context: BrowserContext,
): Promise<SweepOutcome> {
  const [schedule] = await db
    .select({ enabled: userSchedules.outreachEnabled })
    .from(userSchedules)
    .where(eq(userSchedules.userId, userId))
    .limit(1)

  // Off by default, and this is where that is enforced for *reading* as well
  // as sending. Looking someone up is still acting on the account.
  if (!schedule?.enabled) return { companiesLookedAt: 0, prospectsFound: 0 }

  const targets = await db
    .select()
    .from(outreachTargets)
    .where(and(eq(outreachTargets.userId, userId), eq(outreachTargets.status, 'active')))
    .limit(MAX_TARGETS_PER_SWEEP)

  if (targets.length === 0) return { companiesLookedAt: 0, prospectsFound: 0 }

  const candidate = await candidateContextFor(userId)
  let prospectsFound = 0

  for (const target of targets) {
    try {
      const people = await findProspects(context, {
        company: target.company,
        targetRole: target.targetRole,
        candidate,
      })
      if (people.length === 0) continue

      const ranked = await discoverProspects({
        userId,
        targetId: target.id,
        company: target.company,
        targetRole: target.targetRole,
        jobTitle: null,
        candidates: people,
      })
      prospectsFound += ranked.length

      logger.info(
        { userId, company: target.company, seen: people.length, kept: ranked.length },
        'prospected a company',
      )
    } catch (error) {
      // A checkpoint propagates: the caller trips the breaker and stops
      // everything on the account rather than moving to the next company.
      throw error
    }
  }

  return { companiesLookedAt: targets.length, prospectsFound }
}
