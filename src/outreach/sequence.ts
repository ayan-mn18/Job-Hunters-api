import { and, eq, gte, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  accountHealth,
  kits,
  outreachMessages,
  outreachProspects,
  outreachTargets,
  userSchedules,
  type OutreachProspect,
} from '../db/schema.js'
import { logger } from '../lib/logger.js'
import { recordActivity } from '../services/activity.js'
import { composeOutreach, type ComposeContext } from './compose.js'
import { canSend, DEFAULT_LIMITS, nextGapMs, shouldWithdraw } from './limits.js'
import { rankProspects, worthContacting, type Prospect, type RankedProspect } from './rank.js'

const PORTAL_ID = 'linkedin'

/**
 * The outreach state machine.
 *
 * Every state change goes through here, and every send goes through
 * `canSend`. That is deliberate: this is the highest-risk automation in the
 * product — LinkedIn restricts the *user's* account, not our server — so the
 * gate lives in one place that no code path can route around, rather than
 * being re-checked correctly at each call site until one day it is not.
 */

/* ------------------------------------------------------------------- health */

export async function loadHealth(userId: string) {
  const [row] = await db
    .select()
    .from(accountHealth)
    .where(and(eq(accountHealth.userId, userId), eq(accountHealth.portalId, PORTAL_ID)))
    .limit(1)
  if (row) return row

  const [created] = await db
    .insert(accountHealth)
    .values({ userId, portalId: PORTAL_ID })
    .onConflictDoNothing()
    .returning()
  if (created) return created

  const [existing] = await db
    .select()
    .from(accountHealth)
    .where(and(eq(accountHealth.userId, userId), eq(accountHealth.portalId, PORTAL_ID)))
    .limit(1)
  if (!existing) throw new Error('Could not open account health')
  return existing
}

/**
 * Trips the breaker.
 *
 * Called when LinkedIn shows a checkpoint, a challenge, or a verification
 * page. It pauses *everything* on that account, not just outreach: if the
 * platform is asking whether the user is a human, the correct response is to
 * stop being suspicious rather than to keep reading.
 */
export async function tripBreaker(userId: string, reason: string): Promise<void> {
  const until = new Date(Date.now() + DEFAULT_LIMITS.breakerPauseMs)
  await db
    .update(accountHealth)
    .set({
      pausedUntil: until,
      challenges30d: sql`${accountHealth.challenges30d} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(accountHealth.userId, userId), eq(accountHealth.portalId, PORTAL_ID)))

  await recordActivity({
    userId,
    kind: 'portal_disconnected',
    text: `LinkedIn automation paused for ${Math.round(DEFAULT_LIMITS.breakerPauseMs / 3_600_000)}h — ${reason}`,
    meta: { portal: PORTAL_ID, until: until.toISOString() },
  }).catch(() => undefined)

  logger.warn({ userId, reason, until }, 'outreach breaker tripped')
}

/**
 * Counts the invitations actually sent, rather than trusting stored counters.
 *
 * The counters on `account_health` are for the health strip. The caps are
 * enforced against the `outreach_prospects` rows themselves, because a
 * counter that drifts — a crashed worker, a manual database edit — would
 * drift in the direction of sending *more*, and that is the one direction
 * that costs the user their account.
 */
async function sentCounts(userId: string): Promise<{ today: number; week: number }> {
  const now = Date.now()
  const [row] = await db
    .select({
      today: sql<number>`count(*) filter (where ${outreachProspects.invitedAt} >= ${new Date(now - 86_400_000)})::int`,
      week: sql<number>`count(*) filter (where ${outreachProspects.invitedAt} >= ${new Date(now - 7 * 86_400_000)})::int`,
    })
    .from(outreachProspects)
    .where(and(eq(outreachProspects.userId, userId), isNotNull(outreachProspects.invitedAt)))
  return { today: row?.today ?? 0, week: row?.week ?? 0 }
}

/* ------------------------------------------------------------------ finding */

export interface DiscoverInput {
  userId: string
  targetId: string
  company: string
  targetRole: string | null
  jobTitle: string | null
  /** Supplied by the LinkedIn session scraper; empty until that runs. */
  candidates: Prospect[]
}

/**
 * Ranks and stores who to approach, then drafts each message.
 *
 * Drafting happens here rather than at send time so a human sees the words
 * before they are queued, which is the entire point of the approval gate.
 */
export async function discoverProspects(input: DiscoverInput): Promise<RankedProspect[]> {
  const ranked = rankProspects(input.candidates).filter(worthContacting)
  if (ranked.length === 0) return []

  const [kit] = await db.select().from(kits).where(eq(kits.userId, input.userId)).limit(1)
  const context: ComposeContext = {
    userId: input.userId,
    headline: kit?.headline ?? 'software engineer',
    yearsExperience: kit?.maxYearsExperience ?? 5,
    topSkills: kit?.skills ?? [],
    company: input.company,
    targetRole: input.targetRole,
    jobTitle: input.jobTitle,
  }

  for (const prospect of ranked) {
    const [row] = await db
      .insert(outreachProspects)
      .values({
        targetId: input.targetId,
        userId: input.userId,
        profileUrl: prospect.profileUrl,
        name: prospect.name,
        title: prospect.title,
        degree: prospect.degree,
        signals: { relationship: prospect.relationship, reasons: prospect.signals },
        score: prospect.score,
        // Someone already connected needs no invitation — the ask goes
        // straight to them, which is both safer and the highest-converting
        // path in the whole engine.
        state: prospect.relationship === 'first_degree' ? 'accepted' : 'identified',
      })
      .onConflictDoNothing()
      .returning()
    if (!row) continue

    const draft = await composeOutreach(prospect, context)
    await db.insert(outreachMessages).values([
      { prospectId: row.id, userId: input.userId, kind: 'invite', body: draft.invite },
      { prospectId: row.id, userId: input.userId, kind: 'ask', body: draft.ask },
    ])

    await db
      .update(outreachProspects)
      .set({ state: prospect.relationship === 'first_degree' ? 'accepted' : 'drafted', updatedAt: new Date() })
      .where(eq(outreachProspects.id, row.id))
  }

  return ranked
}

/* ------------------------------------------------------------------ sending */

export interface SendableMessage {
  messageId: string
  prospectId: string
  profileUrl: string
  name: string
  kind: string
  body: string
  company: string
}

/**
 * The next message that may actually be sent, or a reason why none may.
 *
 * One at a time on purpose. The gap between sends is jittered and measured in
 * minutes, so a queue that hands out one message per call is the natural
 * shape — and it means the caps are re-checked against fresh counters before
 * every single send rather than once per batch.
 */
export async function nextSendable(
  userId: string,
): Promise<{ message: SendableMessage } | { blocked: string }> {
  const health = await loadHealth(userId)
  const counts = await sentCounts(userId)
  const [schedule] = await db
    .select({ timezone: userSchedules.timezone, enabled: userSchedules.outreachEnabled })
    .from(userSchedules)
    .where(eq(userSchedules.userId, userId))
    .limit(1)

  if (!schedule?.enabled) return { blocked: 'Outbound referrals are switched off for this account.' }

  const rows = await db
    .select({
      message: outreachMessages,
      prospect: outreachProspects,
      target: outreachTargets,
    })
    .from(outreachMessages)
    .innerJoin(outreachProspects, eq(outreachMessages.prospectId, outreachProspects.id))
    .innerJoin(outreachTargets, eq(outreachProspects.targetId, outreachTargets.id))
    .where(
      and(
        eq(outreachMessages.userId, userId),
        isNotNull(outreachMessages.approvedAt),
        isNull(outreachMessages.sentAt),
      ),
    )
    .orderBy(outreachProspects.score)
    .limit(25)

  for (const row of rows) {
    // An `ask` only goes to someone who has accepted; an `invite` only to
    // someone who has not been invited yet. Without this, an approved ask
    // could be sent to a stranger.
    const wantsInvite = row.message.kind === 'invite'
    if (wantsInvite && row.prospect.state !== 'drafted' && row.prospect.state !== 'approved') continue
    if (!wantsInvite && row.prospect.state !== 'accepted') continue

    const companyToday = await countCompanyInvitesToday(userId, row.target.company)
    const verdict = canSend({
      now: new Date(),
      timezone: schedule.timezone,
      invitesToday: counts.today,
      invitesThisWeek: counts.week,
      invitesToThisCompanyToday: companyToday,
      pausedUntil: health.pausedUntil,
      approved: true,
    })

    if (!verdict.ok) return { blocked: verdict.because ?? 'Waiting.' }

    return {
      message: {
        messageId: row.message.id,
        prospectId: row.prospect.id,
        profileUrl: row.prospect.profileUrl,
        name: row.prospect.name,
        kind: row.message.kind,
        body: row.message.body,
        company: row.target.company,
      },
    }
  }

  return { blocked: 'Nothing approved and waiting.' }
}

async function countCompanyInvitesToday(userId: string, company: string): Promise<number> {
  const dayAgo = new Date(Date.now() - 86_400_000)
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(outreachProspects)
    .innerJoin(outreachTargets, eq(outreachProspects.targetId, outreachTargets.id))
    .where(
      and(
        eq(outreachProspects.userId, userId),
        eq(outreachTargets.company, company),
        isNotNull(outreachProspects.invitedAt),
        gte(outreachProspects.invitedAt, dayAgo),
      ),
    )
  return row?.value ?? 0
}

/** Records a send that actually happened, and advances the prospect. */
export async function markSent(
  userId: string,
  message: SendableMessage,
  outcome: { ok: true } | { ok: false; error: string },
): Promise<void> {
  const now = new Date()

  if (!outcome.ok) {
    // The message stays unsent and keeps its approval, so a transient failure
    // is retried rather than silently dropping someone from the sequence.
    await db
      .update(outreachProspects)
      .set({ outcome: `send failed: ${outcome.error}`.slice(0, 300), updatedAt: now })
      .where(eq(outreachProspects.id, message.prospectId))
    return
  }

  await db
    .update(outreachMessages)
    .set({ sentAt: now, updatedAt: now })
    .where(eq(outreachMessages.id, message.messageId))

  if (message.kind === 'invite') {
    await db
      .update(outreachProspects)
      .set({ state: 'invited', invitedAt: now, updatedAt: now })
      .where(eq(outreachProspects.id, message.prospectId))
    await db
      .update(accountHealth)
      .set({
        invitesToday: sql`${accountHealth.invitesToday} + 1`,
        invites7d: sql`${accountHealth.invites7d} + 1`,
        updatedAt: now,
      })
      .where(and(eq(accountHealth.userId, userId), eq(accountHealth.portalId, PORTAL_ID)))
    return
  }

  await db
    .update(outreachProspects)
    .set({ state: 'asked', askedAt: now, updatedAt: now })
    .where(eq(outreachProspects.id, message.prospectId))
}

/** How long to wait before offering the next message. */
export function pacingDelayMs(): number {
  return nextGapMs()
}

/* -------------------------------------------------------------- withdrawals */

/**
 * Invitations nobody accepted, past the withdrawal age.
 *
 * A low acceptance rate is itself a signal LinkedIn reads, so withdrawing
 * stale invitations protects the ratio — which protects the account. This is
 * housekeeping that looks optional and is not.
 */
export async function staleInvites(userId: string): Promise<OutreachProspect[]> {
  const cutoff = new Date(Date.now() - DEFAULT_LIMITS.withdrawAfterDays * 86_400_000)
  return db
    .select()
    .from(outreachProspects)
    .where(
      and(
        eq(outreachProspects.userId, userId),
        eq(outreachProspects.state, 'invited'),
        isNotNull(outreachProspects.invitedAt),
        lt(outreachProspects.invitedAt, cutoff),
      ),
    )
    .limit(20)
}

export async function markWithdrawn(prospectId: string): Promise<void> {
  await db
    .update(outreachProspects)
    .set({ state: 'withdrawn', outcome: 'invitation withdrawn unaccepted', updatedAt: new Date() })
    .where(eq(outreachProspects.id, prospectId))
}

/**
 * Acceptance rate — the number the health strip leads with, because it is the
 * first place a quietly damaged account shows up.
 *
 * Computed from the prospect rows rather than a stored ratio: there is no
 * value in caching a number this cheap, and a stale one would be worse than
 * none.
 */
export async function acceptanceRate(userId: string): Promise<{ invited: number; accepted: number; rate: number | null }> {
  const [row] = await db
    .select({
      invited: sql<number>`count(*) filter (where ${outreachProspects.invitedAt} is not null)::int`,
      accepted: sql<number>`count(*) filter (where ${outreachProspects.acceptedAt} is not null)::int`,
    })
    .from(outreachProspects)
    .where(eq(outreachProspects.userId, userId))

  const invited = row?.invited ?? 0
  const accepted = row?.accepted ?? 0
  return { invited, accepted, rate: invited === 0 ? null : accepted / invited }
}

export { shouldWithdraw }
