/**
 * The rails.
 *
 * This file exists before any of the outreach engine, and everything in that
 * module imports it, so no code path can send around it.
 *
 * Why it is this strict: automated connection requests violate LinkedIn's User
 * Agreement, LinkedIn enforces its own weekly invite ceiling, and enforcement
 * lands on **the member's account** — the user's, not the server's. Every
 * number below is deliberately well under what LinkedIn tolerates, because the
 * cost of being wrong is someone losing the account their career runs through.
 *
 * These are defaults, and they are meant to be raised only after watching a
 * few hundred invites go out cleanly.
 */

export interface OutreachLimits {
  invitesPerDay: number
  invitesPerWeek: number
  perCompanyPerDay: number
  /** Local hours, inclusive start, exclusive end. */
  sendWindow: { startHour: number; endHour: number }
  minGapMs: number
  maxGapMs: number
  withdrawAfterDays: number
  maxFollowUps: number
  followUpGapMs: number
  /** How long all automation pauses after a checkpoint or challenge. */
  breakerPauseMs: number
}

export const DEFAULT_LIMITS: OutreachLimits = {
  // LinkedIn's own weekly ceiling starts around 100. Fifteen a day sits well
  // under it with room for a bad week.
  invitesPerDay: 15,
  invitesPerWeek: 60,
  // Five people from one company hearing from you the same afternoon is the
  // pattern humans notice, never mind the algorithm.
  perCompanyPerDay: 5,
  // Invites at three in the morning are the clearest automation tell there is.
  sendWindow: { startHour: 9, endHour: 19 },
  minGapMs: 4 * 60_000,
  maxGapMs: 12 * 60_000,
  // A low acceptance rate is itself a flag; withdrawing protects the ratio.
  withdrawAfterDays: 21,
  maxFollowUps: 2,
  followUpGapMs: 48 * 3_600_000,
  breakerPauseMs: 72 * 3_600_000,
}

/** Actions we will never automate, whatever the caps say. */
export const NEVER_AUTOMATED = [
  'endorsements',
  'profile views at scale',
  'group joins',
  'comments',
  'posts',
  'messages to people who have not accepted',
] as const

export interface SendabilityInput {
  now: Date
  /** The user's IANA timezone — the window is theirs, not the server's. */
  timezone: string
  invitesToday: number
  invitesThisWeek: number
  invitesToThisCompanyToday: number
  /** Set while the circuit breaker is open. */
  pausedUntil: Date | null
  /** Nothing sends without a human approval on the message. */
  approved: boolean
  limits?: OutreachLimits
}

export type Refusal =
  | 'not_approved'
  | 'breaker_open'
  | 'outside_send_window'
  | 'daily_cap'
  | 'weekly_cap'
  | 'company_cap'

export interface Sendability {
  ok: boolean
  refusal?: Refusal
  /** Human-readable, shown in the approval tray. */
  because?: string
}

/** The local hour in a given IANA timezone, without pulling in a date library. */
export function localHour(now: Date, timezone: string): number {
  try {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).format(now)
    const hour = Number(formatted)
    return Number.isFinite(hour) ? hour % 24 : now.getUTCHours()
  } catch {
    return now.getUTCHours()
  }
}

/**
 * The single gate. Every send path calls this, and it answers with a reason
 * rather than a boolean so the tray can say why something is waiting.
 */
export function canSend(input: SendabilityInput): Sendability {
  const limits = input.limits ?? DEFAULT_LIMITS

  // Approval is checked first: a message nobody approved must not send even if
  // every other condition is satisfied.
  if (!input.approved) {
    return { ok: false, refusal: 'not_approved', because: 'Waiting for you to approve it.' }
  }

  if (input.pausedUntil && input.pausedUntil.getTime() > input.now.getTime()) {
    return {
      ok: false,
      refusal: 'breaker_open',
      because: 'LinkedIn asked for a verification. Everything is paused until you have cleared it.',
    }
  }

  const hour = localHour(input.now, input.timezone)
  if (hour < limits.sendWindow.startHour || hour >= limits.sendWindow.endHour) {
    return {
      ok: false,
      refusal: 'outside_send_window',
      because: `Outside your sending hours (${limits.sendWindow.startHour}:00–${limits.sendWindow.endHour}:00).`,
    }
  }

  if (input.invitesThisWeek >= limits.invitesPerWeek) {
    return {
      ok: false,
      refusal: 'weekly_cap',
      because: `You have sent ${input.invitesThisWeek} invites this week. Waiting for the week to roll over.`,
    }
  }

  if (input.invitesToday >= limits.invitesPerDay) {
    return {
      ok: false,
      refusal: 'daily_cap',
      because: `That is ${input.invitesToday} invites today. The rest go out tomorrow.`,
    }
  }

  if (input.invitesToThisCompanyToday >= limits.perCompanyPerDay) {
    return {
      ok: false,
      refusal: 'company_cap',
      because: 'Enough people from this company for one day.',
    }
  }

  return { ok: true }
}

/**
 * How long to wait before the next send.
 *
 * Randomised rather than a fixed interval, because a perfectly regular cadence
 * is itself the signal.
 */
export function nextGapMs(limits: OutreachLimits = DEFAULT_LIMITS, random = Math.random): number {
  const span = limits.maxGapMs - limits.minGapMs
  return Math.round(limits.minGapMs + random() * span)
}

/** True once an unaccepted invite is old enough to withdraw. */
export function shouldWithdraw(
  invitedAt: Date,
  now: Date,
  limits: OutreachLimits = DEFAULT_LIMITS,
): boolean {
  return now.getTime() - invitedAt.getTime() >= limits.withdrawAfterDays * 86_400_000
}
