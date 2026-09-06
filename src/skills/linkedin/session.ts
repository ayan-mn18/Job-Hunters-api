import { and, eq } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { portalAccounts } from '../../db/schema.js'
import { openSession, type AgentSession } from '../../browser/session.js'
import { LINKEDIN_PORTAL_ID, linkedinManifest } from './manifest.js'

/**
 * Opening the user's LinkedIn, as the user.
 *
 * This used to decrypt a Playwright `storageState` captured months earlier on
 * whatever machine had a screen attached, and replay it into a fresh local
 * browser. It worked until the cookies aged out, and it could not be renewed
 * without a person sitting in front of the host.
 *
 * Now the login lives in a hosted profile that refreshes itself every time it
 * is used, and reconnecting is a live URL we can send to the account's owner.
 *
 * Still its own module rather than a helper on the referral sync: outreach
 * *acts* as the user where the sync only reads, and keeping the two callers
 * apart makes it obvious which code paths can send something in someone's name.
 */

export class NoLinkedInSessionError extends Error {
  constructor() {
    super('No LinkedIn account is connected for this user.')
    this.name = 'NoLinkedInSessionError'
  }
}

export type LinkedInSession = AgentSession

export async function openLinkedInSession(userId: string): Promise<LinkedInSession> {
  const [account] = await db
    .select()
    .from(portalAccounts)
    .where(and(eq(portalAccounts.userId, userId), eq(portalAccounts.portalId, LINKEDIN_PORTAL_ID)))
    .limit(1)

  if (!account || account.status !== 'ready' || !account.browserProfileId) {
    throw new NoLinkedInSessionError()
  }

  return openSession({
    userId,
    label: 'linkedin',
    profileId: account.browserProfileId,
    proxyCountry: linkedinManifest.proxyCountry,
  })
}
