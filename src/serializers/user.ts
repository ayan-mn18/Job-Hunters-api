import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { huntSpecs, kits, resumes, userPortals, type User } from '../db/schema.js'
import { toPeriodLabel } from '../lib/time.js'
import type { Employment, Kit } from '../db/schema.js'

/**
 * These functions exist to produce exactly the JSON the React app already
 * renders. `Job-Hunters-UI/src/data/mock.ts` and `src/auth/context.ts` are the
 * specification; if a field name here looks odd, it is because it matches the
 * UI rather than the database.
 */

/** Mirrors `KitDraft` in `Job-Hunters-UI/src/auth/context.ts`, exactly. */
export interface KitDraftDto {
  roles: string
  locations: string
  companies: string
  dailyTarget: number
  portals: string[]
  phone: string
  city: string
  noticePeriod: string
  resumeName: string
}

/** Mirrors `User` in the UI, with `id` added. */
export interface UserDto {
  id: string
  name: string
  email: string
  avatar: string
  onboarded: boolean
  kit: Partial<KitDraftDto>
  joinedAt: string
}

/**
 * The wizard's flat `KitDraft` is stored across four tables — the comma-joined
 * strings are a presentation format, not a storage format. This puts it back
 * together for the client.
 */
export async function buildKitDraft(userId: string): Promise<Partial<KitDraftDto>> {
  const [kitRow] = await db.select().from(kits).where(eq(kits.userId, userId)).limit(1)
  const [specRow] = await db.select().from(huntSpecs).where(eq(huntSpecs.userId, userId)).limit(1)

  const connectedPortals = await db
    .select({ portalId: userPortals.portalId })
    .from(userPortals)
    .where(and(eq(userPortals.userId, userId), eq(userPortals.connected, true)))

  const [baseResume] = await db
    .select({ fileName: resumes.fileName })
    .from(resumes)
    .where(and(eq(resumes.userId, userId), eq(resumes.isBase, true)))
    .orderBy(desc(resumes.createdAt))
    .limit(1)

  const draft: Partial<KitDraftDto> = {}

  if (specRow) {
    draft.roles = specRow.roles.join(', ')
    draft.locations = specRow.locations.join(', ')
    draft.companies = specRow.dreamCompanies.join(', ')
    draft.dailyTarget = specRow.dailyTarget
  }
  draft.portals = connectedPortals.map((row) => row.portalId)

  if (kitRow) {
    draft.phone = kitRow.phone ?? ''
    draft.city = kitRow.city ?? ''
    draft.noticePeriod = kitRow.noticePeriod ?? ''
  }
  draft.resumeName = baseResume?.fileName ?? ''

  return draft
}

export function serializeUser(user: User, kit: Partial<KitDraftDto>): UserDto {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatar: user.avatar,
    onboarded: user.onboarded,
    kit,
    joinedAt: user.joinedAt.toISOString(),
  }
}

export async function serializeUserWithKit(user: User): Promise<UserDto> {
  return serializeUser(user, await buildKitDraft(user.id))
}

/* ------------------------------------------------------------- the full kit */

/** The Kit screen's form. Every field a job portal has ever asked for. */
export interface FullKitDto {
  fullName: string | null
  pronouns: string | null
  email: string | null
  phone: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  state: string | null
  postalCode: string | null
  country: string | null
  linkedinUrl: string | null
  githubUrl: string | null
  portfolioUrl: string | null
  headline: string | null
  noticePeriod: string | null
  totalExperience: string | null
  currentCtc: string | null
  expectedCtc: string | null
  workAuthorization: string | null
  willingToRelocate: string | null
  skills: string[]
  photoFileName: string | null
  photoUrl: string | null
  /** 0–100, drives the "92% complete" chip. */
  completeness: number
  updatedAt: string | null
}

export interface EmploymentDto {
  id: string
  emoji: string
  role: string
  company: string
  startedOn: string | null
  endedOn: string | null
  isCurrent: boolean
  /** Pre-formatted, e.g. "Jan 2024 — now". The UI renders this directly. */
  period: string
  blurb: string | null
  sortOrder: number
}

/**
 * Which fields count toward "complete". Chosen as the ones a portal form will
 * actually block on — pronouns and a portfolio URL are nice to have and are
 * deliberately left out so nobody is nagged to 100% over optional fields.
 */
const COMPLETENESS_FIELDS: (keyof Kit)[] = [
  'fullName',
  'email',
  'phone',
  'addressLine1',
  'city',
  'state',
  'postalCode',
  'country',
  'linkedinUrl',
  'noticePeriod',
  'totalExperience',
  'currentCtc',
  'expectedCtc',
  'workAuthorization',
  'willingToRelocate',
]

export function kitCompleteness(kit: Kit | undefined): number {
  if (!kit) return 0
  let filled = 0
  for (const field of COMPLETENESS_FIELDS) {
    const value = kit[field]
    if (typeof value === 'string' && value.trim().length > 0) filled += 1
  }
  // Skills count as one more field, so a resume with no skills parsed out of
  // it cannot show as fully complete.
  const total = COMPLETENESS_FIELDS.length + 1
  if (kit.skills.length > 0) filled += 1
  return Math.round((filled / total) * 100)
}

export function serializeKit(kit: Kit | undefined): FullKitDto {
  return {
    fullName: kit?.fullName ?? null,
    pronouns: kit?.pronouns ?? null,
    email: kit?.email ?? null,
    phone: kit?.phone ?? null,
    addressLine1: kit?.addressLine1 ?? null,
    addressLine2: kit?.addressLine2 ?? null,
    city: kit?.city ?? null,
    state: kit?.state ?? null,
    postalCode: kit?.postalCode ?? null,
    country: kit?.country ?? null,
    linkedinUrl: kit?.linkedinUrl ?? null,
    githubUrl: kit?.githubUrl ?? null,
    portfolioUrl: kit?.portfolioUrl ?? null,
    headline: kit?.headline ?? null,
    noticePeriod: kit?.noticePeriod ?? null,
    totalExperience: kit?.totalExperience ?? null,
    currentCtc: kit?.currentCtc ?? null,
    expectedCtc: kit?.expectedCtc ?? null,
    workAuthorization: kit?.workAuthorization ?? null,
    willingToRelocate: kit?.willingToRelocate ?? null,
    skills: kit?.skills ?? [],
    photoFileName: kit?.photoFileName ?? null,
    photoUrl: null,
    completeness: kitCompleteness(kit),
    updatedAt: kit?.updatedAt?.toISOString() ?? null,
  }
}

export function serializeEmployment(row: Employment): EmploymentDto {
  return {
    id: row.id,
    emoji: row.emoji,
    role: row.role,
    company: row.company,
    startedOn: row.startedOn,
    endedOn: row.endedOn,
    isCurrent: row.isCurrent,
    period: toPeriodLabel(row),
    blurb: row.blurb,
    sortOrder: row.sortOrder,
  }
}
