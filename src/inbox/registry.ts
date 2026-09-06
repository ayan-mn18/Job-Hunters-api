import { eq } from 'drizzle-orm'
import { hasGmail } from '../config/env.js'
import { db } from '../db/client.js'
import { emailAccounts } from '../db/schema.js'
import { forwardingSource } from './forwarding.js'
import { gmailSource } from './gmail.js'
import type { InboxSource } from './source.js'

/**
 * Picks the mail source a user is actually connected through.
 *
 * Returns null rather than throwing when nobody is connected: the daily sweep
 * runs for every user with the schedule enabled, and most of them will not
 * have connected a mailbox.
 */
export async function sourceFor(userId: string): Promise<InboxSource | null> {
  const [account] = await db
    .select({ kind: emailAccounts.kind, status: emailAccounts.status })
    .from(emailAccounts)
    .where(eq(emailAccounts.userId, userId))
    .limit(1)

  if (!account || account.status !== 'ready') return null
  if (account.kind === 'gmail-oauth') return hasGmail ? gmailSource : null
  return forwardingSource
}
