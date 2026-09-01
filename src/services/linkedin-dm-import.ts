import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  linkedinConversations,
  linkedinMessages,
  referrals as referralsTable,
} from '../db/schema.js'
import {
  extractReferrals,
  parseLinkedInMessageDate,
  persistExtractedLinkedInReferral,
  type ExtractedReferral,
  type RawLinkedInMessage,
} from './linkedin-referrals.js'

interface ExportMessage {
  id?: unknown
  body?: unknown
  senderName?: unknown
  senderProfileUrl?: unknown
  timestamp?: unknown
  timestampRaw?: unknown
  outbound?: unknown
  links?: unknown
}

interface ExportConversation {
  id?: unknown
  url?: unknown
  title?: unknown
  scrapedAt?: unknown
  messages?: unknown
}

interface ParsedConversation {
  externalId: string
  url: string
  title: string
  scrapedAt: Date
  messages: RawLinkedInMessage[]
}

export interface LinkedInDmImportAudit {
  conversations: number
  messages: number
  inboundMessages: number
  referralRequests: number
  withTargetRole: number
  withJobId: number
  withResume: number
}

function linksOf(value: unknown): RawLinkedInMessage['links'] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const link = entry as Record<string, unknown>
    if (typeof link.href !== 'string' || link.href.length === 0) return []
    return [{
      href: link.href,
      text: typeof link.text === 'string' ? link.text : '',
      download: typeof link.download === 'string' ? link.download : null,
    }]
  })
}

function messagesOf(conversation: ExportConversation): RawLinkedInMessage[] {
  if (!Array.isArray(conversation.messages)) return []
  const fallbackName = typeof conversation.title === 'string' ? conversation.title : 'LinkedIn member'
  return conversation.messages.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const message = entry as ExportMessage
    if (typeof message.body !== 'string' || message.body.trim().length === 0) return []
    const timestamp = typeof message.timestamp === 'string'
      ? message.timestamp
      : typeof message.timestampRaw === 'string'
        ? message.timestampRaw
        : ''
    if (!timestamp || !parseLinkedInMessageDate(timestamp)) return []
    const body = message.body.trim()
    const senderName = typeof message.senderName === 'string' && message.senderName.trim()
      ? message.senderName.trim()
      : fallbackName
    const id = typeof message.id === 'string' && message.id
      ? message.id
      : crypto.createHash('sha256').update(`${senderName}\n${timestamp}\n${body}`).digest('hex')
    return [{
      id,
      body,
      senderName,
      senderProfileUrl: typeof message.senderProfileUrl === 'string' ? message.senderProfileUrl : null,
      timestamp,
      outbound: message.outbound === true,
      links: linksOf(message.links),
    }]
  })
}

async function readConversations(filePath: string): Promise<ParsedConversation[]> {
  const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { conversations?: unknown }
  if (!Array.isArray(parsed.conversations)) throw new Error('LinkedIn export has no conversations array.')
  return parsed.conversations.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const conversation = entry as ExportConversation
    const title = typeof conversation.title === 'string' && conversation.title.trim()
      ? conversation.title.trim()
      : 'LinkedIn conversation'
    const url = typeof conversation.url === 'string' ? conversation.url : ''
    const externalId = typeof conversation.id === 'string' && conversation.id
      ? conversation.id
      : crypto.createHash('sha256').update(`${url}\n${title}`).digest('hex')
    const scrapedAt = typeof conversation.scrapedAt === 'string'
      ? new Date(conversation.scrapedAt)
      : new Date()
    return [{
      externalId,
      url,
      title,
      scrapedAt: Number.isNaN(scrapedAt.getTime()) ? new Date() : scrapedAt,
      messages: messagesOf(conversation),
    }]
  })
}

export async function auditLinkedInDmExport(filePath: string): Promise<{
  audit: LinkedInDmImportAudit
  referrals: ExtractedReferral[]
  conversations: ParsedConversation[]
}> {
  const conversations = await readConversations(filePath)
  const allMessages = conversations.flatMap((conversation) => conversation.messages)
  const referrals = conversations.flatMap((conversation) =>
    extractReferrals(conversation.messages, new Date(0)),
  )
  const unique = new Map(referrals.map((referral) => [referral.externalMessageId, referral]))
  const values = [...unique.values()]
  return {
    audit: {
      conversations: conversations.length,
      messages: allMessages.length,
      inboundMessages: allMessages.filter((message) => !message.outbound).length,
      referralRequests: values.length,
      withTargetRole: values.filter((referral) => referral.targetRole).length,
      withJobId: values.filter((referral) => referral.jobRequisitionId).length,
      withResume: values.filter((referral) => referral.resumeName || referral.resumeUrl).length,
    },
    referrals: values,
    conversations,
  }
}

async function persistConversations(userId: string, conversations: ParsedConversation[]): Promise<void> {
  for (const conversation of conversations) {
    const [storedConversation] = await db
      .insert(linkedinConversations)
      .values({
        userId,
        externalConversationId: conversation.externalId,
        threadUrl: conversation.url,
        title: conversation.title,
        scrapedAt: conversation.scrapedAt,
      })
      .onConflictDoUpdate({
        target: [linkedinConversations.userId, linkedinConversations.externalConversationId],
        set: {
          threadUrl: conversation.url,
          title: conversation.title,
          scrapedAt: conversation.scrapedAt,
          updatedAt: new Date(),
        },
      })
      .returning()
    if (!storedConversation) throw new Error('Could not store LinkedIn conversation.')

    for (const message of conversation.messages) {
      const sentAt = parseLinkedInMessageDate(message.timestamp)
      if (!sentAt) continue
      await db
        .insert(linkedinMessages)
        .values({
          userId,
          conversationId: storedConversation.id,
          externalMessageId: message.id,
          body: message.body,
          senderName: message.senderName,
          senderProfileUrl: message.senderProfileUrl,
          sentAt,
          timestampRaw: message.timestamp,
          outbound: message.outbound,
          links: message.links,
        })
        .onConflictDoUpdate({
          target: [linkedinMessages.userId, linkedinMessages.externalMessageId],
          set: {
            conversationId: storedConversation.id,
            body: message.body,
            senderName: message.senderName,
            senderProfileUrl: message.senderProfileUrl,
            sentAt,
            timestampRaw: message.timestamp,
            outbound: message.outbound,
            links: message.links,
            updatedAt: new Date(),
          },
        })
    }
  }
}

export async function importLinkedInDmExport(input: {
  filePath: string
  userId: string
  referrerName: string
  dryRun?: boolean
}) {
  const { audit, referrals, conversations } = await auditLinkedInDmExport(input.filePath)
  let imported = 0
  let duplicates = 0
  if (!input.dryRun) {
    await persistConversations(input.userId, conversations)
    for (const referral of referrals) {
      const result = await persistExtractedLinkedInReferral(null, input.userId, input.referrerName, referral)
      if (result === 'inserted') imported += 1
      else duplicates += 1
    }
  }

  const referralRows = referrals.length > 0
    ? await db
        .select({ id: referralsTable.id })
        .from(referralsTable)
        .where(and(
          eq(referralsTable.userId, input.userId),
          eq(referralsTable.source, 'linkedin'),
          inArray(referralsTable.externalMessageId, referrals.map((referral) => referral.externalMessageId)),
        ))
    : []
  const messageIds = conversations.flatMap((conversation) =>
    conversation.messages.map((message) => message.id),
  )
  const messageRows = messageIds.length > 0
    ? await db
        .select({ id: linkedinMessages.id })
        .from(linkedinMessages)
        .where(and(
          eq(linkedinMessages.userId, input.userId),
          inArray(linkedinMessages.externalMessageId, messageIds),
        ))
    : []

  return {
    ...audit,
    imported,
    duplicates,
    storedReferrals: referralRows.length,
    storedMessages: messageRows.length,
    dryRun: input.dryRun === true,
  }
}
