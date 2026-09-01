import type { BrowserContext, Page } from 'playwright-core'
import { logger } from '../lib/logger.js'
import { INVITE_LIMIT } from './compose.js'
import type { SendableMessage } from './sequence.js'

/**
 * Actually sending, in the user's own LinkedIn session.
 *
 * Everything here is deliberately slow and literal. It clicks what a person
 * would click, in the order a person would click it, and it gives up rather
 * than trying a second route when the first is not there — a fallback selector
 * chain is how automation ends up clicking something nobody intended.
 *
 * Detection of a checkpoint is the important part. If LinkedIn is asking
 * whether the user is human, the correct response is to stop immediately, not
 * to try again more carefully.
 */

const CHECKPOINT = /checkpoint|challenge|security\s+verification|unusual\s+activity|verify\s+your\s+identity/i

export class CheckpointError extends Error {
  constructor(where: string) {
    super(`LinkedIn showed a verification page (${where}).`)
    this.name = 'CheckpointError'
  }
}

async function assertNoCheckpoint(page: Page, where: string): Promise<void> {
  if (CHECKPOINT.test(page.url())) throw new CheckpointError(where)
  const body = await page.locator('body').innerText().catch(() => '')
  if (CHECKPOINT.test(body)) throw new CheckpointError(where)
}

/**
 * A pause that looks like reading.
 *
 * Not decoration: a page opened and acted on inside 300 ms is a machine, and
 * the whole point of the pacing elsewhere is undone by acting instantly once
 * we are here.
 */
async function dwell(page: Page, min = 1_800, max = 4_500): Promise<void> {
  await page.waitForTimeout(min + Math.random() * (max - min))
}

export interface SendResult {
  ok: boolean
  error?: string
}

/** Sends a connection invitation with a note. */
export async function sendInvite(
  context: BrowserContext,
  message: SendableMessage,
): Promise<SendResult> {
  const page = await context.newPage()
  try {
    await page.goto(message.profileUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await assertNoCheckpoint(page, 'profile')
    await dwell(page)

    const connect = page.getByRole('button', { name: /^connect$/i }).first()
    if ((await connect.count()) === 0) {
      // Often behind a "More" menu on profiles LinkedIn considers distant.
      const more = page.getByRole('button', { name: /^more/i }).first()
      if ((await more.count()) === 0) return { ok: false, error: 'No Connect button on this profile.' }
      await more.click()
      await dwell(page, 600, 1_400)
    }

    const connectNow = page.getByRole('button', { name: /^connect$/i }).first()
    if ((await connectNow.count()) === 0) return { ok: false, error: 'Connect is not available here.' }
    await connectNow.click()
    await dwell(page, 900, 2_000)

    const addNote = page.getByRole('button', { name: /add a note/i }).first()
    if ((await addNote.count()) > 0) {
      await addNote.click()
      const note = page.locator('textarea#custom-message, textarea[name="message"]').first()
      if ((await note.count()) > 0) {
        await note.fill(message.body.slice(0, INVITE_LIMIT))
        await dwell(page, 800, 1_800)
      }
    }

    const send = page.getByRole('button', { name: /^(send|send invitation|send now)$/i }).first()
    if ((await send.count()) === 0) return { ok: false, error: 'No send control on the invite dialog.' }
    await send.click()
    await page.waitForLoadState('domcontentloaded').catch(() => undefined)
    await assertNoCheckpoint(page, 'after send')

    return { ok: true }
  } catch (error) {
    if (error instanceof CheckpointError) throw error
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    await page.close().catch(() => undefined)
  }
}

/** Sends a message to someone already connected. */
export async function sendMessage(
  context: BrowserContext,
  message: SendableMessage,
): Promise<SendResult> {
  const page = await context.newPage()
  try {
    await page.goto(message.profileUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await assertNoCheckpoint(page, 'profile')
    await dwell(page)

    const messageButton = page.getByRole('button', { name: /^message/i }).first()
    if ((await messageButton.count()) === 0) {
      return { ok: false, error: 'No Message button — not connected, or messaging is restricted.' }
    }
    await messageButton.click()
    await dwell(page, 900, 2_000)

    const box = page.locator('div.msg-form__contenteditable, div[role="textbox"]').first()
    if ((await box.count()) === 0) return { ok: false, error: 'Message box did not open.' }
    await box.click()
    // Typed rather than pasted: LinkedIn's composer only enables Send once it
    // has seen input events, and a `fill` leaves the button disabled.
    await box.type(message.body, { delay: 12 })
    await dwell(page, 800, 1_600)

    const send = page.getByRole('button', { name: /^send$/i }).first()
    if ((await send.count()) === 0) return { ok: false, error: 'No send control on the composer.' }
    await send.click()
    await page.waitForTimeout(1_500)
    await assertNoCheckpoint(page, 'after message')

    return { ok: true }
  } catch (error) {
    if (error instanceof CheckpointError) throw error
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    await page.close().catch(() => undefined)
  }
}

/** Withdraws invitations nobody accepted, protecting the acceptance ratio. */
export async function withdrawInvite(
  context: BrowserContext,
  profileUrl: string,
): Promise<SendResult> {
  const page = await context.newPage()
  try {
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await assertNoCheckpoint(page, 'profile')
    await dwell(page, 1_200, 2_500)

    const pending = page.getByRole('button', { name: /pending/i }).first()
    if ((await pending.count()) === 0) return { ok: false, error: 'No pending invitation to withdraw.' }
    await pending.click()
    await dwell(page, 700, 1_500)

    const withdraw = page.getByRole('button', { name: /^withdraw$/i }).first()
    if ((await withdraw.count()) === 0) return { ok: false, error: 'No withdraw control.' }
    await withdraw.click()
    await page.waitForTimeout(1_200)
    return { ok: true }
  } catch (error) {
    if (error instanceof CheckpointError) throw error
    logger.debug({ err: error, profileUrl }, 'withdraw failed')
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    await page.close().catch(() => undefined)
  }
}
