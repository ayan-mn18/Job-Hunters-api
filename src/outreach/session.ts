import { and, eq } from 'drizzle-orm'
import type { Browser, BrowserContext } from 'playwright-core'
import { db } from '../db/client.js'
import { portalAccounts } from '../db/schema.js'
import { decryptCredential } from '../lib/credential-vault.js'
import { launchAutomationBrowser } from '../hunt/browser.js'

/**
 * Opens the user's stored LinkedIn session for outreach.
 *
 * Deliberately its own small module rather than a helper exported from the
 * referral sync: outreach *acts* as the user where the sync only reads, and
 * keeping the two callers separate makes it obvious which code paths can send
 * something in someone's name.
 */

const PORTAL_ID = 'linkedin-referrals'

interface LinkedInSessionCredential {
  kind: 'linkedin-storage-state'
  profileUrl: string
  storageState: unknown
}

export interface OpenSession {
  browser: Browser
  context: BrowserContext
  close(): Promise<void>
}

export class NoLinkedInSessionError extends Error {
  constructor() {
    super('No LinkedIn session is connected for this account.')
    this.name = 'NoLinkedInSessionError'
  }
}

export async function openLinkedInSession(userId: string): Promise<OpenSession> {
  const [account] = await db
    .select()
    .from(portalAccounts)
    .where(and(eq(portalAccounts.userId, userId), eq(portalAccounts.portalId, PORTAL_ID)))
    .limit(1)

  if (!account || account.status !== 'ready' || !account.encryptedCredentials) {
    throw new NoLinkedInSessionError()
  }

  const credential = await decryptCredential<LinkedInSessionCredential>(
    userId,
    account.encryptedCredentials,
  )
  if (credential.kind !== 'linkedin-storage-state') throw new NoLinkedInSessionError()

  const browser = await launchAutomationBrowser()
  const context = await browser.newContext({
    storageState: credential.storageState as never,
  })

  return {
    browser,
    context,
    async close() {
      await context.close().catch(() => undefined)
      await browser.close().catch(() => undefined)
    },
  }
}
