import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { kits, personaSlots, resumes, huntSpecs, type PersonaSlot } from '../db/schema.js'
import { readParsedResume, type ParsedResume } from '../services/resume-parser.js'
import { CONFIDENT_ENOUGH, type SlotSource } from './slots.js'

/**
 * Reading and writing the persona.
 *
 * The important behaviour here is seeding: most of what the old wizard asked
 * for is already in the resume the user just uploaded. Reading it first means
 * the intake starts with most slots already answered, and only has to ask
 * about the gaps.
 */

export interface Persona {
  slots: Map<string, { value: unknown; confidence: number; source: SlotSource }>
}

export async function loadPersona(userId: string): Promise<Persona> {
  const rows = await db.select().from(personaSlots).where(eq(personaSlots.userId, userId))
  return {
    slots: new Map(
      rows.map((row) => [
        row.slot,
        { value: row.value, confidence: Number(row.confidence), source: row.source as SlotSource },
      ]),
    ),
  }
}

export function slotValue<T>(persona: Persona, slot: string): T | null {
  const entry = persona.slots.get(slot)
  return entry ? (entry.value as T) : null
}

export function isKnown(persona: Persona, slot: string): boolean {
  const entry = persona.slots.get(slot)
  return Boolean(entry && entry.confidence >= CONFIDENT_ENOUGH)
}

export async function setSlot(
  userId: string,
  slot: string,
  value: unknown,
  confidence: number,
  source: SlotSource,
): Promise<PersonaSlot> {
  const [row] = await db
    .insert(personaSlots)
    .values({ userId, slot, value, confidence: String(confidence), source })
    .onConflictDoUpdate({
      target: [personaSlots.userId, personaSlots.slot],
      set: { value, confidence: String(confidence), source, updatedAt: new Date() },
    })
    .returning()
  if (!row) throw new Error(`Could not store persona slot ${slot}`)
  return row
}

/* ------------------------------------------------------------------ seeding */

const SENIORITY_FROM_TITLE: Array<[RegExp, string]> = [
  [/\b(?:staff|principal|architect|distinguished)\b/i, 'staff'],
  [/\b(?:senior|sr\.?|lead)\b/i, 'senior'],
  [/\b(?:junior|jr\.?|intern|trainee|graduate|associate)\b/i, 'junior'],
]

/** Seniority from titles first, years as the fallback. */
export function inferSeniority(titles: string[], years: number | null): { value: string; confidence: number } | null {
  for (const title of titles) {
    for (const [pattern, level] of SENIORITY_FROM_TITLE) {
      // A title is the person's own word for their level, so it beats an
      // arithmetic guess from dates.
      if (pattern.test(title)) return { value: level, confidence: 0.85 }
    }
  }
  if (years === null) return null
  if (years < 2) return { value: 'junior', confidence: 0.7 }
  if (years < 5) return { value: 'mid', confidence: 0.7 }
  if (years < 9) return { value: 'senior', confidence: 0.7 }
  return { value: 'staff', confidence: 0.65 }
}

/**
 * Target titles from what the person has actually done.
 *
 * Confidence is deliberately moderate: the last job title says what they *were*
 * doing, which is a good guess at what they want next and not the same thing.
 * A moderate score keeps the slot eligible to be asked about if it turns out
 * to matter.
 */
export function inferTargetTitles(titles: string[]): { value: string[]; confidence: number } | null {
  const cleaned = titles
    .map((title) => title.trim().toLowerCase())
    .filter((title) => title.length > 2)
    .slice(0, 3)
  if (cleaned.length === 0) return null
  return { value: cleaned, confidence: 0.55 }
}

export interface SeedResult {
  seeded: string[]
  skipped: string[]
}

/**
 * Fills the persona from everything already known — the parsed resume, the
 * kit, and any hunt spec the user has saved — before a single question is
 * asked.
 */
export async function seedPersonaFromProfile(userId: string): Promise<SeedResult> {
  const [[kit], [baseResume], [spec]] = await Promise.all([
    db.select().from(kits).where(eq(kits.userId, userId)).limit(1),
    db
      .select()
      .from(resumes)
      .where(and(eq(resumes.userId, userId), eq(resumes.isBase, true)))
      .limit(1),
    db.select().from(huntSpecs).where(eq(huntSpecs.userId, userId)).limit(1),
  ])

  const parsed: ParsedResume | null = readParsedResume(baseResume?.parsedProfile)
  const seeded: string[] = []
  const skipped: string[] = []

  const record = async (
    slot: string,
    value: unknown,
    confidence: number,
    source: SlotSource,
  ): Promise<void> => {
    await setSlot(userId, slot, value, confidence, source)
    seeded.push(slot)
  }

  // An explicit hunt spec is the user's own words and outranks anything
  // inferred from a document.
  if (spec && spec.roles.length > 0) {
    await record('target_titles', spec.roles, 0.9, 'asked')
  } else {
    const titles = parsed ? inferTargetTitles(parsed.titles) : null
    if (titles) await record('target_titles', titles.value, titles.confidence, 'resume')
    else skipped.push('target_titles')
  }

  if (spec && spec.locations.length > 0) {
    await record('markets', spec.locations, 0.9, 'asked')
  } else if (kit?.city || kit?.country) {
    const home = [kit.city, kit.country].filter(Boolean).join(', ')
    // Where they live is where they can work, but it is not a statement of
    // where they *want* to work — low confidence, so it stays askable.
    await record('markets', [home], 0.45, 'inferred')
  } else if (parsed?.contact.city) {
    await record('markets', [parsed.contact.city], 0.4, 'resume')
  } else {
    skipped.push('markets')
  }

  const seniority = parsed ? inferSeniority(parsed.titles, parsed.yearsExperience) : null
  if (seniority) await record('seniority', seniority.value, seniority.confidence, 'resume')
  else skipped.push('seniority')

  const skills = [...new Set([...(kit?.skills ?? []), ...(parsed?.skills ?? [])])]
  if (skills.length > 0) {
    // High confidence: these are demonstrably the person's skills. Whether they
    // *want* to keep using them is the question the intake may still ask.
    await record('must_have_stack', skills.slice(0, 20), 0.8, 'resume')
  } else {
    skipped.push('must_have_stack')
  }

  if (spec && spec.dealBreakers.length > 0) {
    await record('avoid', spec.dealBreakers, 0.8, 'asked')
  } else {
    skipped.push('avoid')
  }

  // Form-only values, copied across so the first application does not have to
  // ask for what the kit already holds.
  if (kit?.phone) await record('phone', kit.phone, 1, 'asked')
  if (kit?.noticePeriod) await record('notice_period', kit.noticePeriod, 1, 'asked')
  if (kit?.currentCtc) await record('current_ctc', kit.currentCtc, 1, 'asked')
  if (kit?.expectedCtc) await record('expected_ctc', kit.expectedCtc, 1, 'asked')
  if (kit?.workAuthorization) await record('work_authorization', kit.workAuthorization, 1, 'asked')

  return { seeded, skipped }
}
