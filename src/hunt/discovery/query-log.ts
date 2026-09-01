import { db } from '../../db/client.js'
import { searchQueries } from '../../db/schema.js'
import { logger } from '../../lib/logger.js'

/**
 * Records one issued search.
 *
 * The point is answerability. "Why didn't I see the job at X?" has, until now,
 * had no answer better than a shrug: the user's roles went in, some jobs came
 * out, and nothing connected the two. With these rows the answer is one query
 * away — the search either was not issued, was issued and returned nothing, or
 * returned it and the scorer rejected it. Those are three different problems.
 *
 * Failures here never fail a run. A missing audit row is a worse outcome than
 * no audit row, but both are better than losing the scrape.
 */
export async function recordSearchQuery(entry: {
  runId: string | undefined
  connectorId: string
  query: string
  market: string | null
  resultCount: number
  durationMs: number
  error?: string | null
}): Promise<void> {
  if (!entry.runId) return
  try {
    await db.insert(searchQueries).values({
      runId: entry.runId,
      connectorId: entry.connectorId,
      query: entry.query,
      market: entry.market,
      resultCount: entry.resultCount,
      durationMs: entry.durationMs,
      error: entry.error ?? null,
    })
  } catch (error) {
    logger.debug({ err: error, connector: entry.connectorId }, 'could not record a search query')
  }
}
