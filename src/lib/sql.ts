import { sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import { env } from '../config/env.js'

/**
 * Day-bucketing helpers.
 *
 * Every screen that counts "today" — the Den's applied-today tile, the streak,
 * the referral day picker — has to agree on where a day starts, and that is
 * APP_TIMEZONE, not UTC.
 *
 * The timezone is embedded as a SQL *literal* rather than a bind parameter,
 * which looks wrong until you hit the bug it fixes: Postgres matches
 * `GROUP BY` expressions against the select list syntactically, and drizzle
 * numbers each occurrence of a parameter separately ($1 in the select, $3 in
 * the GROUP BY). Postgres cannot know those are equal, so it rejects the query
 * with "column must appear in the GROUP BY clause". A literal appears
 * identically in all three clauses and matches.
 *
 * Safety: APP_TIMEZONE is validated against `^[A-Za-z0-9_+\-/]+$` in
 * config/env.ts, so it cannot carry a quote or a semicolon. It is operator
 * configuration, never user input.
 */
const TZ_LITERAL = sql.raw(`'${env.APP_TIMEZONE}'`)

/** `(<column> at time zone 'TZ')::date` */
export function localDate(column: SQLWrapper): SQL {
  return sql`(${column} at time zone ${TZ_LITERAL})::date`
}

/** `to_char((<column> at time zone 'TZ')::date, 'YYYY-MM-DD')` */
export function localDateKey(column: SQLWrapper): SQL<string> {
  return sql<string>`to_char((${column} at time zone ${TZ_LITERAL})::date, 'YYYY-MM-DD')`
}

/** Today's date in the app timezone, evaluated by the database. */
export function todayLocal(): SQL {
  return sql`(now() at time zone ${TZ_LITERAL})::date`
}
