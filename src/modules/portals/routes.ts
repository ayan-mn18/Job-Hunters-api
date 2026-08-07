import { and, asc, eq } from 'drizzle-orm'
import { Router } from 'express'
import { z } from 'zod'
import { db } from '../../db/client.js'
import { portals, userPortals } from '../../db/schema.js'
import { notFound } from '../../lib/errors.js'
import { asyncHandler, ok, pathParam } from '../../lib/http.js'
import { currentUser, requireAuth } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { recordActivity } from '../../services/activity.js'

export const portalsRouter: Router = Router()
portalsRouter.use(requireAuth)

const portalIdParamSchema = z.object({ id: z.string().trim().min(1).max(60) })

const connectSchema = z.object({ connected: z.boolean() })

/** Mirrors the `Portal` type in the UI's mock data. */
interface PortalDto {
  id: string
  name: string
  emoji: string
  connected: boolean
  jobsFound: number
  isAvailable: boolean
  connectedAt: string | null
  lastSyncedAt: string | null
}

/**
 * Left join, not inner: a user who has never touched a portal still needs to
 * see it in the list as disconnected, and creating a `user_portals` row per
 * user per portal at signup would just be a table full of `false`.
 */
async function listPortals(userId: string): Promise<PortalDto[]> {
  const rows = await db
    .select({
      id: portals.id,
      name: portals.name,
      emoji: portals.emoji,
      isAvailable: portals.isAvailable,
      sortOrder: portals.sortOrder,
      connected: userPortals.connected,
      jobsFound: userPortals.jobsFound,
      connectedAt: userPortals.connectedAt,
      lastSyncedAt: userPortals.lastSyncedAt,
    })
    .from(portals)
    .leftJoin(
      userPortals,
      and(eq(userPortals.portalId, portals.id), eq(userPortals.userId, userId)),
    )
    .where(eq(portals.isAvailable, true))
    .orderBy(asc(portals.sortOrder), asc(portals.name))

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    connected: row.connected ?? false,
    jobsFound: row.jobsFound ?? 0,
    isAvailable: row.isAvailable,
    connectedAt: row.connectedAt?.toISOString() ?? null,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
  }))
}

portalsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const list = await listPortals(auth.id)
    ok(res, list, {
      connected: list.filter((portal) => portal.connected).length,
      totalJobsFound: list
        .filter((portal) => portal.connected)
        .reduce((sum, portal) => sum + portal.jobsFound, 0),
    })
  }),
)

/**
 * Connect / disconnect.
 *
 * NOTE: this only records intent. Actually holding a portal session —
 * cookies, credentials, 2FA — is the scraping workstream's problem and
 * deliberately not modelled here. Nothing secret is written by this endpoint.
 * TODO(scraper-workstream): once the credential vault exists, this should also
 * kick off the "verify the session still works" check.
 */
portalsRouter.put(
  '/:id',
  validate({ params: portalIdParamSchema, body: connectSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const portalId = pathParam(req, 'id')
    const { connected } = req.body

    const [portal] = await db.select().from(portals).where(eq(portals.id, portalId)).limit(1)
    if (!portal) throw notFound(`No portal called "${portalId}".`)
    if (!portal.isAvailable) throw notFound(`Portal "${portalId}" is not supported.`)

    const now = new Date()
    await db
      .insert(userPortals)
      .values({
        userId: auth.id,
        portalId,
        connected,
        connectedAt: connected ? now : null,
      })
      .onConflictDoUpdate({
        target: [userPortals.userId, userPortals.portalId],
        set: { connected, connectedAt: connected ? now : null, updatedAt: now },
      })

    await recordActivity({
      userId: auth.id,
      kind: connected ? 'portal_connected' : 'portal_disconnected',
      text: connected ? `Connected ${portal.name}` : `Disconnected ${portal.name}`,
      meta: { portalId },
    })

    const list = await listPortals(auth.id)
    const updated = list.find((row) => row.id === portalId)
    ok(res, updated)
  }),
)
