import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { huntSpecs, kits, userPortals, users, type User } from '../db/schema.js'
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
  maxYearsExperience: number
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
  // This is on the critical path of sign-in, sign-up and every token refresh.
  // The database is hosted remotely, so four parallel reads still consume a
  // connection each and queue behind the pool under real traffic. Fold the
  // independent reads into one indexed query and pay one network round trip.
  const [row] = await db
    .select({
      roles: huntSpecs.roles,
      locations: huntSpecs.locations,
      companies: huntSpecs.dreamCompanies,
      dailyTarget: huntSpecs.dailyTarget,
      phone: kits.phone,
      city: kits.city,
      noticePeriod: kits.noticePeriod,
      maxYearsExperience: kits.maxYearsExperience,
      portals: sql<string[]>`coalesce(
        array_agg(distinct ${userPortals.portalId})
          filter (where ${userPortals.portalId} is not null),
        '{}'
      )`,
      resumeName: sql<string | null>`(
        select resume.file_name
        from resumes as resume
        where resume.user_id = ${users.id}
          and resume.is_base = true
        order by resume.created_at desc
        limit 1
      )`,
    })
    .from(users)
    .leftJoin(kits, eq(kits.userId, users.id))
    .leftJoin(huntSpecs, eq(huntSpecs.userId, users.id))
    .leftJoin(
      userPortals,
      and(
        eq(userPortals.userId, users.id),
        eq(userPortals.connected, true),
      ),
    )
    .where(eq(users.id, userId))
    .groupBy(
      users.id,
      huntSpecs.roles,
      huntSpecs.locations,
      huntSpecs.dreamCompanies,
      huntSpecs.dailyTarget,
      kits.phone,
      kits.city,
      kits.noticePeriod,
      kits.maxYearsExperience,
    )

  const draft: Partial<KitDraftDto> = {}

  if (row?.roles) {
    draft.roles = row.roles.join(', ')
    draft.locations = row.locations?.join(', ') ?? ''
    draft.companies = row.companies?.join(', ') ?? ''
    draft.dailyTarget = row.dailyTarget ?? undefined
  }
  draft.portals = row?.portals ?? []

  if (row) {
    draft.phone = row.phone ?? ''
    draft.city = row.city ?? ''
    draft.noticePeriod = row.noticePeriod ?? ''
    draft.maxYearsExperience = row.maxYearsExperience ?? 5
  }
  draft.resumeName = row?.resumeName ?? ''

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
  maxYearsExperience: number
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
    maxYearsExperience: kit?.maxYearsExperience ?? 5,
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
