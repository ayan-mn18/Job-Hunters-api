import { env } from '../config/env.js'

/**
 * The UI renders pre-formatted strings — `appliedAt: "2 days ago"`,
 * `receivedAt: "09:12"`, a day label of `"Today"` / `"Yesterday"` / `"Wed 5"`.
 *
 * Formatting on the server is a deliberate choice: "today" has to agree with
 * the SQL that buckets referrals by day and computes the streak, and that
 * bucketing happens in APP_TIMEZONE, not in whatever timezone the browser
 * happens to be in. Responses carry the raw ISO value alongside every
 * formatted one, so the client can reformat if it ever wants to.
 */

const TZ = env.APP_TIMEZONE

/** `YYYY-MM-DD` for an instant, as seen in the app timezone. */
export function toLocalDateKey(value: Date | string, timeZone = TZ): string {
  const date = typeof value === 'string' ? new Date(value) : value
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '01'
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** `HH:mm`, 24-hour, in the app timezone. Matches the referral card. */
export function toLocalTimeLabel(value: Date | string, timeZone = TZ): string {
  const date = typeof value === 'string' ? new Date(value) : value
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

/**
 * "Today" / "Yesterday" / "Wed 5" — the day-picker chips on the Referrals
 * screen. `dateKey` is a `YYYY-MM-DD` string, already in the app timezone.
 */
export function toDayLabel(dateKey: string, now = new Date(), timeZone = TZ): string {
  const todayKey = toLocalDateKey(now, timeZone)
  if (dateKey === todayKey) return 'Today'

  const yesterday = new Date(now.getTime() - 86_400_000)
  if (dateKey === toLocalDateKey(yesterday, timeZone)) return 'Yesterday'

  // Parse as UTC noon so the weekday cannot slip across a timezone boundary.
  const asDate = new Date(`${dateKey}T12:00:00Z`)
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' }).format(
    asDate,
  )
  const dayOfMonth = Number(dateKey.slice(8, 10))
  return `${weekday} ${dayOfMonth}`
}

/** "4m ago", "3h ago", "2 days ago" — the activity feed and application rows. */
export function toRelativeLabel(value: Date | string | null | undefined, now = new Date()): string {
  if (!value) return ''
  const date = typeof value === 'string' ? new Date(value) : value
  const diffMs = now.getTime() - date.getTime()

  if (diffMs < 0) {
    const mins = Math.round(-diffMs / 60_000)
    if (mins < 60) return `in ${mins}m`
    const hours = Math.round(-diffMs / 3_600_000)
    if (hours < 24) return `in ${hours}h`
    const days = Math.round(-diffMs / 86_400_000)
    return days === 1 ? 'in 1 day' : `in ${days} days`
  }

  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return 'just now'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  if (days < 30) return days === 1 ? '1 day ago' : `${days} days ago`

  const months = Math.floor(days / 30)
  if (months < 12) return months === 1 ? '1 month ago' : `${months} months ago`

  const years = Math.floor(days / 365)
  return years === 1 ? '1 year ago' : `${years} years ago`
}

/**
 * Employment date range as the Kit screen shows it: "Jan 2024 — now".
 * A stored `periodLabel` always wins, for the cases where the real dates are
 * fuzzy ("summer 2021").
 */
export function toPeriodLabel(input: {
  startedOn: string | null
  endedOn: string | null
  isCurrent: boolean
  periodLabel: string | null
}): string {
  if (input.periodLabel) return input.periodLabel
  if (!input.startedOn) return ''

  const month = (key: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      month: 'short',
      year: 'numeric',
    }).format(new Date(`${key}T12:00:00Z`))

  const start = month(input.startedOn)
  if (input.isCurrent || !input.endedOn) return `${start} — now`
  return `${start} — ${month(input.endedOn)}`
}

/** Inclusive count of consecutive days ending today (or yesterday) with activity. */
export function computeStreak(dateKeys: string[], now = new Date(), timeZone = TZ): number {
  if (dateKeys.length === 0) return 0

  const unique = [...new Set(dateKeys)].sort().reverse()
  const todayKey = toLocalDateKey(now, timeZone)
  const yesterdayKey = toLocalDateKey(new Date(now.getTime() - 86_400_000), timeZone)

  // A streak stays alive until the end of the following day — otherwise it
  // would reset at midnight before the morning run has had a chance to fire.
  let cursor: string
  if (unique[0] === todayKey) cursor = todayKey
  else if (unique[0] === yesterdayKey) cursor = yesterdayKey
  else return 0

  let streak = 0
  for (const key of unique) {
    if (key !== cursor) break
    streak += 1
    const previous = new Date(`${cursor}T12:00:00Z`)
    previous.setUTCDate(previous.getUTCDate() - 1)
    cursor = previous.toISOString().slice(0, 10)
  }
  return streak
}

export const appTimezone = TZ
