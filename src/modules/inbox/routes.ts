import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { Router } from 'express'
import { z } from 'zod'
import { env, hasGmail } from '../../config/env.js'
import { db } from '../../db/client.js'
import { emailAccounts, userSchedules } from '../../db/schema.js'
import { badRequest, serviceUnavailable } from '../../lib/errors.js'
import { asyncHandler, ok } from '../../lib/http.js'
import { decryptCredential, encryptCredential } from '../../lib/credential-vault.js'
import { request } from '../../hunt/discovery/fetcher.js'
import { currentUser, requireAuth } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'

export const inboxRouter: Router = Router()
inboxRouter.use(requireAuth)

/**
 * Gmail connection.
 *
 * Read-only scope, and it says so on the consent screen. The product never
 * asks for send access: nothing here writes mail on the user's behalf, and
 * requesting a permission you do not use is how you lose the trust that made
 * someone connect their inbox in the first place.
 */
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']

function gmailRedirect(): string | undefined {
  return env.GOOGLE_GMAIL_REDIRECT ?? env.GOOGLE_OAUTH_REDIRECT
}

/** Short-lived, single-use, and bound to the user who started the flow. */
const pendingStates = new Map<string, { userId: string; at: number }>()

function sweepStates(): void {
  const cutoff = Date.now() - 10 * 60_000
  for (const [state, entry] of pendingStates) {
    if (entry.at < cutoff) pendingStates.delete(state)
  }
}

inboxRouter.get(
  '/status',
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const [account] = await db
      .select()
      .from(emailAccounts)
      .where(eq(emailAccounts.userId, auth.id))
      .limit(1)
    const [schedule] = await db
      .select({ enabled: userSchedules.inboxEnabled })
      .from(userSchedules)
      .where(eq(userSchedules.userId, auth.id))
      .limit(1)

    ok(res, {
      connected: account?.status === 'ready',
      kind: account?.kind ?? null,
      address: account?.address ?? null,
      lastPolledAt: account?.lastPolledAt?.toISOString() ?? null,
      dailySweep: schedule?.enabled ?? false,
      available: hasGmail,
      // Said out loud rather than discovered at launch.
      note: hasGmail
        ? 'Read-only access. Huntly never sends mail as you.'
        : 'Gmail is not configured on this deployment. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
    })
  }),
)

inboxRouter.post(
  '/gmail/connect',
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    if (!hasGmail || !env.GOOGLE_CLIENT_ID || !gmailRedirect()) {
      throw serviceUnavailable(
        'Gmail is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_OAUTH_REDIRECT.',
      )
    }

    sweepStates()
    const state = crypto.randomBytes(24).toString('base64url')
    pendingStates.set(state, { userId: auth.id, at: Date.now() })

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID)
    url.searchParams.set('redirect_uri', gmailRedirect()!)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', SCOPES.join(' '))
    // Without both of these Google returns no refresh token on a repeat
    // consent, and the connection silently stops working in an hour.
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')
    url.searchParams.set('state', state)

    ok(res, { authorizeUrl: url.toString() })
  }),
)

inboxRouter.post(
  '/gmail/callback',
  validate({ body: z.object({ code: z.string().min(1), state: z.string().min(1) }) }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const { code, state } = req.body as { code: string; state: string }

    const pending = pendingStates.get(state)
    pendingStates.delete(state)
    if (!pending || pending.userId !== auth.id) {
      throw badRequest('That sign-in link has expired. Start again from Notifications.')
    }
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !gmailRedirect()) {
      throw serviceUnavailable('Gmail is not configured.')
    }

    let tokenResponse: Response
    try {
      tokenResponse = await request('https://oauth2.googleapis.com/token', {
        method: 'POST',
        skipRobots: true,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: gmailRedirect()!,
          grant_type: 'authorization_code',
          code,
        }).toString(),
      })
    } catch {
      throw badRequest('Google rejected the Gmail connection. Check the OAuth redirect URI and try again.')
    }
    const tokens = (await tokenResponse.json()) as {
      refresh_token?: string
      access_token?: string
    }
    if (!tokens.access_token) {
      throw badRequest('Google did not return an access token for Gmail.')
    }

    // Google may omit refresh_token when the user already granted this client
    // access. Reuse the encrypted credential on a reconnect instead of
    // discarding a working mailbox connection.
    const [existingAccount] = await db
      .select({ encryptedCredentials: emailAccounts.encryptedCredentials })
      .from(emailAccounts)
      .where(eq(emailAccounts.userId, auth.id))
      .limit(1)
    let refreshToken = tokens.refresh_token
    if (!refreshToken && existingAccount?.encryptedCredentials) {
      try {
        refreshToken = (
          await decryptCredential<{ refreshToken?: string }>(auth.id, existingAccount.encryptedCredentials)
        ).refreshToken
      } catch {
        refreshToken = undefined
      }
    }
    if (!refreshToken) {
      throw badRequest(
        'Google did not return a refresh token. Remove Huntly from your Google account permissions and connect again.',
      )
    }

    let profileResponse: Response
    try {
      profileResponse = await request('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        skipRobots: true,
        headers: { authorization: `Bearer ${tokens.access_token}` },
      })
    } catch {
      throw badRequest('Google did not return a Gmail profile for this account.')
    }
    const profile = (await profileResponse.json()) as { emailAddress?: string }

    const encryptedCredentials = await encryptCredential(auth.id, {
      kind: 'gmail-oauth',
      refreshToken,
    })

    await db
      .insert(emailAccounts)
      .values({
        userId: auth.id,
        kind: 'gmail-oauth',
        address: profile.emailAddress ?? auth.email,
        encryptedCredentials,
        status: 'ready',
      })
      .onConflictDoUpdate({
        target: emailAccounts.userId,
        set: {
          kind: 'gmail-oauth',
          address: profile.emailAddress ?? auth.email,
          encryptedCredentials,
          status: 'ready',
          // A reconnect re-reads recent mail rather than resuming from a
          // cursor that may predate the mailbox we now have access to.
          cursor: null,
          updatedAt: new Date(),
        },
      })

    // Connecting a mailbox is the act of asking to be told about replies.
    await db
      .insert(userSchedules)
      .values({ userId: auth.id, inboxEnabled: true })
      .onConflictDoUpdate({
        target: userSchedules.userId,
        set: { inboxEnabled: true, updatedAt: new Date() },
      })

    ok(res, { connected: true, address: profile.emailAddress ?? auth.email })
  }),
)

inboxRouter.delete(
  '/gmail',
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    await db.delete(emailAccounts).where(eq(emailAccounts.userId, auth.id))
    await db
      .update(userSchedules)
      .set({ inboxEnabled: false, updatedAt: new Date() })
      .where(eq(userSchedules.userId, auth.id))
    ok(res, { connected: false })
  }),
)
