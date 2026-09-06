import { eq } from 'drizzle-orm'
import { env } from '../config/env.js'
import { db } from '../db/client.js'
import { emailAccounts } from '../db/schema.js'
import { decryptCredential } from '../lib/credential-vault.js'
import { fetchJson, request } from '../hunt/discovery/fetcher.js'
import { logger } from '../lib/logger.js'
import type { InboxSource, RawEmail } from './source.js'

/**
 * Gmail, read through the API.
 *
 * `gmail.readonly` is a *restricted* scope. A published app using it must pass
 * a CASA security assessment, renewed annually, at real cost. Under the OAuth
 * consent screen's testing mode the same scope is free for up to 100 manually
 * added users — which is the right shape for this product today, and a wall it
 * will hit precisely when it starts working.
 *
 * The escape hatch is `forwarding.ts`, which needs no scope at all. This file
 * and that one are interchangeable behind `InboxSource` for exactly that
 * reason.
 */

interface StoredGmailCredential {
  kind: 'gmail-oauth'
  refreshToken: string
}

interface GmailListResponse {
  messages?: Array<{ id: string; threadId: string }>
  nextPageToken?: string
  historyId?: string
}

interface GmailHeader {
  name: string
  value: string
}

interface GmailMessage {
  id: string
  threadId: string
  snippet?: string
  internalDate?: string
  historyId?: string
  payload?: {
    headers?: GmailHeader[]
    parts?: Array<{ mimeType?: string; body?: { data?: string }; parts?: unknown }>
    body?: { data?: string }
    mimeType?: string
  }
}

/** Gmail returns base64url with no padding, and `atob` will not take it. */
function decodeBody(data: string | undefined): string {
  if (!data) return ''
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  } catch {
    return ''
  }
}

function headerValue(headers: GmailHeader[] | undefined, name: string): string {
  return headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

/** Walks the MIME tree for the first text part — Gmail nests these arbitrarily. */
function textFrom(payload: GmailMessage['payload']): string {
  if (!payload) return ''
  if (payload.mimeType?.startsWith('text/') && payload.body?.data) return decodeBody(payload.body.data)
  const parts = (payload.parts ?? []) as GmailMessage['payload'][]
  for (const part of parts) {
    const found = textFrom(part)
    if (found) return found
  }
  return decodeBody(payload.body?.data)
}

function parseAddress(raw: string): { address: string; name: string | null } {
  const angled = raw.match(/^(.*?)<([^>]+)>\s*$/)
  if (angled) {
    return { address: (angled[2] ?? '').trim().toLowerCase(), name: (angled[1] ?? '').trim().replace(/^"|"$/g, '') || null }
  }
  return { address: raw.trim().toLowerCase(), name: null }
}

async function accessTokenFor(userId: string): Promise<string> {
  const [account] = await db
    .select()
    .from(emailAccounts)
    .where(eq(emailAccounts.userId, userId))
    .limit(1)
  if (!account?.encryptedCredentials) throw new Error('No Gmail credentials stored.')
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required for Gmail.')
  }

  const credential = await decryptCredential<StoredGmailCredential>(
    userId,
    account.encryptedCredentials,
  )

  const response = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    skipRobots: true,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: credential.refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  })
  const body = (await response.json()) as { access_token?: string }
  if (!body.access_token) throw new Error('Google did not return an access token.')
  return body.access_token
}

/** Newer than this and we would re-read the whole mailbox on first connect. */
const FIRST_SWEEP_DAYS = 14
const MAX_MESSAGES = 120

export const gmailSource: InboxSource = {
  kind: 'gmail-oauth',

  async poll(userId, cursor) {
    const token = await accessTokenFor(userId)
    const auth = { authorization: `Bearer ${token}` }

    // Gmail's search is the cheapest filter available and it runs on their
    // side: asking for everything and filtering here would burn quota on a
    // mailbox full of newsletters.
    const query = cursor
      ? `after:${Math.floor(Number(cursor) / 1000)}`
      : `newer_than:${FIRST_SWEEP_DAYS}d`

    const list = await fetchJson<GmailListResponse>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${MAX_MESSAGES}&q=${encodeURIComponent(query)}`,
      { skipRobots: true, headers: auth, timeoutMs: 20_000 },
    )

    const ids = (list.messages ?? []).map((message) => message.id)
    const messages: RawEmail[] = []
    let newest = cursor ? Number(cursor) : 0

    for (const id of ids) {
      try {
        const full = await fetchJson<GmailMessage>(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
          { skipRobots: true, headers: auth, timeoutMs: 20_000 },
        )
        const headers = full.payload?.headers
        const from = parseAddress(headerValue(headers, 'From'))
        const receivedMs = Number(full.internalDate ?? 0)
        if (receivedMs > newest) newest = receivedMs

        messages.push({
          externalId: full.id,
          threadId: full.threadId ?? null,
          fromAddress: from.address,
          fromName: from.name,
          subject: headerValue(headers, 'Subject'),
          snippet: full.snippet ?? '',
          body: textFrom(full.payload).slice(0, 20_000),
          receivedAt: new Date(receivedMs || Date.now()),
        })
      } catch (error) {
        logger.debug({ err: error, id }, 'could not read a Gmail message')
      }
    }

    // The cursor is the newest message's timestamp rather than Gmail's
    // historyId: a timestamp survives a gap longer than Gmail keeps history
    // for, where a stale historyId returns a 404 and loses the mailbox.
    return { messages, cursor: newest > 0 ? String(newest) : cursor }
  },
}
