import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { browserProvider, env } from '../config/env.js'
import { serviceUnavailable } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { launchAutomationBrowser } from '../hunt/browser.js'
import { createBrowser, getBrowser, stopBrowser, type BrowserSessionInfo } from './client.js'

/**
 * One way to get a browser, for every part of the product that needs one.
 *
 * Before this, applying launched a local Chromium, the agent tier launched a
 * second one Stagehand owned, and LinkedIn outreach launched a third and
 * replayed a stored `storageState` into it. Three lifecycles, three failure
 * modes, and one of them could not run on a server at all: connecting an
 * account needed a real window, which is to say a monitor attached to the host.
 *
 * A hosted session removes that. The browser runs somewhere else, we drive it
 * over CDP with the same Playwright code as before, the login lives in a
 * profile rather than in a blob in our database, and `liveUrl` is a page a
 * human can be handed — to sign in, to clear a challenge, to take over an
 * application that got stuck. Nothing about that needs a display on this host.
 *
 * `local` remains for offline development and for anyone who would rather not
 * send their pages through a third party.
 */

export interface SessionOptions {
  /** Whose session this is. Null for platform work with no user attached. */
  userId: string | null
  /** Skill or subsystem opening it, recorded on the session for tracing. */
  label: string
  /** A saved login. Null opens a clean browser. */
  profileId?: string | null
  /**
   * Two-letter country for a managed residential proxy, or null for a direct
   * connection. Null is the right answer unless the site is known to care:
   * managed egress costs 25× direct.
   */
  proxyCountry?: string | null
  timeoutMinutes?: number
  viewport?: { width: number; height: number }
  /** Off by default; a recording is only worth its storage when reviewed. */
  record?: boolean
}

export interface AgentSession {
  browser: Browser
  context: BrowserContext
  page: Page
  provider: 'browser-use' | 'local'
  /** A URL a human can open to watch and take over. Null when local. */
  liveUrl: string | null
  /** The hosted session id, for cost lookup and forced cleanup. Null local. */
  sessionId: string | null
  close(): Promise<void>
}

/** What a session ended up costing, once it is closed. */
export interface SessionCost {
  browserUsd: number
  proxyUsd: number
  proxyMb: number
}

function assertAutomationEnabled(): void {
  if (!env.PORTAL_AUTOMATION_ENABLED) {
    throw serviceUnavailable('Portal automation is disabled. Set PORTAL_AUTOMATION_ENABLED=true.')
  }
}

async function openHosted(options: SessionOptions): Promise<AgentSession> {
  const viewport = options.viewport ?? { width: 1280, height: 900 }
  let info: BrowserSessionInfo
  try {
    info = await createBrowser({
      profileId: options.profileId ?? null,
      proxyCountryCode: options.proxyCountry ?? env.BROWSER_USE_PROXY_COUNTRY ?? null,
      timeout: options.timeoutMinutes ?? env.BROWSER_SESSION_TIMEOUT_MIN,
      browserScreenWidth: viewport.width,
      browserScreenHeight: viewport.height,
      ...(options.record ? { enableRecording: true } : {}),
      metadata: {
        label: options.label,
        ...(options.userId ? { userId: options.userId } : {}),
      },
    })
  } catch (error) {
    logger.error({ err: error, label: options.label }, 'could not create a hosted browser')
    throw error
  }

  if (!info.cdpUrl) {
    // A session with no CDP URL is already billing and can never be used.
    await stopBrowser(info.id).catch(() => undefined)
    throw serviceUnavailable('Hosted browser started without a CDP endpoint.')
  }

  let browser: Browser
  try {
    browser = await chromium.connectOverCDP(info.cdpUrl, { timeout: 60_000 })
  } catch (error) {
    await stopBrowser(info.id).catch(() => undefined)
    throw error
  }

  const context = browser.contexts()[0] ?? (await browser.newContext())
  const page = context.pages()[0] ?? (await context.newPage())

  let closed = false
  return {
    browser,
    context,
    page,
    provider: 'browser-use',
    liveUrl: info.liveUrl,
    sessionId: info.id,
    async close() {
      if (closed) return
      closed = true
      // Disconnect first so no in-flight command races the shutdown, then stop
      // the session itself. Skipping the second call leaks a browser that
      // bills until its timeout.
      await browser.close().catch(() => undefined)
      await stopBrowser(info.id).catch((error: unknown) => {
        logger.error({ err: error, sessionId: info.id }, 'hosted browser did not stop — it will bill until its timeout')
      })
    },
  }
}

async function openLocal(options: SessionOptions): Promise<AgentSession> {
  const browser = await launchAutomationBrowser()
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 900 },
  })
  const page = await context.newPage()

  let closed = false
  return {
    browser,
    context,
    page,
    provider: 'local',
    liveUrl: null,
    sessionId: null,
    async close() {
      if (closed) return
      closed = true
      await context.close().catch(() => undefined)
      await browser.close().catch(() => undefined)
    },
  }
}

export async function openSession(options: SessionOptions): Promise<AgentSession> {
  assertAutomationEnabled()
  return browserProvider === 'browser-use' ? openHosted(options) : openLocal(options)
}

/**
 * Opens a session, hands it to `work`, and closes it however that ends.
 *
 * Preferred over calling `openSession` directly. A hosted browser that escapes
 * its `finally` keeps billing, and the escape route is always the same one: an
 * early return or a throw between opening and closing.
 */
export async function withSession<T>(
  options: SessionOptions,
  work: (session: AgentSession) => Promise<T>,
): Promise<T> {
  const session = await openSession(options)
  try {
    return await work(session)
  } finally {
    await session.close()
  }
}

/** What a finished session cost. Null for local sessions, which cost nothing. */
export async function sessionCost(sessionId: string | null): Promise<SessionCost | null> {
  if (!sessionId) return null
  try {
    const info = await getBrowser(sessionId)
    return {
      browserUsd: Number(info.browserCost ?? 0),
      proxyUsd: Number(info.proxyCost ?? 0),
      proxyMb: Number(info.proxyUsedMb ?? 0),
    }
  } catch (error) {
    logger.debug({ err: error, sessionId }, 'could not read session cost')
    return null
  }
}
