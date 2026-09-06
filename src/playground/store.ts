import { and, asc, desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  playgroundMessages,
  playgroundRuns,
  type PlaygroundRun,
} from '../db/schema.js'
import { notFound } from '../lib/errors.js'
import { publishPlaygroundEvent, type PlaygroundEvent } from './events.js'

/**
 * Reading and writing a run, and telling anyone watching.
 *
 * Every state change goes through here so that the database and the live
 * socket cannot disagree. They did in the first version — the runner updated a
 * row and separately remembered to publish, and the two drifted the moment an
 * error path forgot the second half.
 */

export type Speaker = 'huntly' | 'agent' | 'llm' | 'user' | 'system'

export async function loadRun(runId: string, userId: string): Promise<PlaygroundRun> {
  const [run] = await db
    .select()
    .from(playgroundRuns)
    .where(and(eq(playgroundRuns.id, runId), eq(playgroundRuns.userId, userId)))
    .limit(1)
  if (!run) throw notFound('No such playground run.')
  return run
}

/** For the runner, which is acting on its own behalf and has no request user. */
export async function loadRunUnscoped(runId: string): Promise<PlaygroundRun | null> {
  const [run] = await db.select().from(playgroundRuns).where(eq(playgroundRuns.id, runId)).limit(1)
  return run ?? null
}

export async function listRuns(userId: string, limit = 10) {
  return db
    .select()
    .from(playgroundRuns)
    .where(eq(playgroundRuns.userId, userId))
    .orderBy(desc(playgroundRuns.createdAt))
    .limit(limit)
}

export async function listMessages(runId: string) {
  return db
    .select()
    .from(playgroundMessages)
    .where(eq(playgroundMessages.runId, runId))
    .orderBy(asc(playgroundMessages.createdAt))
}

type RunPatch = Partial<typeof playgroundRuns.$inferInsert>

/** Updates the row and publishes the change in one act. */
export async function setState(
  run: { id: string; userId: string },
  patch: RunPatch,
  detail: Record<string, unknown> | null = null,
): Promise<void> {
  await db
    .update(playgroundRuns)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(playgroundRuns.id, run.id))

  if (!patch.status) return
  publishPlaygroundEvent(run.userId, {
    type: 'state',
    runId: run.id,
    status: patch.status,
    detail,
    at: new Date().toISOString(),
  })
}

/**
 * Records something said, and sends it to whoever is watching.
 *
 * Persisted rather than only published because a run outlives a browser tab:
 * reopening one has to show what was already said, and a question asked while
 * nobody was looking still needs an answer.
 */
export async function say(
  run: { id: string; userId: string },
  speaker: Speaker,
  body: string,
  kind?: 'stuck' | 'refused' | 'success' | 'draft',
): Promise<void> {
  await db.insert(playgroundMessages).values({
    runId: run.id,
    speaker,
    body,
    kind: kind ?? null,
  })
  publishPlaygroundEvent(run.userId, {
    type: 'message',
    runId: run.id,
    speaker,
    body,
    kind: kind ?? null,
    at: new Date().toISOString(),
  })
}

/**
 * A step line, trimmed to something a person can read.
 *
 * Playwright's failures carry the whole element — every attribute, the action
 * it was attempting, the actionability checks it was waiting on. That is
 * exactly what you want in a log and exactly what you do not want dumped into
 * a conversation panel, where one of them buries everything said before it.
 * The full text is still in the runner's logs.
 */
function readable(result: string): string {
  const line = result.replace(/\s+/g, ' ').trim()
  return line.length > 180 ? `${line.slice(0, 177)}…` : line
}

/**
 * A step, published — and a heartbeat.
 *
 * Touching `updated_at` is what lets startup reconciliation tell a run whose
 * runner died from one that is alive and simply deep in a long agent phase.
 * Without it, a second runner booting reclaims the first one's work and stops
 * its browser mid-form. That happened.
 */
export function publishStep(
  run: { id: string; userId: string },
  step: { index: number; tool: string; result: string; ok: boolean },
): void {
  void db
    .update(playgroundRuns)
    .set({ updatedAt: new Date() })
    .where(eq(playgroundRuns.id, run.id))
    .catch(() => undefined)

  const event: PlaygroundEvent = {
    type: 'step',
    runId: run.id,
    index: step.index,
    tool: step.tool,
    result: readable(step.result),
    ok: step.ok,
  }
  publishPlaygroundEvent(run.userId, event)
}

/**
 * Runner lease heartbeat. A playground can legitimately wait fifteen minutes
 * for approval or ten minutes for an answer, so a timestamp written only when
 * a step is published is not enough to distinguish that from a dead runner.
 */
export function touchRun(runId: string): void {
  void db
    .update(playgroundRuns)
    .set({ updatedAt: new Date() })
    .where(eq(playgroundRuns.id, runId))
    .catch(() => undefined)
}
