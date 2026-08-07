/**
 * The 24-hour filter.
 *
 * Two things make this harder than `postedAt > now - 24h`:
 *
 * 1. The cron fires at 06:00 Asia/Kolkata, which is 00:30 UTC. Every stored
 *    timestamp is UTC and every comparison happens in UTC; IST exists only at
 *    the edges, when we decide *when* to run and when we print a report. Never
 *    do date arithmetic in local time — IST's :30 offset breaks naive
 *    hour-based maths, and a DST-observing portal timezone breaks it worse.
 *
 * 2. Plenty of portals only say "3 days ago". That string is an interval, not
 *    an instant. We resolve it to [earliest, latest] and keep the posting if
 *    that interval overlaps our window. Over-including costs one scoring pass;
 *    under-including means the user never sees the job.
 */
import type { PostedAtPrecision } from './types.ts'

export const IST_TZ = 'Asia/Kolkata'

/** The instant a job could have been posted, given a fuzzy source string. */
export interface PostedInterval {
  earliest: Date
  latest: Date
  precision: PostedAtPrecision
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const MONTH = 30 * DAY

const UNIT_MS: Record<string, number> = {
  second: 1_000,
  sec: 1_000,
  s: 1_000,
  minute: MINUTE,
  min: MINUTE,
  m: MINUTE,
  hour: HOUR,
  hr: HOUR,
  h: HOUR,
  day: DAY,
  d: DAY,
  week: WEEK,
  w: WEEK,
  month: MONTH,
  mo: MONTH,
  year: 365 * DAY,
  y: 365 * DAY,
}

/**
 * Parse the relative-time strings job boards actually print.
 * Handles "3 days ago", "2h", "just now", "yesterday", "30+ days ago",
 * "Posted 5 hours ago", "il y a 2 jours" is explicitly *not* handled — if a
 * portal is non-English, give its adapter its own parser rather than widening
 * this one until it guesses wrong.
 *
 * Returns the interval the string could denote, anchored at `now`.
 */
export function parseRelative(input: string, now: Date): PostedInterval | null {
  const s = input.toLowerCase().trim()
  if (!s) return null

  if (/^(just now|today|moments? ago|new|now)$/.test(s) || s.includes('just posted')) {
    return { earliest: new Date(now.getTime() - DAY), latest: now, precision: 'relative' }
  }

  if (s.includes('yesterday')) {
    return {
      earliest: new Date(now.getTime() - 2 * DAY),
      latest: new Date(now.getTime() - DAY),
      precision: 'relative',
    }
  }

  // "30+ days ago" — an open-ended floor. Latest possible is 30 days back.
  const plus = s.match(/(\d+)\s*\+\s*([a-z]+)/)
  if (plus) {
    const n = Number(plus[1])
    const unit = UNIT_MS[normaliseUnit(plus[2] ?? '')]
    if (unit) {
      return {
        earliest: new Date(0),
        latest: new Date(now.getTime() - n * unit),
        precision: 'relative',
      }
    }
  }

  const m = s.match(/(?:^|\s)(\d+)\s*([a-z]+)/)
  if (!m) return null
  const n = Number(m[1])
  const unit = UNIT_MS[normaliseUnit(m[2] ?? '')]
  if (!Number.isFinite(n) || !unit) return null

  // "3 days ago" means the posting is somewhere in the third day back: between
  // 3 and 4 units ago, because boards floor the number rather than round it.
  return {
    earliest: new Date(now.getTime() - (n + 1) * unit),
    latest: new Date(now.getTime() - n * unit),
    precision: 'relative',
  }
}

function normaliseUnit(u: string): string {
  const stripped = u.replace(/s$/, '')
  return stripped in UNIT_MS ? stripped : u
}

/**
 * Turn whatever a portal gave us into an interval. Accepts epoch seconds,
 * epoch millis, ISO strings, RFC 2822 (RSS pubDate) and relative text.
 */
export function toInterval(value: unknown, now: Date): PostedInterval | null {
  if (value == null) return null

  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: anything below ~year 2286 in millis is really epoch seconds.
    const ms = value < 1e11 ? value * 1000 : value
    const d = new Date(ms)
    if (Number.isNaN(d.getTime())) return null
    return { earliest: d, latest: d, precision: 'exact' }
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : { earliest: value, latest: value, precision: 'exact' }
  }

  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!s) return null

  // Numeric string, e.g. "1786037628".
  if (/^\d{9,14}$/.test(s)) return toInterval(Number(s), now)

  // A bare date with no time: precision is the whole day, in UTC.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const start = new Date(`${s}T00:00:00.000Z`)
    if (Number.isNaN(start.getTime())) return null
    return { earliest: start, latest: new Date(start.getTime() + DAY - 1), precision: 'day' }
  }

  // Date.parse covers ISO 8601 with offset and RFC 2822 pubDate.
  const parsed = new Date(s)
  if (!Number.isNaN(parsed.getTime())) {
    return { earliest: parsed, latest: parsed, precision: 'exact' }
  }

  return parseRelative(s, now)
}

/**
 * Does this posting belong in a sweep covering [since, now]?
 *
 * Exact and day-precision timestamps are compared strictly. Relative and
 * first-seen intervals are kept if they *overlap* the window at all, which
 * deliberately errs toward including a borderline job.
 */
export function isWithinWindow(interval: PostedInterval, since: Date, now: Date): boolean {
  // A clock-skewed portal can report the future; treat that as "just posted"
  // rather than discarding a genuinely new listing.
  const latest = interval.latest.getTime()
  const earliest = interval.earliest.getTime()
  const lo = since.getTime()
  const hi = now.getTime() + 6 * HOUR

  if (interval.precision === 'exact' || interval.precision === 'day') {
    return latest >= lo && earliest <= hi
  }
  return latest >= lo && earliest <= hi
}

/** Representative instant to store in `ScrapedJob.postedAt`. */
export function representativeInstant(interval: PostedInterval, now: Date): Date {
  if (interval.precision === 'exact') return interval.latest
  // For a range, the latest plausible instant is the safest single value: it
  // keeps the job inside the window it was admitted under.
  const t = Math.min(interval.latest.getTime(), now.getTime())
  return new Date(t)
}

/**
 * The window for a run. `now` defaults to the actual clock; the cron passes
 * nothing, tests pass a fixed instant.
 */
export function windowFor(now: Date = new Date(), hours = 24): { since: Date; now: Date } {
  return { since: new Date(now.getTime() - hours * HOUR), now }
}

/** Render a UTC instant in IST, for human-facing run reports only. */
export function formatIST(d: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_TZ,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d)
}
