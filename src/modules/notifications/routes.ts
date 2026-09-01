import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { Router } from 'express'
import { z } from 'zod'
import { db } from '../../db/client.js'
import { notifications } from '../../db/schema.js'
import { asyncHandler, ok, pathParam } from '../../lib/http.js'
import { currentUser, requireAuth } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'

export const notificationsRouter: Router = Router()
notificationsRouter.use(requireAuth)

/** `now` first, then `soon`, then everything else. */
const URGENCY_ORDER = sql`case
  when ${notifications.urgency} = 'now' then 0
  when ${notifications.urgency} = 'soon' then 1
  else 2
end`

const listSchema = z.object({
  unreadOnly: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

/**
 * One feed, ordered by what needs a person today.
 *
 * Not chronological: a rejection that arrived an hour ago must not push an
 * interview invite from this morning below the fold. That ordering is the
 * whole reason this is one table rather than four screens.
 */
notificationsRouter.get(
  '/',
  validate({ query: listSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const query = req.query as { unreadOnly?: string; limit?: string }
    const limit = Number(query.limit ?? 50)

    const filters = [eq(notifications.userId, auth.id)]
    if (query.unreadOnly === 'true') filters.push(isNull(notifications.readAt))

    const rows = await db
      .select()
      .from(notifications)
      .where(and(...filters))
      .orderBy(URGENCY_ORDER, desc(notifications.createdAt))
      .limit(limit)

    const [unread] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, auth.id), isNull(notifications.readAt)))

    ok(res, {
      unread: unread?.value ?? 0,
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        urgency: row.urgency,
        title: row.title,
        body: row.body,
        link: row.link,
        applicationId: row.applicationId,
        readAt: row.readAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
    })
  }),
)

const idSchema = z.object({ id: z.string().uuid() })

notificationsRouter.post(
  '/:id/read',
  validate({ params: idSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const [row] = await db
      .update(notifications)
      .set({ readAt: new Date(), updatedAt: new Date() })
      .where(and(eq(notifications.id, pathParam(req, 'id')), eq(notifications.userId, auth.id)))
      .returning({ id: notifications.id })
    ok(res, { id: row?.id ?? null })
  }),
)

notificationsRouter.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const rows = await db
      .update(notifications)
      .set({ readAt: new Date(), updatedAt: new Date() })
      .where(and(eq(notifications.userId, auth.id), isNull(notifications.readAt)))
      .returning({ id: notifications.id })
    ok(res, { marked: rows.length })
  }),
)
