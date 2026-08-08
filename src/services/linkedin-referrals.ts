import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { spawn } from 'node:child_process'
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
const MAX_THREADS_PER_SYNC = 2_000
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
  inboxesScanned: string[]
  visibleConversations: number
  scannedThreads: number
  scannedMessages: number
  datedMessages: number
  recentInboundMessages: number
  recentMessages: number
  matchedMessages: number
  imported: number
  duplicates: number
  lookbackDays: number
  syncedAt: string
}
interface ReferenceLinkedInExport {
  conversations: Array<{
    messages: Array<{
      id: string
      body: string
      senderName: string
      senderProfileUrl: string | null
      timestampRaw: string
      timestamp: string | null
      outbound: boolean
      links: RawLinkedInMessage['links']
    }>
  }>
}

interface ReferenceScrapeResult {
  conversations: RawLinkedInMessage[][]
  discoveredConversations: number
}

async function runProcess(
  cwd: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const child = spawn('npm', args, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    if (stdout.length < 50_000) stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 20_000) stderr += chunk.toString('utf8')
  })
  child.once('error', reject)
  child.once('exit', (code, signal) => {
    if (code === 0) resolve(stdout)
    else reject(new Error(`LinkedIn DM scraper exited ${code ?? signal}: ${stderr.trim()}`))
  })
  const timer = setTimeout(() => {
    child.kill('SIGTERM')
    reject(new Error('LinkedIn DM scraper timed out.'))
  }, timeoutMs)
  timer.unref()
  try {
    return await promise
  } finally {
    clearTimeout(timer)
  }
}

async function scrapeWithReferenceProject(
  lookbackDays: number,
): Promise<ReferenceScrapeResult | null> {
  const scraperDir = path.resolve(process.cwd(), '../linked-in-dm-scraper')
  const profileDir = path.join(scraperDir, 'data/browser-profile')
  try {
    await Promise.all([access(path.join(scraperDir, 'package.json')), access(profileDir)])
  } catch {
    return null
  }

  const outputPath = path.join(scraperDir, 'data/linkedin-dms.json')
  try {
    const output = await runProcess(
      scraperDir,
      [
        'run',
        'scrape',
        '--',
        '--hours',
        String(lookbackDays * 24),
        '--max-conversations',
        '1000',
        '--conversation-scrolls',
        '120',
        '--message-scrolls',
        '80',
        '--delay-ms',
        '3000',
        '--profile-dir',
        profileDir,
        '--output',
        outputPath,
      ],
      15 * 60 * 1000,
    )
    const parsed = JSON.parse(await readFile(outputPath, 'utf8')) as ReferenceLinkedInExport
    const discoveredConversations = Number(
      output.match(/Found (\d+) conversations/)?.[1] ?? parsed.conversations.length,
    )
    return {
      conversations: parsed.conversations.map((conversation) =>
        conversation.messages.map((message) => ({
          id: message.id,
          body: message.body,
          senderName: message.senderName,
          senderProfileUrl: message.senderProfileUrl,
          timestamp: message.timestamp ?? message.timestampRaw,
          outbound: message.outbound,
          links: message.links,
        })),
      ),
      discoveredConversations,
    }
  } catch (error) {
    logger.warn({ err: error }, 'reference LinkedIn DM scraper failed; using session fallback')
    return null
  }
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
  return (
    /\breferral\b/i.test(body) ||
    /\b(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+)?refer\b|\bplease\s+refer\s+(?:me|my\s+profile)\b|\brefer\s+(?:me|my\s+profile)\b/i.test(body) ||
    /\b(?:need|want|seeking|requesting|looking\s+for|appreciate|help(?:\s+me)?\s+(?:with|get))\b.{0,100}\b(?:a\s+)?referral\b/i.test(body) ||
    /\b(?:recommend|refer)\s+(?:me|my\s+profile)\b.{0,100}\b(?:job|role|position|opening)\b/i.test(body)
  )
}

function extractJobId(body: string): string | null {
  const value =
    body.match(
      /\b(?:job\s*(?:id|#)|req(?:uisition)?\s*(?:id|#)|requisition\s*(?:id|#))\s*[:#-]?\s*([A-Z0-9][A-Z0-9_-]{2,})\b/i,
    )?.[1] ??
    body.match(/\b(REF\d{5,}[A-Z0-9_-]*)\b/i)?.[1] ??
    body.match(/linkedin\.com\/jobs\/view\/(\d{6,})/i)?.[1]
  return value?.replace(/^j(?=REF\d)/i, '') ?? null
}

function extractTargetRole(body: string): string | null {
  const value =
    body.match(/\b(?:for|to)\s+(?:the\s+)?([A-Z][A-Za-z0-9+.#/&() -]{2,80}?)\s+(?:role|position|opening|job)\b/)?.[1] ??
    body.match(/\b(?:opportunity|opening)\s+(?:of|for)\s+([A-Z][A-Za-z0-9+.#/&() -]{2,80}?)\s+role\b/i)?.[1] ??
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

interface ThreadReference {
  url: string
  title: string
  snippet: string
  timestampRaw: string
}

interface ThreadDiscovery {
  threads: ThreadReference[]
  inboxesScanned: string[]
  visibleConversations: number
}

function parseLinkedInDateLabel(label: string, now = new Date()): Date | null {
  const clean = label.replace(/\s+/g, ' ').trim()
  if (!clean) return null
  if (/^today$/i.test(clean)) return new Date(now)
  if (/^yesterday$/i.test(clean)) return new Date(now.getTime() - 86_400_000)
  if (/^\d{1,2}:\d{2}\s*(?:AM|PM)$/i.test(clean)) return new Date(now)
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const weekday = weekdays.indexOf(clean.toLowerCase())
  if (weekday >= 0) {
    const daysBack = (now.getDay() - weekday + 7) % 7
    return new Date(now.getTime() - daysBack * 86_400_000)
  }
  const withYear = /\b\d{4}\b/.test(clean) ? clean : `${clean}, ${now.getFullYear()}`
  const parsed = new Date(withYear)
  if (Number.isNaN(parsed.getTime())) return null
  if (parsed.getTime() > now.getTime() + 86_400_000) parsed.setFullYear(parsed.getFullYear() - 1)
  return parsed
}

export function parseLinkedInMessageDate(value: string, now = new Date()): Date | null {
  if (!value) return null
  const direct = new Date(value)
  if (!Number.isNaN(direct.getTime())) return direct
  const [dateLabel = '', timeLabel = ''] = value.split('||')
  const date = parseLinkedInDateLabel(dateLabel, now)
  if (!date) return null
  const time = timeLabel.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i)
  if (time) {
    let hour = Number(time[1]) % 12
    if (time[3]?.toUpperCase() === 'PM') hour += 12
    date.setHours(hour, Number(time[2]), 0, 0)
  } else {
    date.setHours(12, 0, 0, 0)
  }
  return date
}

async function selectInboxFolder(page: Page, folder: 'Focused' | 'Other'): Promise<boolean> {
  const trigger = page.getByRole('button', { name: /^(Focused|Other)$/ }).first()
  await trigger.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined)
  if (!(await trigger.count())) return folder === 'Focused'
  const current = (await trigger.innerText()).trim()
  if (current !== folder) {
    await trigger.click()
    const option = page.getByText(folder, { exact: true }).last()
    await option.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => undefined)
    if (!(await option.count())) return false
    await option.click()
    await page.waitForTimeout(800)
  }
  await page
    .locator('.msg-conversations-container__conversations-list')
    .first()
    .evaluate((element) => element.scrollTo(0, 0))
    .catch(() => undefined)
  return true
}

async function collectCurrentInboxThreads(
  page: Page,
  maxConversations: number,
  since: Date,
  now: Date,
): Promise<{ threads: ThreadReference[]; visibleConversations: number }> {
  const list = page
    .locator(
      '.msg-conversations-container__conversations-list, [aria-label*="Conversation" i], [class*="conversations-list"]',
    )
    .first()
  await list.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined)
  const threads = new Map<string, ThreadReference>()
  const seenSummaries = new Set<string>()
  let unchanged = 0
  let consecutiveOld = 0

  for (
    let pass = 0;
    pass < 120 && threads.size < maxConversations && unchanged < 4 && consecutiveOld < 4;
    pass += 1
  ) {
    const before = threads.size
    const controls = page.locator('.msg-conversation-listitem__link, a[href*="/messaging/thread/"]')
    const count = await controls.count()
    for (let index = 0; index < count && threads.size < maxConversations; index += 1) {
      const control = controls.nth(index)
      const summary = await control
        .evaluate((element) => {
          const row = element.closest<HTMLElement>('.msg-conversation-listitem')
          return {
            title:
              row
                ?.querySelector<HTMLElement>('.msg-conversation-listitem__participant-names')
                ?.innerText.trim() ?? '',
            snippet:
              row
                ?.querySelector<HTMLElement>(
                  '.msg-conversation-card__message-snippet, .msg-conversation-card__message-snippet--v2',
                )
                ?.innerText.trim() ?? '',
            time: row?.querySelector<HTMLElement>('time')?.innerText.trim() ?? '',
          }
        })
        .catch(() => ({ title: '', snippet: '', time: '' }))
      seenSummaries.add(`${summary.title}\n${summary.time}\n${summary.snippet}`)
      const cardDate = parseLinkedInDateLabel(summary.time, now)
      const clearlyOld = Boolean(cardDate && cardDate.getTime() + 86_400_000 < since.getTime())
      if (clearlyOld) {
        consecutiveOld += 1
        continue
      }
      consecutiveOld = 0

      const href = await control.getAttribute('href').catch(() => null)
      let url = href?.includes('/messaging/thread/')
        ? new URL(href, 'https://www.linkedin.com').toString().split('?')[0]!
        : null
      if (!url) {
        await control.evaluate((element) => (element as HTMLElement).click()).catch(() => undefined)
        await page.waitForTimeout(400)
        if (/\/messaging\/thread\//.test(page.url())) url = page.url().split('?')[0]!
      }
      if (url) {
        threads.set(url, {
          url,
          title: summary.title,
          snippet: summary.snippet,
          timestampRaw: summary.time,
        })
      }
    }
    unchanged = threads.size === before ? unchanged + 1 : 0
    const moved = await list
      .evaluate((element) => {
        const beforeScroll = element.scrollTop
        element.scrollBy(0, Math.max(500, element.clientHeight * 0.85))
        return element.scrollTop !== beforeScroll
      })
      .catch(() => false)
    if (!moved && threads.size === before) unchanged = 4
    await page.waitForTimeout(650)
  }
  return { threads: [...threads.values()], visibleConversations: seenSummaries.size }
}

async function collectThreads(page: Page, since: Date): Promise<ThreadDiscovery> {
  const threads = new Map<string, ThreadReference>()
  const inboxesScanned: string[] = []
  const now = new Date()
  let visibleConversations = 0
  for (const folder of ['Focused', 'Other'] as const) {
    if (threads.size >= MAX_THREADS_PER_SYNC) break
    if (!(await selectInboxFolder(page, folder))) continue
    inboxesScanned.push(folder)
    const found = await collectCurrentInboxThreads(
      page,
      MAX_THREADS_PER_SYNC - threads.size,
      since,
      now,
    )
    visibleConversations += found.visibleConversations
    for (const thread of found.threads) threads.set(thread.url, thread)
  }
  return { threads: [...threads.values()], inboxesScanned, visibleConversations }
}

async function scrollAllMessages(page: Page): Promise<void> {
  const messages = page.locator('.msg-s-event-listitem')
  const list = page.locator('.msg-s-message-list, [class*="message-list"]').first()
  let unchanged = 0
  for (let pass = 0; pass < 80 && unchanged < 4; pass += 1) {
    const before = await messages.count()
    await list.evaluate((element) => element.scrollTo(0, -element.scrollHeight)).catch(() => undefined)
    await page.waitForTimeout(750)
    const after = await messages.count()
    unchanged = after === before ? unchanged + 1 : 0
  }
}

async function extractThreadMessages(
  page: Page,
  thread: ThreadReference,
): Promise<RawLinkedInMessage[]> {
  await page.goto(thread.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  await page
    .locator('.msg-s-event-listitem')
    .first()
    .waitFor({ state: 'attached', timeout: 12_000 })
    .catch(() => undefined)
  await scrollAllMessages(page)

  const extracted = await page
    .locator('.msg-s-event-listitem')
    .evaluateAll((nodes) => {
      let lastSender = ''
      let lastDate = ''
      let lastTime = ''
      return nodes.flatMap((node) => {
        const element = node as HTMLElement
        const group = element.closest<HTMLElement>('li.msg-s-message-list__event')
        const date = group
          ?.querySelector<HTMLElement>('.msg-s-message-list__time-heading')
          ?.innerText.trim()
        if (date) lastDate = date
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
        const links = Array.from(element.querySelectorAll<HTMLAnchorElement>('a[href]')).map((link) => ({
          href: link.href,
          text: link.innerText.trim(),
          download: link.getAttribute('download'),
        }))
        if (!body && links.length === 0) return []
        const time =
          element.querySelector<HTMLElement>('.msg-s-message-group__timestamp')?.innerText.trim() ??
          group?.querySelector<HTMLElement>('.msg-s-message-group__timestamp')?.innerText.trim()
        if (time) lastTime = time
        const senderLink =
          element.querySelector<HTMLAnchorElement>('a[href*="/in/"]') ??
          group?.querySelector<HTMLAnchorElement>('a[href*="/in/"]')
        const classes = typeof element.className === 'string' ? element.className : ''
        return [
          {
            id: element.dataset.eventUrn || element.getAttribute('data-event-urn') || '',
            body,
            senderName,
            senderProfileUrl: senderLink?.href ?? null,
            timestamp: `${lastDate}||${lastTime}`,
            outbound: !/msg-s-event-listitem--other/.test(classes),
            links,
          },
        ]
      })
    })
    .catch(() => [])

  return extracted.map((message) => ({
    ...message,
    id:
      message.id ||
      crypto
        .createHash('sha256')
        .update(
          `${thread.url}\n${message.senderProfileUrl ?? message.senderName}\n${message.timestamp}\n${message.body}`,
        )
        .digest('hex'),
  }))
}

function messageFromSummary(
  thread: ThreadReference,
  since: Date,
  now: Date,
): RawLinkedInMessage[] {
  if (!thread.snippet) return []
  const timeOnly = /^\d{1,2}:\d{2}\s*(?:AM|PM)$/i.test(thread.timestampRaw)
  const timestamp = timeOnly ? `Today||${thread.timestampRaw}` : `${thread.timestampRaw}||`
  const parsed = parseLinkedInMessageDate(timestamp, now)
  if (!parsed || parsed < since) return []
  const outbound = /^you\s*:/i.test(thread.snippet)
  return [
    {
      id: crypto
        .createHash('sha256')
        .update(`${thread.url}\n${thread.timestampRaw}\n${thread.snippet}`)
        .digest('hex'),
      body: thread.snippet,
      senderName: outbound ? 'You' : thread.title,
      senderProfileUrl: null,
      timestamp,
      outbound,
      links: [],
    },
  ]
}

export function extractReferrals(messages: RawLinkedInMessage[], cutoff: Date): ExtractedReferral[] {
  const request = messages
    .flatMap((message) => {
      if (message.outbound || !isReferralRequest(message.body)) return []
      const receivedAt = parseLinkedInMessageDate(message.timestamp)
      if (!receivedAt || receivedAt < cutoff) return []
      return [{ message, receivedAt }]
    })
    .sort((left, right) => left.receivedAt.getTime() - right.receivedAt.getTime())[0]
  if (!request) return []

  const resume = resumeLink(request.message.links)
  return [
    {
      externalMessageId:
        request.message.id ||
        crypto
          .createHash('sha256')
          .update(
            `${request.message.senderProfileUrl ?? request.message.senderName}\n${request.message.timestamp}\n${request.message.body}`,
          )
          .digest('hex'),
      requesterName: request.message.senderName || 'LinkedIn member',
      requesterProfileUrl: normalizeLinkedInUrl(request.message.senderProfileUrl),
      receivedAt: request.receivedAt,
      targetRole: extractTargetRole(request.message.body),
      jobRequisitionId: extractJobId(request.message.body),
      resumeName: resume?.download || resume?.text || null,
      resumeUrl: normalizeLinkedInUrl(resume?.href ?? null),
      note: request.message.body,
      links: request.message.links,
    },
  ]
}

async function saveResumeAttachment(
  context: BrowserContext | null,
  userId: string,
  referral: ExtractedReferral,
): Promise<{ storagePath: string | null; name: string | null }> {
  if (!context || !referral.resumeUrl || !storageConfigured()) {
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

export async function persistExtractedLinkedInReferral(
  context: BrowserContext | null,
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
    const reference = await scrapeWithReferenceProject(lookbackDays)
    if (reference) {
      const cutoff = new Date(Date.now() - lookbackDays * 86_400_000)
      let scannedMessages = 0
      let datedMessages = 0
      let recentMessages = 0
      let recentInboundMessages = 0
      let matchedMessages = 0
      let imported = 0
      let duplicates = 0
      for (const messages of reference.conversations) {
        scannedMessages += messages.length
        const dated = messages.filter((message) => parseLinkedInMessageDate(message.timestamp) !== null)
        datedMessages += dated.length
        const recent = dated.filter((message) => {
          const receivedAt = parseLinkedInMessageDate(message.timestamp)
          return receivedAt !== null && receivedAt >= cutoff
        })
        recentMessages += recent.length
        recentInboundMessages += recent.filter((message) => !message.outbound).length
        const extracted = extractReferrals(messages, cutoff)
        matchedMessages += extracted.length
        for (const referral of extracted) {
          const result = await persistExtractedLinkedInReferral(
            context,
            userId,
            account.email,
            referral,
          )
          if (result === 'inserted') imported += 1
          else duplicates += 1
        }
      }
      const syncedAt = new Date()
      await updateAccount(userId, {
        email: account.email,
        externalUserId: account.externalUserId,
        status: 'ready',
        actionRequired: null,
        lastVerifiedAt: syncedAt,
        profileSyncedAt: syncedAt,
      })
      return {
        inboxesScanned: ['Focused', 'Other'],
        visibleConversations: reference.discoveredConversations,
        scannedThreads: reference.conversations.length,
        scannedMessages,
        datedMessages,
        recentMessages,
        recentInboundMessages,
        matchedMessages,
        imported,
        duplicates,
        lookbackDays,
        syncedAt: syncedAt.toISOString(),
      }
    }

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
    const threadDiscovery = await collectThreads(page, cutoff)
    if (threadDiscovery.inboxesScanned.length === 0) {
      throw conflict('LinkedIn inbox did not load. Reconnect LinkedIn, then try again.')
    }
    const now = new Date()
    let scannedMessages = 0
    let datedMessages = 0
    let recentMessages = 0
    let recentInboundMessages = 0
    let matchedMessages = 0
    let imported = 0
    let duplicates = 0
    for (const thread of threadDiscovery.threads) {
      let messages: RawLinkedInMessage[]
      try {
        messages = await extractThreadMessages(page, thread)
      } catch (error) {
        logger.warn({ err: error, threadUrl: thread.url }, 'deep LinkedIn thread scrape failed')
        messages = messageFromSummary(thread, cutoff, now)
      }
      if (messages.length === 0) messages = messageFromSummary(thread, cutoff, now)
      scannedMessages += messages.length
      const dated = messages.filter((message) => parseLinkedInMessageDate(message.timestamp) !== null)
      datedMessages += dated.length
      const recent = dated.filter((message) => {
        const receivedAt = parseLinkedInMessageDate(message.timestamp)
        return receivedAt !== null && receivedAt >= cutoff
      })
      recentMessages += recent.length
      recentInboundMessages += recent.filter((message) => !message.outbound).length
      const extracted = extractReferrals(messages, cutoff)
      matchedMessages += extracted.length
      for (const referral of extracted) {
        const result = await persistExtractedLinkedInReferral(context, userId, account.email, referral)
        if (result === 'inserted') imported += 1
        else duplicates += 1
      }
      await page.waitForTimeout(3_000)
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
      inboxesScanned: threadDiscovery.inboxesScanned,
      visibleConversations: threadDiscovery.visibleConversations,
      scannedThreads: threadDiscovery.threads.length,
      scannedMessages,
      datedMessages,
      recentMessages,
      recentInboundMessages,
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
