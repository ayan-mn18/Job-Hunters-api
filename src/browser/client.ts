import { env, hasBrowserUse } from '../config/env.js'

/**
 * The Browser Use v4 REST surface, and nothing else.
 *
 * Kept separate from `session.ts` so the parts that spend money are visible in
 * one file. Three of these calls bill: creating a browser starts a clock at
 * $0.02 an hour, a managed proxy bills per gigabyte, and a managed run bills
 * per token. Listing and stopping are free, and stopping is the one that
 * matters most — a browser is not stopped by disconnecting from it.
 */

export class BrowserUseUnavailableError extends Error {
  constructor() {
    super('BROWSER_USE_API_KEY is not set — hosted browsers are disabled.')
    this.name = 'BrowserUseUnavailableError'
  }
}

export class BrowserUseError extends Error {
  constructor(readonly status: number, message: string) {
    super(`Browser Use ${status}: ${message}`)
    this.name = 'BrowserUseError'
  }
}

async function call<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutMs = 60_000,
): Promise<T> {
  if (!hasBrowserUse) throw new BrowserUseUnavailableError()

  const response = await fetch(`${env.BROWSER_USE_API_BASE}${path}`, {
    method,
    headers: {
      'X-Browser-Use-API-Key': env.BROWSER_USE_API_KEY as string,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  })

  const text = await response.text()
  const json: unknown = text ? JSON.parse(text) : {}
  if (!response.ok) {
    const detail =
      (json as { detail?: string; message?: string }).detail ??
      (json as { message?: string }).message ??
      text.slice(0, 200)
    throw new BrowserUseError(response.status, detail || 'unknown error')
  }
  return json as T
}

export interface BrowserSessionInfo {
  id: string
  status: 'active' | 'stopped' | string
  liveUrl: string | null
  cdpUrl: string | null
  timeoutAt: string | null
  startedAt: string | null
  finishedAt: string | null
  proxyUsedMb: string | null
  proxyCost: string | null
  browserCost: string | null
  recordingUrl: string | null
  metadata: Record<string, string> | null
}

export interface CreateBrowserOptions {
  profileId?: string | null
  /** Two-letter country, or null for a direct connection. */
  proxyCountryCode?: string | null
  timeout?: number
  browserScreenWidth?: number
  browserScreenHeight?: number
  solveCaptchas?: boolean
  enableRecording?: boolean
  metadata?: Record<string, string>
}

export function createBrowser(options: CreateBrowserOptions): Promise<BrowserSessionInfo> {
  return call<BrowserSessionInfo>('POST', '/browsers', {
    // Explicit null is meaningful here and is not the same as omitting the
    // field: omitted defaults to a US managed proxy at $5/GB, null is a direct
    // connection at $0.20/GB.
    proxyCountryCode: options.proxyCountryCode ?? null,
    ...(options.profileId ? { profileId: options.profileId } : {}),
    ...(options.timeout ? { timeout: options.timeout } : {}),
    ...(options.browserScreenWidth ? { browserScreenWidth: options.browserScreenWidth } : {}),
    ...(options.browserScreenHeight ? { browserScreenHeight: options.browserScreenHeight } : {}),
    ...(options.solveCaptchas === undefined ? {} : { solveCaptchas: options.solveCaptchas }),
    ...(options.enableRecording ? { enableRecording: true } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  })
}

export function getBrowser(sessionId: string): Promise<BrowserSessionInfo> {
  return call<BrowserSessionInfo>('GET', `/browsers/${sessionId}`)
}

/**
 * Stops a hosted browser.
 *
 * `browser.close()` on the Playwright side only drops our connection; the
 * session stays alive and billing until its own timeout expires. Everything
 * that opens a session must reach this, including on the error path.
 */
export function stopBrowser(sessionId: string): Promise<BrowserSessionInfo> {
  return call<BrowserSessionInfo>('PATCH', `/browsers/${sessionId}`, { action: 'stop' }, 20_000)
}

export function listBrowsers(): Promise<{ items?: BrowserSessionInfo[] }> {
  return call<{ items?: BrowserSessionInfo[] }>('GET', '/browsers')
}

export interface ProfileInfo {
  id: string
  userId: string | null
  name: string | null
  lastUsedAt: string | null
  cookieDomains: string[] | null
}

/**
 * A profile is where a login lives between runs.
 *
 * `userId` is our own user id, passed through so a profile can be traced back
 * to a person from their dashboard without a lookup table.
 */
export function createProfile(params: { name: string; userId: string }): Promise<ProfileInfo> {
  return call<ProfileInfo>('POST', '/profiles', params)
}

export function getProfile(profileId: string): Promise<ProfileInfo> {
  return call<ProfileInfo>('GET', `/profiles/${profileId}`)
}

export function deleteProfile(profileId: string): Promise<unknown> {
  return call<unknown>('DELETE', `/profiles/${profileId}`)
}

export const browserUse = {
  createBrowser,
  getBrowser,
  stopBrowser,
  listBrowsers,
  createProfile,
  getProfile,
  deleteProfile,
}
