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
