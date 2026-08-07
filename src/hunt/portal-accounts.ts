import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { and, eq } from 'drizzle-orm'
import type { Page } from 'playwright-core'
import { db } from '../db/client.js'
import { portalAccounts } from '../db/schema.js'
import { badRequest, notFound } from '../lib/errors.js'
import { decryptCredential, encryptCredential, generatePortalPassword } from '../lib/credential-vault.js'
import { downloadObject } from '../lib/storage.js'
import { launchAutomationBrowser } from './browser.js'
import { loadPortalProfile } from './portal-profile.js'

interface PasswordCredential {
  kind: 'password'
  email: string
  password: string
}

async function fillVisible(page: Page, label: RegExp, value: string): Promise<boolean> {
  if (!value) return false
  const control = page.getByLabel(label).first()
  if (await control.count() === 0 || !(await control.isVisible())) return false
  await control.fill(value)
  return true
}

async function storeAccount(params: {
  userId: string
  portalId: string
  email: string
  encryptedCredentials?: string | null
  status: 'absent' | 'provisioning' | 'pending_verification' | 'ready' | 'blocked' | 'failed'
  actionRequired?: string | null
}) {
  const [row] = await db
    .insert(portalAccounts)
    .values(params)
    .onConflictDoUpdate({
      target: [portalAccounts.userId, portalAccounts.portalId],
      set: {
        email: params.email,
        encryptedCredentials: params.encryptedCredentials,
        status: params.status,
        actionRequired: params.actionRequired,
        updatedAt: new Date(),
      },
    })
    .returning()
  if (!row) throw new Error('Could not store portal account')
  return row
}

export async function listPortalAccounts(userId: string) {
  const rows = await db.select().from(portalAccounts).where(eq(portalAccounts.userId, userId))
  return rows.map((row) => ({
    id: row.id,
    portalId: row.portalId,
    email: row.email,
    status: row.status,
    actionRequired: row.actionRequired,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    profileSyncedAt: row.profileSyncedAt?.toISOString() ?? null,
  }))
}

export async function saveExistingPortalAccount(
  userId: string,
  portalId: string,
  email: string,
  password: string,
) {
  if (portalId !== 'wellfound') {
    throw badRequest('Password login is not supported for this portal.')
  }
  const encryptedCredentials = encryptCredential<PasswordCredential>({ kind: 'password', email, password })
  return storeAccount({
    userId,
    portalId,
    email,
    encryptedCredentials,
    status: 'ready',
    actionRequired: null,
  })
}

export async function provisionPortalAccount(userId: string, portalId: string) {
  const profile = await loadPortalProfile(userId)
  const [existing] = await db
    .select()
    .from(portalAccounts)
    .where(and(eq(portalAccounts.userId, userId), eq(portalAccounts.portalId, portalId)))
    .limit(1)
  if (existing?.status === 'ready' || existing?.status === 'pending_verification') return existing

  if (portalId === 'instahyre') {
    return storeAccount({
      userId,
      portalId,
      email: profile.email,
      status: 'pending_verification',
      actionRequired: 'Complete Google or LinkedIn OAuth at https://www.instahyre.com/candidates/register/.',
    })
  }
  if (portalId !== 'wellfound') {
    throw badRequest('This source uses employer application forms and does not need a portal account.')
  }

  const password = generatePortalPassword()
  const encryptedCredentials = encryptCredential<PasswordCredential>({
    kind: 'password',
    email: profile.email,
    password,
  })
  await storeAccount({
    userId,
    portalId,
    email: profile.email,
    encryptedCredentials,
    status: 'provisioning',
    actionRequired: null,
  })

  const browser = await launchAutomationBrowser()
  try {
    const page = await browser.newPage()
    await page.goto('https://wellfound.com/jobs/signup', { waitUntil: 'domcontentloaded' })
    await page.getByLabel('Full name').fill(profile.fullName)
    await page.getByLabel('Email').fill(profile.email)
    await page.getByLabel('Password').fill(password)
    await page.getByRole('button', { name: 'Sign Up', exact: true }).click()
    await page.waitForLoadState('domcontentloaded').catch(() => undefined)
    const body = (await page.locator('body').innerText()).toLowerCase()
    const blocked = /captcha|unusual activity|access denied/.test(body)
    return storeAccount({
      userId,
      portalId,
      email: profile.email,
      encryptedCredentials,
      status: blocked ? 'blocked' : 'pending_verification',
      actionRequired: blocked
        ? 'Wellfound requested a CAPTCHA. Complete signup manually.'
        : 'Open the Wellfound verification email and confirm the account.',
    })
  } catch (error) {
    await storeAccount({
      userId,
      portalId,
      email: profile.email,
      encryptedCredentials,
      status: 'failed',
      actionRequired: error instanceof Error ? error.message : String(error),
    })
    throw error
  } finally {
    await browser.close()
  }
}

export async function syncPortalProfile(userId: string, portalId: string) {
  const profile = await loadPortalProfile(userId)
  const [account] = await db
    .select()
    .from(portalAccounts)
    .where(and(eq(portalAccounts.userId, userId), eq(portalAccounts.portalId, portalId)))
    .limit(1)
  if (!account) throw notFound('Portal account not found')
  if (portalId !== 'wellfound') {
    throw badRequest('This portal profile requires its OAuth flow to be completed manually.')
  }
  if (!account.encryptedCredentials) throw badRequest('Portal credentials are missing.')
  const credential = decryptCredential<PasswordCredential>(account.encryptedCredentials)

  const browser = await launchAutomationBrowser()
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'huntly-profile-'))
  try {
    const resumePath = path.join(scratch, profile.baseResume.fileName)
    await writeFile(resumePath, await downloadObject(profile.baseResume.storagePath))
    let photoPath: string | null = null
    if (profile.photoStoragePath) {
      photoPath = path.join(scratch, path.basename(profile.photoFileName ?? 'profile-photo.jpg'))
      await writeFile(photoPath, await downloadObject(profile.photoStoragePath))
    }

    const page = await browser.newPage()
    await page.goto('https://wellfound.com/login', { waitUntil: 'domcontentloaded' })
    await fillVisible(page, /email/i, credential.email)
    await fillVisible(page, /password/i, credential.password)
    const login = page.getByRole('button', { name: /log in|sign in/i }).first()
    if (await login.count()) await login.click()
    await page.waitForLoadState('domcontentloaded').catch(() => undefined)
    await page.goto('https://wellfound.com/profile/edit', { waitUntil: 'domcontentloaded' })

    await fillVisible(page, /name/i, profile.fullName)
    await fillVisible(page, /headline|title/i, profile.headline)
    await fillVisible(page, /location|city/i, [profile.address.city, profile.address.country].filter(Boolean).join(', '))
    await fillVisible(page, /linkedin/i, profile.links.linkedin)
    await fillVisible(page, /github/i, profile.links.github)
    await fillVisible(page, /portfolio|website/i, profile.links.portfolio)

    const resumeInput = page.getByLabel(/resume/i).first()
    if (await resumeInput.count()) await resumeInput.setInputFiles(resumePath)
    if (photoPath) {
      const photoInput = page.getByLabel(/photo|avatar/i).first()
      if (await photoInput.count()) await photoInput.setInputFiles(photoPath)
    }
    const save = page.getByRole('button', { name: /save|update/i }).first()
    if (await save.count()) await save.click()

    const [updated] = await db
      .update(portalAccounts)
      .set({ status: 'ready', profileSyncedAt: new Date(), lastVerifiedAt: new Date(), actionRequired: null, updatedAt: new Date() })
      .where(eq(portalAccounts.id, account.id))
      .returning()
    return updated ?? account
  } finally {
    await rm(scratch, { recursive: true, force: true })
    await browser.close()
  }
}
