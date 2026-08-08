import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import {
  employments,
  huntSpecs,
  kits,
  onboardingSubmissions,
  portals,
  userPortals,
  users,
  type Employment,
  type Kit,
} from '../../db/schema.js'
import { notFound } from '../../lib/errors.js'
import { recordActivity } from '../../services/activity.js'
import type { ParsedResume } from '../../services/resume-parser.js'
import type {
  CompleteOnboardingInput,
  EmploymentInput,
  EmploymentUpdateInput,
  UpdateKitInput,
  UpdateProfileInput,
} from './schemas.js'

/** "React, TypeScript,  Node" → ["React", "TypeScript", "Node"]. */
export function splitList(value: string | undefined | null): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

/* --------------------------------------------------------------- kit reads */

export async function getKit(userId: string): Promise<Kit | undefined> {
  const [row] = await db.select().from(kits).where(eq(kits.userId, userId)).limit(1)
  return row
}

export async function getEmployments(userId: string): Promise<Employment[]> {
  return db
    .select()
    .from(employments)
    .where(eq(employments.userId, userId))
    .orderBy(asc(employments.sortOrder), asc(employments.createdAt))
}

/* -------------------------------------------------------------- kit writes */

/**
 * Upsert rather than update. Signup creates the row, but a user restored from
 * a partial import or created before that behaviour existed would otherwise
 * silently save nothing.
 */
export async function updateKit(userId: string, input: UpdateKitInput): Promise<Kit> {
  const patch = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<Kit>

  const [row] = await db
    .insert(kits)
    .values({ userId, ...patch })
    .onConflictDoUpdate({
      target: kits.userId,
      set: { ...patch, updatedAt: new Date() },
    })
    .returning()

  if (!row) throw new Error('Kit upsert returned no row')
  return row
}

export async function updateProfile(userId: string, input: UpdateProfileInput) {
  const patch = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  )
  if (Object.keys(patch).length === 0) {
    const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
    if (!row) throw notFound('User not found')
    return row
  }

  const [row] = await db
    .update(users)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning()

  if (!row) throw notFound('User not found')
  return row
}

/* ------------------------------------------------------------- employments */

export async function createEmployment(
  userId: string,
  input: EmploymentInput,
): Promise<Employment> {
  const [row] = await db
    .insert(employments)
    .values({
      userId,
      emoji: input.emoji ?? '💼',
      role: input.role,
      company: input.company,
      startedOn: input.startedOn ?? null,
      endedOn: input.isCurrent ? null : (input.endedOn ?? null),
      isCurrent: input.isCurrent ?? false,
      periodLabel: input.periodLabel ?? null,
      blurb: input.blurb ?? null,
      sortOrder: input.sortOrder ?? 0,
    })
    .returning()

  if (!row) throw new Error('Employment insert returned no row')
  return row
}

export async function updateEmployment(
  userId: string,
  id: string,
  input: EmploymentUpdateInput,
): Promise<Employment> {
  const patch = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<Employment>

  // "Currently working here" and an end date cannot both be true.
  if (patch.isCurrent === true) patch.endedOn = null

  const [row] = await db
    .update(employments)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(employments.id, id), eq(employments.userId, userId)))
    .returning()

  if (!row) throw notFound('That role is not in your history.')
  return row
}

export async function deleteEmployment(userId: string, id: string): Promise<void> {
  const deleted = await db
    .delete(employments)
    .where(and(eq(employments.id, id), eq(employments.userId, userId)))
    .returning({ id: employments.id })

  if (deleted.length === 0) throw notFound('That role is not in your history.')
}
export interface ResumeAutofillResult {
  kit: Kit
  employments: Employment[]
  roles: string[]
  applied: {
    fields: string[]
    skills: number
    employments: number
  }
}

/** Fill only blank Kit values. Existing user edits always win over parsed data. */
export async function applyResumeAutofill(
  userId: string,
  profile: ParsedResume,
): Promise<ResumeAutofillResult> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(kits).where(eq(kits.userId, userId)).limit(1)
    const suggestedFields: [keyof Kit, string | null | undefined][] = [
      ['fullName', profile.contact.fullName],
      ['email', profile.contact.email],
      ['phone', profile.contact.phone],
      ['city', profile.contact.city],
      ['linkedinUrl', profile.contact.linkedinUrl],
      ['githubUrl', profile.contact.githubUrl],
      ['portfolioUrl', profile.contact.portfolioUrl],
      ['headline', profile.titles[0]],
      [
        'totalExperience',
        profile.yearsExperience === null
          ? null
          : `${profile.yearsExperience} ${profile.yearsExperience === 1 ? 'year' : 'years'}`,
      ],
    ]
    const fillableFields = suggestedFields.filter(([key, value]) => {
      if (!value?.trim()) return false
      const existing = current?.[key]
      return typeof existing !== 'string' || existing.trim().length === 0
    })
    const patch = Object.fromEntries(fillableFields) as Partial<Kit>

    const mergedSkills = [...(current?.skills ?? [])]
    const skillKeys = new Set(mergedSkills.map((skill) => skill.toLowerCase()))
    for (const skill of profile.skills) {
      const key = skill.trim().toLowerCase()
      if (!key || skillKeys.has(key)) continue
      skillKeys.add(key)
      mergedSkills.push(skill.trim())
    }
    const addedSkills = mergedSkills.length - (current?.skills.length ?? 0)
    if (addedSkills > 0) patch.skills = mergedSkills

    const [kit] = await tx
      .insert(kits)
      .values({ userId, ...patch })
      .onConflictDoUpdate({
        target: kits.userId,
        set: { ...patch, updatedAt: new Date() },
      })
      .returning()
    if (!kit) throw new Error('Kit autofill returned no row')

    const existingHistory = await tx
      .select()
      .from(employments)
      .where(eq(employments.userId, userId))
      .orderBy(asc(employments.sortOrder), asc(employments.createdAt))
    const employmentKeys = new Set(
      existingHistory.map((row) => `${row.role.trim().toLowerCase()}\u0000${row.company.trim().toLowerCase()}`),
    )
    const missingEmployments = profile.employments.filter((row) => {
      const key = `${row.role.trim().toLowerCase()}\u0000${row.company.trim().toLowerCase()}`
      if (employmentKeys.has(key)) return false
      employmentKeys.add(key)
      return true
    })

    let insertedHistory: Employment[] = []
    if (missingEmployments.length > 0) {
      insertedHistory = await tx
        .insert(employments)
        .values(
          missingEmployments.map((row, index) => ({
            userId,
            role: row.role.trim(),
            company: row.company.trim(),
            startedOn:
              row.startedOn && /^\d{4}-\d{2}-\d{2}$/.test(row.startedOn) ? row.startedOn : null,
            endedOn:
              !row.isCurrent && row.endedOn && /^\d{4}-\d{2}-\d{2}$/.test(row.endedOn)
                ? row.endedOn
                : null,
            isCurrent: row.isCurrent ?? false,
            blurb: row.blurb?.trim() || null,
            sortOrder: existingHistory.length + index,
          })),
        )
        .returning()
    }

    return {
      kit,
      employments: [...existingHistory, ...insertedHistory],
      roles: profile.titles,
      applied: {
        fields: fillableFields.map(([key]) => key),
        skills: addedSkills,
        employments: insertedHistory.length,
      },
    }
  })
}

/* -------------------------------------------------------------- onboarding */

/**
 * The wizard hands over one flat object; this fans it out into the kit, the
 * hunt spec and the portal connections, keeps the raw payload for the record,
 * and flips `onboarded`. All in one transaction — a half-onboarded account
 * that the UI would bounce back into the wizard is the worst outcome here.
 */
export async function completeOnboarding(userId: string, input: CompleteOnboardingInput) {
  const requestedPortals = input.portals ?? []

  const phone = input.phone?.trim() || null
  const city = input.city?.trim() || null
  const noticePeriod = input.noticePeriod?.trim() || null
  const maxYearsExperience = input.maxYearsExperience

  const knownPortals = requestedPortals.length
    ? await db
        .select({ id: portals.id })
        .from(portals)
        .where(inArray(portals.id, requestedPortals))
    : []
  const knownPortalIds = new Set(knownPortals.map((row) => row.id))

  const user = await db.transaction(async (tx) => {
    await tx
      .insert(kits)
      .values({
        userId,
        phone,
        city,
        noticePeriod,
        ...(maxYearsExperience !== undefined ? { maxYearsExperience } : {}),
      })
      .onConflictDoUpdate({
        target: kits.userId,
        set: {
          // COALESCE on the incoming value: a skipped wizard step must not
          // wipe an answer the user already gave on the Kit screen.
          // The `::text` casts are load-bearing — without them Postgres cannot
          // infer the type of a NULL bind parameter inside coalesce().
          phone: sql`coalesce(${phone}::text, ${kits.phone})`,
          city: sql`coalesce(${city}::text, ${kits.city})`,
          noticePeriod: sql`coalesce(${noticePeriod}::text, ${kits.noticePeriod})`,
          ...(maxYearsExperience !== undefined ? { maxYearsExperience } : {}),
          updatedAt: new Date(),
        },
      })

    const specValues = {
      roles: splitList(input.roles),
      locations: splitList(input.locations),
      dreamCompanies: splitList(input.companies),
      ...(input.dailyTarget !== undefined ? { dailyTarget: input.dailyTarget } : {}),
    }

    await tx
      .insert(huntSpecs)
      .values({ userId, ...specValues })
      .onConflictDoUpdate({
        target: huntSpecs.userId,
        set: { ...specValues, updatedAt: new Date() },
      })

    if (knownPortalIds.size > 0) {
      const now = new Date()
      for (const portalId of knownPortalIds) {
        await tx
          .insert(userPortals)
          .values({ userId, portalId, connected: true, connectedAt: now })
          .onConflictDoUpdate({
            target: [userPortals.userId, userPortals.portalId],
            set: { connected: true, connectedAt: now, updatedAt: now },
          })
      }
    }

    await tx.insert(onboardingSubmissions).values({ userId, payload: input })

    const [row] = await tx
      .update(users)
      .set({ onboarded: true, onboardedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning()

    if (!row) throw notFound('User not found')
    return row
  })

  await recordActivity({
    userId,
    kind: 'onboarding_completed',
    text: 'Setup finished — the first hunt runs tomorrow at 06:00.',
    meta: { portals: [...knownPortalIds] },
  })

  const unknown = requestedPortals.filter((id) => !knownPortalIds.has(id))
  return { user, connectedPortals: [...knownPortalIds], unknownPortals: unknown }
}

export async function getOnboardingSubmissions(userId: string) {
  return db
    .select()
    .from(onboardingSubmissions)
    .where(eq(onboardingSubmissions.userId, userId))
    .orderBy(asc(onboardingSubmissions.completedAt))
}
