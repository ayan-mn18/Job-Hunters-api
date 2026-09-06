import { Router } from 'express'
import { z } from 'zod'
import { ok } from '../../lib/http.js'
import { currentUser, requireAuth } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import {
  listPortalAccounts,
  provisionPortalAccount,
  saveExistingPortalAccount,
  syncPortalProfile,
} from '../../hunt/portal-accounts.js'
import { asyncHandler } from '../../lib/http.js'
import { beginInteractiveLogin, completeInteractiveLogin } from '../../browser/profiles.js'
import { loadPortalProfile } from '../../hunt/portal-profile.js'
import { skillById } from '../../skills/registry.js'
import { badRequest } from '../../lib/errors.js'
import { LINKEDIN_PORTAL_ID } from '../../skills/linkedin/manifest.js'

export const portalAccountsRouter: Router = Router()
portalAccountsRouter.use(requireAuth)

const portalSchema = z.object({ portal: z.string().trim().min(1).max(60) })
const credentialSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(500),
})

function accountDto(account: {
  id: string
  portalId: string
  email: string
  status: string
  actionRequired: string | null
  lastVerifiedAt: Date | null
  profileSyncedAt: Date | null
}) {
  return {
    id: account.id,
    portalId: account.portalId,
    email: account.email,
    status: account.status,
    actionRequired: account.actionRequired,
    lastVerifiedAt: account.lastVerifiedAt?.toISOString() ?? null,
    profileSyncedAt: account.profileSyncedAt?.toISOString() ?? null,
  }
}

portalAccountsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    ok(res, await listPortalAccounts(currentUser(req).id))
  }),
)

portalAccountsRouter.post(
  '/:portal/provision',
  validate({ params: portalSchema }),
  asyncHandler(async (req, res) => {
    const account = await provisionPortalAccount(currentUser(req).id, String(req.params.portal))
    ok(res, accountDto(account))
  }),
)

portalAccountsRouter.put(
  '/:portal/credentials',
  validate({ params: portalSchema, body: credentialSchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof credentialSchema>
    const account = await saveExistingPortalAccount(
      currentUser(req).id,
      String(req.params.portal),
      body.email,
      body.password,
    )
    ok(res, accountDto(account))
  }),
)

portalAccountsRouter.post(
  '/:portal/sync',
  validate({ params: portalSchema }),
  asyncHandler(async (req, res) => {
    const account = await syncPortalProfile(currentUser(req).id, String(req.params.portal))
    ok(res, accountDto(account))
  }),
)

/**
 * Connecting an account, without a screen.
 *
 * This is the flow that could not exist before. Signing in used to mean
 * opening a real Chromium window on the host, which is impossible anywhere the
 * product is actually deployed — `AUTOMATION_HEADFUL` was a note admitting as
 * much. A hosted browser publishes a live URL instead: the API opens the
 * session, the UI puts it in an iframe, and the person signs in themselves.
 *
 * Nothing here ever handles a password, a one-time code or a CAPTCHA. The
 * cookies land in the profile, not in this database.
 */

/** Portal ids the UI uses do not all match skill ids; this is the only gap. */
function skillIdFor(portal: string): string {
  return portal === LINKEDIN_PORTAL_ID ? 'linkedin' : portal
}

portalAccountsRouter.post(
  '/:portal/connect',
  validate({ params: portalSchema }),
  asyncHandler(async (req, res) => {
    const portal = String(req.params.portal)
    const skill = skillById(skillIdFor(portal))
    if (!skill || skill.manifest.authMode !== 'profile' || !skill.manifest.loginUrl) {
      throw badRequest('This portal does not use an interactive sign-in.')
    }

    const user = currentUser(req)
    const profile = await loadPortalProfile(user.id)
    const handoff = await beginInteractiveLogin({
      userId: user.id,
      portalId: portal,
      email: profile.email,
      loginUrl: skill.manifest.loginUrl,
      proxyCountry: skill.manifest.proxyCountry,
    })

    ok(res, { portalId: portal, ...handoff })
  }),
)

const finishSchema = z.object({ sessionId: z.string().trim().min(1).max(100) })

portalAccountsRouter.post(
  '/:portal/connect/finish',
  validate({ params: portalSchema, body: finishSchema }),
  asyncHandler(async (req, res) => {
    const portal = String(req.params.portal)
    const skill = skillById(skillIdFor(portal))
    const body = req.body as z.infer<typeof finishSchema>

    const result = await completeInteractiveLogin({
      userId: currentUser(req).id,
      portalId: portal,
      sessionId: body.sessionId,
      ...(skill?.manifest.loginCookieDomain
        ? { expectCookieDomain: skill.manifest.loginCookieDomain }
        : {}),
    })

    ok(res, { portalId: portal, connected: result.connected })
  }),
)
