import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { portalAccounts } from '../db/schema.js'
import { badRequest, notFound } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { createProfile, getBrowser, getProfile, stopBrowser } from './client.js'
import { openSession } from './session.js'

/**
 * Logins that survive between runs.
 *
 * The old shape was a Playwright `storageState` encrypted into
 * `portal_accounts.encrypted_credentials`, captured once from a browser
 * somebody had to open on a machine with a screen. It went stale, it could not
 * be refreshed without repeating the whole ceremony, and it made connecting an
 * account impossible on a deployed host.
 *
 * A hosted profile inverts that. The cookies live beside the browser that will
 * use them and are updated every time it runs, and signing in is a URL we can
 * hand to the person whose account it is. Nothing here ever sees a password.
 */

export interface LoginHandoff {
  /** Open this. It is a real browser, and the user drives it. */
  liveUrl: string
  /** Give this back to `completeInteractiveLogin` when they are done. */
  sessionId: string
  /** After this, the session stops itself and the login must be restarted. */
  expiresAt: string
}

async function accountRow(userId: string, portalId: string) {
  const [row] = await db
    .select()
    .from(portalAccounts)
    .where(and(eq(portalAccounts.userId, userId), eq(portalAccounts.portalId, portalId)))
    .limit(1)
  return row ?? null
}

/**
 * The profile id for this user and portal, creating one if it does not exist.
 *
 * A profile is cheap and empty until someone logs in, so creating it eagerly
 * costs nothing and means the id is stable from the first run onwards.
 */
export async function ensureProfile(params: {
  userId: string
  portalId: string
  email: string
}): Promise<string> {
  const existing = await accountRow(params.userId, params.portalId)
  if (existing?.browserProfileId) return existing.browserProfileId

  const profile = await createProfile({
    name: `${params.portalId}:${params.userId}`,
    userId: params.userId,
  })

  const [row] = await db
    .insert(portalAccounts)
    .values({
      userId: params.userId,
      portalId: params.portalId,
      email: params.email,
      browserProfileId: profile.id,
      status: 'absent',
    })
    .onConflictDoUpdate({
      target: [portalAccounts.userId, portalAccounts.portalId],
      set: { browserProfileId: profile.id, updatedAt: new Date() },
    })
    .returning()

  if (!row) throw new Error('Could not store the browser profile')
  return profile.id
}

/** The profile to run with, or null when this portal has never been connected. */
export async function profileFor(userId: string, portalId: string): Promise<string | null> {
  const row = await accountRow(userId, portalId)
  return row?.browserProfileId ?? null
}

/**
 * Opens a browser on the user's profile and hands them the keys.
 *
 * We navigate to the sign-in page and then disconnect: the session keeps
 * running without us, and the person signs in themselves through `liveUrl`.
 * That is the whole point — a password, a one-time code and a CAPTCHA are all
 * things this product should never be holding.
 */
export async function beginInteractiveLogin(params: {
  userId: string
  portalId: string
  email: string
  loginUrl: string
  /** Sites that fingerprint hard want a residential exit; most do not. */
  proxyCountry?: string | null
  /** Long enough for a code from a phone, short enough to not bill all day. */
  minutes?: number
}): Promise<LoginHandoff> {
  const profileId = await ensureProfile(params)

  const session = await openSession({
    userId: params.userId,
    label: `login:${params.portalId}`,
    profileId,
    proxyCountry: params.proxyCountry ?? null,
    timeoutMinutes: params.minutes ?? 20,
  })

  if (!session.liveUrl || !session.sessionId) {
    await session.close()
    throw badRequest(
      'Interactive sign-in needs a hosted browser. Set BROWSER_PROVIDER=browser-use and a Browser Use key.',
    )
  }

  const { liveUrl, sessionId } = session
  try {
    await session.page.goto(params.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  } catch (error) {
    logger.debug({ err: error, portalId: params.portalId }, 'login page did not settle; handing it over anyway')
  }

  // Drop our CDP connection but leave the session running. `browser.close()`
  // does not stop a hosted session, which is usually a hazard and is exactly
  // what we want here.
  await session.browser.close().catch(() => undefined)

  await db
    .update(portalAccounts)
    .set({ status: 'provisioning', actionRequired: 'Sign in through the live browser window.', updatedAt: new Date() })
    .where(and(eq(portalAccounts.userId, params.userId), eq(portalAccounts.portalId, params.portalId)))

  const info = await getBrowser(sessionId).catch(() => null)
  return {
    liveUrl,
    sessionId,
    expiresAt: info?.timeoutAt ?? new Date(Date.now() + (params.minutes ?? 20) * 60_000).toISOString(),
  }
}

/**
 * Ends an interactive sign-in and records whether it took.
 *
 * Stopping the session is what writes its cookies back to the profile, so this
 * has to run even when the user gave up — otherwise the browser bills until
 * its timeout. Success is judged by the profile's own cookie domains rather
 * than by anything the page said, because a page can look signed in while the
 * session cookie went nowhere.
 */
export async function completeInteractiveLogin(params: {
  userId: string
  portalId: string
  sessionId: string
  /** A domain that must appear in the profile's cookies, e.g. `.linkedin.com`. */
  expectCookieDomain?: string
}): Promise<{ connected: boolean; cookieDomains: string[] }> {
  const row = await accountRow(params.userId, params.portalId)
  if (!row?.browserProfileId) throw notFound('No browser profile for this portal.')

  // The session carries our user id in its metadata; without this check a
  // caller could stop somebody else's browser by guessing an id.
  const info = await getBrowser(params.sessionId).catch(() => null)
  if (info && info.metadata?.userId && info.metadata.userId !== params.userId) {
    throw notFound('No such sign-in session.')
  }

  await stopBrowser(params.sessionId).catch((error: unknown) => {
    logger.error({ err: error, sessionId: params.sessionId }, 'sign-in session did not stop')
  })

  const profile = await getProfile(row.browserProfileId).catch(() => null)
  const cookieDomains = profile?.cookieDomains ?? []
  const connected = params.expectCookieDomain
    ? cookieDomains.some((domain) => domain.endsWith(params.expectCookieDomain as string))
    : cookieDomains.length > 0

  await db
    .update(portalAccounts)
    .set({
      status: connected ? 'ready' : 'failed',
      actionRequired: connected ? null : 'Sign-in did not complete. Try connecting again.',
      lastVerifiedAt: connected ? new Date() : null,
      profileSyncedAt: connected ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(and(eq(portalAccounts.userId, params.userId), eq(portalAccounts.portalId, params.portalId)))

  return { connected, cookieDomains }
}
