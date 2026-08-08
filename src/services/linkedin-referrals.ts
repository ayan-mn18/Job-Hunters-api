import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import type { BrowserContext, Page } from 'playwright-core'
import { env, hasPortalCredentialVault } from '../config/env.js'
import { db } from '../db/client.js'
import { portalAccounts, referrals, type PortalAccount } from '../db/schema.js'
import { launchAutomationBrowser, launchInteractiveAutomationContext } from '../hunt/browser.js'
import { conflict, notFound, serviceUnavailable } from '../lib/errors.js'
import { decryptCredential, encryptCredential } from '../lib/credential-vault.js'
import { logger } from '../lib/logger.js'
import { buildObjectKey, storageConfigured, uploadObject } from '../lib/storage.js'
import { recordActivity } from './activity.js'
import { getReferralDraftGenerator } from './referral-draft.js'

const PORTAL_ID = 'linkedin-referrals'
const DAILY_SYNC_MS = 24 * 60 * 60 * 1000
const SCHEDULER_TICK_MS = 60 * 60 * 1000
const CONNECT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_THREADS_PER_SYNC = 80
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

interface StoredBrowserState {
  cookies: Array<{
    name: string
    value: string
    domain: string
    path: string
    expires: number
    httpOnly: boolean
    secure: boolean
    sameSite: 'Strict' | 'Lax' | 'None'
  }>
  origins: Array<{
    origin: string
    localStorage: Array<{ name: string; value: string }>
  }>
}

interface LinkedInSessionCredential {
  kind: 'linkedin-storage-state'
  profileUrl: string
  storageState: StoredBrowserState
}

export interface RawLinkedInMessage {
  id: string
  body: string
  senderName: string
  senderProfileUrl: string | null
  timestamp: string
  outbound: boolean
  links: Array<{ href: string; text: string; download: string | null }>
}

export interface ExtractedReferral {
  externalMessageId: string
  requesterName: string
  requesterProfileUrl: string | null
  receivedAt: Date
  targetRole: string | null
  jobRequisitionId: string | null
  resumeName: string | null
  resumeUrl: string | null
  note: string
  links: RawLinkedInMessage['links']
}

export interface LinkedInSyncResult {
  scannedThreads: number
  scannedMessages: number
  matchedMessages: number
  imported: number
  duplicates: number
  lookbackDays: number
  syncedAt: string
}

const connectionJobs = new Map<string, Promise<void>>()
const syncingUsers = new Set<string>()

function accountStatus(account: PortalAccount | undefined) {
  return {
    connected: account?.status === 'ready',
    status: account?.status ?? 'absent',
    profileUrl: account?.externalUserId ?? null,
    actionRequired: account?.actionRequired ?? null,
    lastVerifiedAt: account?.lastVerifiedAt?.toISOString() ?? null,
    lastSyncedAt: account?.profileSyncedAt?.toISOString() ?? null,
    syncing: account ? syncingUsers.has(account.userId) : false,
    schedule: 'Every 24 hours',
  }
}

async function loadAccount(userId: string): Promise<PortalAccount | undefined> {
  const [account] = await db
    .select()
    .from(portalAccounts)
    .where(and(eq(portalAccounts.userId, userId), eq(portalAccounts.portalId, PORTAL_ID)))
    .limit(1)
  return account
}

async function updateAccount(
  userId: string,
  values: Partial<typeof portalAccounts.$inferInsert>,
): Promise<PortalAccount> {
  const [account] = await db
    .insert(portalAccounts)
    .values({
      userId,
      portalId: PORTAL_ID,
      email: String(values.email ?? ''),
      ...values,
    })
    .onConflictDoUpdate({
      target: [portalAccounts.userId, portalAccounts.portalId],
      set: { ...values, updatedAt: new Date() },
    })
    .returning()
  if (!account) throw new Error('LinkedIn connection update returned no row')
  return account
}

export async function getLinkedInReferralStatus(userId: string) {
  return accountStatus(await loadAccount(userId))
}

export async function beginLinkedInReferralConnection(input: {
  userId: string
  email: string
  profileUrl: string
}) {
  if (!hasPortalCredentialVault) {
    throw serviceUnavailable('LinkedIn session storage is not configured.')
  }
  if (connectionJobs.has(input.userId)) return accountStatus(await loadAccount(input.userId))

  const account = await updateAccount(input.userId, {
    email: input.email,
    externalUserId: input.profileUrl,
    status: 'provisioning',
    actionRequired: 'Finish signing in within the LinkedIn window that opened.',
  })
  const job = connectLinkedInInBrowser(input)
    .catch((error) => {
      logger.error({ err: error, userId: input.userId }, 'LinkedIn connection failed')
    })
    .finally(() => connectionJobs.delete(input.userId))
  connectionJobs.set(input.userId, job)
  return accountStatus(account)
}

async function connectLinkedInInBrowser(input: {
  userId: string
  email: string
  profileUrl: string
}): Promise<void> {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'huntly-linkedin-'))
  let context: BrowserContext | undefined
  try {
    context = await launchInteractiveAutomationContext(userDataDir)
    const page = context.pages()[0] ?? (await context.newPage())
    await page.goto('https://www.linkedin.com/messaging/', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
    const deadline = Date.now() + CONNECT_TIMEOUT_MS
    let connected = false
    while (Date.now() < deadline && !page.isClosed()) {
      const url = page.url()
      const body = await page.locator('body').innerText().catch(() => '')
      if (
        url.includes('linkedin.com/messaging') &&
        !url.includes('/login') &&
        !/sign in to linkedin|join linkedin/i.test(body)
      ) {
        connected = true
        break
      }
      if (/checkpoint|challenge|security verification/i.test(url) || /verify your identity/i.test(body)) {
        await updateAccount(input.userId, {
          email: input.email,
          externalUserId: input.profileUrl,
          status: 'blocked',
          actionRequired: 'Complete LinkedIn security verification, then connect again.',
        })
      }
      await sleep(2_000)
    }
    if (!connected) {
      await updateAccount(input.userId, {
        email: input.email,
        externalUserId: input.profileUrl,
        status: 'pending_verification',
        actionRequired: 'LinkedIn sign-in timed out. Click connect and finish sign-in within ten minutes.',
      })
      return
    }

    const storageState = await context.storageState()
    await updateAccount(input.userId, {
      email: input.email,
      externalUserId: input.profileUrl,
      encryptedCredentials: encryptCredential<LinkedInSessionCredential>({
        kind: 'linkedin-storage-state',
        profileUrl: input.profileUrl,
        storageState,
      }),
      status: 'ready',
      actionRequired: null,
      lastVerifiedAt: new Date(),
    })
  } catch (error) {
    await updateAccount(input.userId, {
      email: input.email,
      externalUserId: input.profileUrl,
      status: 'failed',
      actionRequired: error instanceof Error ? error.message : String(error),
    })
    throw error
  } finally {
    await context?.close().catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true })
  }

  await syncLinkedInReferrals(input.userId, 7).catch((error) => {
    logger.error({ err: error, userId: input.userId }, 'initial LinkedIn referral sync failed')
  })
}

export async function disconnectLinkedInReferrals(userId: string): Promise<void> {
  await db
    .delete(portalAccounts)
    .where(and(eq(portalAccounts.userId, userId), eq(portalAccounts.portalId, PORTAL_ID)))
}

export function isReferralRequest(body: string): boolean {
  return /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?refer\b|\bplease\s+refer\s+me\b|\breferral\s+(?:for|to|at)\b|\brefer\s+me\s+(?:for|to|at)\b|\bseeking\s+(?:a\s+)?referral\b/i.test(
    body,
  )
}

function extractJobId(body: string): string | null {
  return (
    body.match(
      /\b(?:job\s*(?:id|#)|req(?:uisition)?\s*(?:id|#)?|requisition)\s*[:#-]?\s*([A-Z0-9][A-Z0-9_-]{2,})\b/i,
    )?.[1] ?? null
  )
}

function extractTargetRole(body: string): string | null {
  const value =
    body.match(/\b(?:for|to)\s+(?:the\s+)?([A-Z][A-Za-z0-9+.#/&() -]{2,80}?)\s+(?:role|position|opening|job)\b/)?.[1] ??
    body.match(/\b(?:role|position|opening)\s+(?:of|for|:)?\s*([A-Z][A-Za-z0-9+.#/&() -]{2,80})(?:[,.]|$)/)?.[1]
  return value?.trim() ?? null
}

function resumeLink(links: RawLinkedInMessage['links']) {
  return links.find((link) =>
    /resume|curriculum|\bcv\b|drive\.google|docs\.google|dropbox|dms\/prv\/attachment/i.test(
      `${link.text} ${link.download ?? ''} ${link.href}`,
    ),
  )
}

function normalizeLinkedInUrl(value: string | null): string | null {
  if (!value) return null
  try {
    return new URL(value, 'https://www.linkedin.com').toString()
  } catch {
    return null
  }
}

async function collectThreadUrls(page: Page): Promise<string[]> {
  await page
    .waitForSelector('a[href*="/messaging/thread/"]', { timeout: 15_000 })
    .catch(() => undefined)
  const urls = new Set<string>()
  let unchanged = 0
  for (let pass = 0; pass < 16 && urls.size < MAX_THREADS_PER_SYNC && unchanged < 3; pass += 1) {
    const before = urls.size
    const hrefs = await page
      .locator('a[href*="/messaging/thread/"]')
      .evaluateAll((anchors) =>
        anchors
          .map((anchor) => (anchor as HTMLAnchorElement).href)
          .filter((href) => href.includes('/messaging/thread/')),
      )
    for (const href of hrefs) urls.add(href.split('?')[0] ?? href)
    unchanged = urls.size === before ? unchanged + 1 : 0
    await page
      .locator(
        '.msg-conversations-container__conversations-list, .msg-conversations-container__convo-list, [class*="conversation-list"]',
      )
      .first()
      .evaluate((element) => element.scrollTo(0, element.scrollHeight))
      .catch(() => page.mouse.wheel(0, 1_200))
    await sleep(500)
  }
  return [...urls].slice(0, MAX_THREADS_PER_SYNC)
}

async function extractThreadMessages(page: Page): Promise<RawLinkedInMessage[]> {
  await page
    .waitForSelector(
      'li.msg-s-message-list__event, [data-event-urn], [class*="message-list__event"]',
      { timeout: 10_000 },
    )
    .catch(() => undefined)
  return page
    .locator('li.msg-s-message-list__event, [data-event-urn], [class*="message-list__event"]')
    .evaluateAll((nodes) => {
      let lastSender = ''
      return nodes.flatMap((node, index) => {
        const element = node as HTMLElement
        const senderElement = element.querySelector<HTMLElement>(
          '.msg-s-message-group__name, [class*="message-group__name"], [data-anonymize="person-name"]',
        )
        const senderName = senderElement?.innerText.trim() || lastSender
        if (senderName) lastSender = senderName
        const body =
          element
            .querySelector<HTMLElement>(
              '.msg-s-event-listitem__body, .msg-s-message-group__msg-text, [class*="event-listitem__body"], [class*="message-bubble"]',
            )
            ?.innerText.trim() ?? ''
        if (!body) return []
        const time = element.querySelector<HTMLTimeElement>('time')
        const timestamp = time?.dateTime || time?.getAttribute('datetime') || time?.title || ''
        const senderLink =
          element.querySelector<HTMLAnchorElement>('a[href*="/in/"]') ??
          senderElement?.closest<HTMLAnchorElement>('a[href*="/in/"]')
        const links = Array.from(element.querySelectorAll<HTMLAnchorElement>('a[href]')).map((link) => ({
          href: link.href,
          text: link.innerText.trim(),
          download: link.getAttribute('download'),
        }))
        const classes = element.className
        const outbound =
          /outbound|from-me|self/i.test(typeof classes === 'string' ? classes : '') ||
          Boolean(element.querySelector('[class*="outbound"], [data-is-outbound="true"]'))
        return [
          {
            id:
              element.dataset.eventUrn ??
              element.getAttribute('data-event-urn') ??
              element.id ??
              `message-${index}`,
            body,
            senderName,
            senderProfileUrl: senderLink?.href ?? null,
            timestamp,
            outbound,
            links,
          },
        ]
      })
    })
    .catch(() => [])
}

function parseMessageDate(value: string): Date | null {
  if (!value) return null
  const direct = new Date(value)
  if (!Number.isNaN(direct.getTime())) return direct
  const now = new Date()
  if (/today/i.test(value)) return now
  if (/yesterday/i.test(value)) return new Date(now.getTime() - 86_400_000)
  const withYear = new Date(`${value} ${now.getFullYear()}`)
  return Number.isNaN(withYear.getTime()) ? null : withYear
}

export function extractReferrals(messages: RawLinkedInMessage[], cutoff: Date): ExtractedReferral[] {
  return messages.flatMap((message) => {
    if (message.outbound || !isReferralRequest(message.body)) return []
    const receivedAt = parseMessageDate(message.timestamp)
    if (!receivedAt || receivedAt < cutoff) return []
    const resume = resumeLink(message.links)
    return [
      {
        externalMessageId: message.id || crypto.createHash('sha256').update(message.body).digest('hex'),
        requesterName: message.senderName || 'LinkedIn member',
        requesterProfileUrl: normalizeLinkedInUrl(message.senderProfileUrl),
        receivedAt,
        targetRole: extractTargetRole(message.body),
        jobRequisitionId: extractJobId(message.body),
        resumeName: resume?.download || resume?.text || null,
        resumeUrl: normalizeLinkedInUrl(resume?.href ?? null),
        note: message.body,
        links: message.links,
      },
    ]
  })
}

async function saveResumeAttachment(
  context: BrowserContext,
  userId: string,
  referral: ExtractedReferral,
): Promise<{ storagePath: string | null; name: string | null }> {
  if (!referral.resumeUrl || !storageConfigured()) {
    return { storagePath: null, name: referral.resumeName }
  }
  try {
    const response = await context.request.get(referral.resumeUrl, { timeout: 20_000 })
    if (!response.ok()) return { storagePath: null, name: referral.resumeName }
    const body = await response.body()
    if (body.byteLength > MAX_ATTACHMENT_BYTES) return { storagePath: null, name: referral.resumeName }
    const contentType = response.headers()['content-type'] ?? 'application/octet-stream'
    const contentDisposition = response.headers()['content-disposition'] ?? ''
    const fileName =
      contentDisposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i)?.[1] ??
      referral.resumeName ??
      `linkedin-resume-${Date.now()}`
    const decodedName = decodeURIComponent(fileName.replace(/^"|"$/g, ''))
    const storagePath = buildObjectKey(userId, 'referrals', decodedName)
    await uploadObject({ key: storagePath, body, mimeType: contentType })
    return { storagePath, name: decodedName }
  } catch (error) {
    logger.warn({ err: error, userId }, 'could not archive LinkedIn resume attachment')
    return { storagePath: null, name: referral.resumeName }
  }
}

async function persistReferral(
  context: BrowserContext,
  userId: string,
  referrerName: string,
  referral: ExtractedReferral,
): Promise<'inserted' | 'duplicate'> {
  const attachment = await saveResumeAttachment(context, userId, referral)
  const [row] = await db
    .insert(referrals)
    .values({
      userId,
      requesterName: referral.requesterName,
      requesterProfileUrl: referral.requesterProfileUrl,
      source: 'linkedin',
      externalMessageId: referral.externalMessageId,
      receivedAt: referral.receivedAt,
      targetRole: referral.targetRole,
      jobRequisitionId: referral.jobRequisitionId,
      resumeName: attachment.name,
      resumeStoragePath: attachment.storagePath,
      resumeUrl: referral.resumeUrl,
      note: referral.note,
    })
    .onConflictDoNothing()
    .returning()
  if (!row) return 'duplicate'

  const generator = getReferralDraftGenerator()
  const draft = await generator.generate({
    referralId: row.id,
    requesterName: row.requesterName,
    requesterHeadline: row.requesterHeadline,
    targetRole: row.targetRole,
    jobRequisitionId: row.jobRequisitionId,
    jobDescription: row.jobDescription,
    note: row.note,
    resumeName: row.resumeName,
    referrerName,
  })
  await db
    .update(referrals)
    .set({ draft: draft.text, draftGeneratedAt: draft.generatedAt, draftModel: draft.model })
    .where(eq(referrals.id, row.id))
  await recordActivity({
    userId,
    kind: 'referral_received',
    text: `${row.requesterName} asked for a referral on LinkedIn`,
    meta: { referralId: row.id },
  })
  return 'inserted'
}

export async function syncLinkedInReferrals(
  userId: string,
  lookbackDays = 1,
): Promise<LinkedInSyncResult> {
  if (syncingUsers.has(userId)) throw conflict('LinkedIn referral sync is already running.')
  const account = await loadAccount(userId)
  if (!account) throw notFound('Connect LinkedIn before syncing referrals.')
  if (account.status !== 'ready' || !account.encryptedCredentials) {
    throw conflict(account.actionRequired || 'LinkedIn connection is not ready.')
  }
  const credential = decryptCredential<LinkedInSessionCredential>(account.encryptedCredentials)
  if (credential.kind !== 'linkedin-storage-state') throw conflict('Stored LinkedIn session is invalid.')

  syncingUsers.add(userId)
  const browser = await launchAutomationBrowser()
  const context = await browser.newContext({ storageState: credential.storageState })
  try {
    const page = await context.newPage()
    await page.goto('https://www.linkedin.com/messaging/', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
    const body = await page.locator('body').innerText().catch(() => '')
    if (page.url().includes('/login') || /sign in to linkedin/i.test(body)) {
      await updateAccount(userId, {
        email: account.email,
        externalUserId: account.externalUserId,
        status: 'blocked',
        actionRequired: 'LinkedIn session expired. Connect again from My Kit.',
        encryptedCredentials: null,
      })
      throw conflict('LinkedIn session expired. Connect again from My Kit.')
    }

    const cutoff = new Date(Date.now() - lookbackDays * 86_400_000)
    const threadUrls = await collectThreadUrls(page)
    let scannedMessages = 0
    let matchedMessages = 0
    let imported = 0
    let duplicates = 0
    for (const threadUrl of threadUrls) {
      await page.goto(threadUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined)
      const messages = await extractThreadMessages(page)
      scannedMessages += messages.length
      const extracted = extractReferrals(messages, cutoff)
      matchedMessages += extracted.length
      for (const referral of extracted) {
        const result = await persistReferral(context, userId, account.email, referral)
        if (result === 'inserted') imported += 1
        else duplicates += 1
      }
    }

    const syncedAt = new Date()
    const freshState = await context.storageState()
    await updateAccount(userId, {
      email: account.email,
      externalUserId: account.externalUserId,
      encryptedCredentials: encryptCredential<LinkedInSessionCredential>({
        ...credential,
        storageState: freshState,
      }),
      status: 'ready',
      actionRequired: null,
      lastVerifiedAt: syncedAt,
      profileSyncedAt: syncedAt,
    })
    return {
      scannedThreads: threadUrls.length,
      scannedMessages,
      matchedMessages,
      imported,
      duplicates,
      lookbackDays,
      syncedAt: syncedAt.toISOString(),
    }
  } finally {
    syncingUsers.delete(userId)
    await context.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
  }
}

async function runScheduledSyncs(): Promise<void> {
  const staleBefore = new Date(Date.now() - DAILY_SYNC_MS)
  const accounts = await db
    .select()
    .from(portalAccounts)
    .where(
      and(
        eq(portalAccounts.portalId, PORTAL_ID),
        eq(portalAccounts.status, 'ready'),
        or(isNull(portalAccounts.profileSyncedAt), lt(portalAccounts.profileSyncedAt, staleBefore)),
      ),
    )
  for (const account of accounts) {
    if (syncingUsers.has(account.userId)) continue
    await syncLinkedInReferrals(account.userId, account.profileSyncedAt ? 1 : 7).catch((error) => {
      logger.error({ err: error, userId: account.userId }, 'scheduled LinkedIn referral sync failed')
    })
  }
}

export function startLinkedInReferralScheduler(): () => void {
  if (!env.PORTAL_AUTOMATION_ENABLED || !hasPortalCredentialVault) {
    logger.warn('LinkedIn referral scheduler disabled: automation or credential vault is unavailable.')
    return () => undefined
  }
  const initial = setTimeout(() => void runScheduledSyncs(), 30_000)
  initial.unref()
  const interval = setInterval(() => void runScheduledSyncs(), SCHEDULER_TICK_MS)
  interval.unref()
  logger.info('LinkedIn referral scheduler started')
  return () => {
    clearTimeout(initial)
    clearInterval(interval)
  }
}
