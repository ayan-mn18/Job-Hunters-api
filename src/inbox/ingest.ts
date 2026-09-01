import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { applications, emailAccounts, emailMessages, notifications } from '../db/schema.js'
import { logger } from '../lib/logger.js'
import { classifyEmail, mightBeJobMail, URGENCY_FOR, type EmailClass } from './classify.js'
import { matchEmail, type MatchableApplication } from './match.js'
import type { InboxSource, RawEmail } from './source.js'

/**
 * One sweep of a user's inbox.
 *
 * The shape is deliberately: fetch a delta, drop what is obviously not job
 * mail, classify the rest, match it to an application, then write a
 * notification only for the things a person would want to be told about.
 *
 * The cheap regex prefilter before the model matters more than it looks. A
 * mailbox is mostly newsletters, and paying to have a model read every one of
 * them would make the daily sweep the most expensive thing in the product.
 */

/** Notifications worth interrupting someone for. */
const ANNOUNCED: EmailClass[] = ['interview_invite', 'assessment', 'recruiter_outreach']

/**
 * Mail classes to notification kinds.
 *
 * The feed has one vocabulary and the classifier has another; without this the
 * same event arrives under two names depending on which wrote it, and the UI
 * quietly falls back to a bullet point for half of them.
 */
const NOTIFICATION_KIND: Partial<Record<EmailClass, string>> = {
  interview_invite: 'interview',
  assessment: 'assessment',
  recruiter_outreach: 'recruiter',
}

function linksIn(body: string): string[] {
  return [...body.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((match) => match[0]).slice(0, 40)
}

export interface SweepResult {
  fetched: number
  relevant: number
  classified: number
  matched: number
  announced: number
}

export async function sweepInbox(userId: string, source: InboxSource): Promise<SweepResult> {
  const [account] = await db
    .select()
    .from(emailAccounts)
    .where(eq(emailAccounts.userId, userId))
    .limit(1)
  if (!account || account.status !== 'ready') {
    return { fetched: 0, relevant: 0, classified: 0, matched: 0, announced: 0 }
  }

  const { messages, cursor } = await source.poll(userId, account.cursor)
  const result: SweepResult = {
    fetched: messages.length,
    relevant: 0,
    classified: 0,
    matched: 0,
    announced: 0,
  }

  // Loaded once. A mailbox sweep can touch a hundred messages and every one of
  // them wants to be matched against the same application list.
  const openApplications: MatchableApplication[] = (
    await db
      .select({
        id: applications.id,
        company: applications.company,
        portalId: applications.portalId,
        jobUrl: applications.jobUrl,
        externalJobId: applications.externalJobId,
      })
      .from(applications)
      .where(eq(applications.userId, userId))
      .orderBy(desc(applications.createdAt))
      .limit(500)
  ).map((row) => ({ ...row }))

  for (const message of messages) {
    if (!mightBeJobMail(message.subject, message.snippet)) continue
    result.relevant += 1

    // Idempotent: a re-run after a crash must not double-notify.
    const [existing] = await db
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(and(eq(emailMessages.userId, userId), eq(emailMessages.externalId, message.externalId)))
      .limit(1)
    if (existing) continue

    let classification
    try {
      classification = await classifyEmail(userId, {
        from: message.fromAddress,
        subject: message.subject,
        snippet: message.snippet,
      })
      result.classified += 1
    } catch (error) {
      logger.warn({ err: error, userId }, 'email classification failed; storing unclassified')
      classification = null
    }

    const match = matchEmail(
      {
        fromAddress: message.fromAddress,
        subject: message.subject,
        links: linksIn(message.body),
        company: classification?.company ?? null,
      },
      openApplications,
    )
    if (match.applicationId) result.matched += 1

    const [stored] = await db
      .insert(emailMessages)
      .values({
        userId,
        externalId: message.externalId,
        fromAddress: message.fromAddress,
        fromDomain: message.fromAddress.split('@').pop()?.toLowerCase() ?? '',
        subject: message.subject,
        receivedAt: message.receivedAt,
        classification: classification?.classification ?? 'other',
        confidence: String(classification?.confidence ?? 0),
        company: classification?.company ?? null,
        role: classification?.role ?? null,
        nextStep: classification?.nextStep ?? null,
        happensAt: classification?.happensAt ? new Date(classification.happensAt) : null,
        applicationId: match.applicationId,
        matchedBy: match.matchedBy,
      })
      .onConflictDoNothing()
      .returning()
    if (!stored || !classification) continue

    if (ANNOUNCED.includes(classification.classification)) {
      await db.insert(notifications).values({
        userId,
        kind: NOTIFICATION_KIND[classification.classification] ?? classification.classification,
        urgency: URGENCY_FOR[classification.classification],
        title: titleFor(classification.classification, classification.company),
        body: classification.nextStep ?? classification.summary,
        link: match.applicationId ? `/app/jobs/${match.applicationId}` : null,
        emailMessageId: stored.id,
        applicationId: match.applicationId,
      })
      result.announced += 1
    }

    // A rejection updates the application quietly rather than announcing
    // itself. It is the most common outcome of applying at volume, and being
    // greeted by a wall of them is how the one interview invite gets missed.
    if (classification.classification === 'rejection' && match.applicationId) {
      await db
        .update(applications)
        .set({ status: 'rejected', updatedAt: new Date() })
        .where(and(eq(applications.id, match.applicationId), eq(applications.userId, userId)))
    }
  }

  await db
    .update(emailAccounts)
    .set({ cursor, lastPolledAt: new Date(), updatedAt: new Date() })
    .where(eq(emailAccounts.userId, userId))

  return result
}

function titleFor(classification: EmailClass, company: string | null): string {
  const where = company ? ` at ${company}` : ''
  switch (classification) {
    case 'interview_invite':
      return `Interview${where}`
    case 'assessment':
      return `Assessment${where}`
    case 'recruiter_outreach':
      return `A recruiter reached out${where}`
    default:
      return `Update${where}`
  }
}
