import crypto from 'node:crypto'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import { z } from 'zod/v4'
import { db } from '../../db/client.js'
import { fieldAnswers } from '../../db/schema.js'
import { hasModelAccess } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { structured } from '../../model/gateway.js'
import type { PortalProfile } from '../portal-profile.js'

/**
 * Working out what a form field is asking, and what to put in it.
 *
 * Filling a field is trivial. Knowing *which* field is which is the whole
 * problem: every application form invents its own phrasing for the same
 * handful of questions, and there are thousands of forms.
 *
 * Three rungs, cheapest first — and the answer is cached, which is what makes
 * this get better rather than merely work. A strange question any user meets
 * is answered once and answered instantly forever after.
 */

export type Rung = 'recipe' | 'heuristic' | 'cache' | 'model' | 'skipped'

export interface FormField {
  /** The label as the form wrote it. */
  label: string
  /** `text`, `email`, `tel`, `select`, `textarea`, `checkbox`, `radio`, `file`. */
  type: string
  name?: string
  required: boolean
  options?: string[]
}

export interface ResolvedField {
  value: string | null
  via: Rung
  /** Set when the field must not be answered without the user. */
  blocked?: 'sensitive_field' | 'unknown_field'
}

/**
 * Questions we will never answer on someone's behalf.
 *
 * Not a capability gap — a decision. Getting a demographic answer, a visa
 * status or a salary expectation wrong on someone's application is not a bug
 * you can apologise for afterwards, and a plausible guess is worse than an
 * honest stop.
 */
const NEVER_AUTO: Array<[RegExp, string]> = [
  // Word-stem matches, not whole words: "disabilit" must catch "disability"
  // and "disabilities", and a trailing \b makes it match neither. Getting this
  // wrong means silently answering a demographic question on someone's behalf.
  [
    /\b(?:gender|sexual\s+orientation|race|ethnicit\w*|hispanic|latino|veteran|disabilit\w*|lgbt\w*|pronouns)\b/i,
    'demographic question',
  ],
  // Both word orders: "salary expectation" and "expected salary" are the same
  // question, and forms use each about equally.
  [
    /\b(?:salary|compensation|ctc|remuneration|pay)\b[\s\S]{0,20}\b(?:expect\w*|desired|require\w*|range|ask)\b/i,
    'salary expectation',
  ],
  [
    /\b(?:expect\w*|desired|minimum|preferred)\b[\s\S]{0,20}\b(?:salary|compensation|ctc|remuneration|pay)\b/i,
    'salary expectation',
  ],
  [
    /\b(?:sponsorship|visa\b|work\s+authori[sz]ation|right\s+to\s+work|legally\s+authorized|require\s+sponsorship)/i,
    'visa or work authorisation',
  ],
  [/\b(?:criminal|conviction|convicted|background\s+check|felony)\b/i, 'background question'],
  // Legal questions about existing obligations. Seen on a live GitLab form as
  // "Are you subject to any employment agreements and/or restrictive covenants
  // with your current employer?" — which matched the current-employer
  // heuristic and would have been answered with a company name.
  [
    /\b(?:non-?compete|restrictive\s+covenant|employment\s+agreement|notice\s+obligation|garden\s+leave)/i,
    'a legal question about your existing obligations',
  ],
  [/\b(?:reference|referee)s?\b[\s\S]{0,12}\b(?:name|contact|email|phone|detail)/i, 'a reference’s contact details'],
]

/**
 * Answer values that give a demographic question away.
 *
 * Some forms give a radio group no legend at all, so its label ends up being
 * the first option — "Male" — which matches no question pattern. Ashby does
 * exactly this. Judging the group by what it is *offering* catches those, and
 * generalises across portals in a way that chasing each one's markup does not.
 */
const DEMOGRAPHIC_OPTIONS =
  /^(?:male|female|non-?binary|prefer\s+not|decline\s+to|hispanic|latino|asian|black|white|native\s+hawaiian|american\s+indian|two\s+or\s+more\s+races|i\s+identify\s+as|i\s+don'?t\s+wish)/i

export function sensitiveReason(label: string, options?: string[]): string | null {
  for (const [pattern, reason] of NEVER_AUTO) {
    if (pattern.test(label)) return reason
  }
  if (options && options.length >= 2) {
    const demographic = options.filter((option) => DEMOGRAPHIC_OPTIONS.test(option.trim()))
    // Two or more give-away options is a demographic question whatever it is
    // labelled; one could be a coincidence.
    if (demographic.length >= 2) return 'demographic question'
  }
  return null
}

/**
 * Strips the decoration forms put around a label.
 *
 * Required markers are not always an asterisk: Lever renders a heavy asterisk
 * (U+2731), others use a dagger or the word itself. Matching the raw label
 * meant an anchored pattern like /^(?:full\s*)?name$/ failed on "Full name✱",
 * so a Lever application could not fill the candidate's own name.
 */
export function normaliseLabel(label: string): string {
  return label
    .replace(/[\u2731\u066D\uFF0A*†‡]/g, '')
    .replace(/\((?:required|optional)\)/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/[:\s]+$/, '')
    .trim()
}

/** Stable across cosmetic label changes, distinct across real ones. */
export function fieldSignature(field: FormField): string {
  const canonical = [
    normaliseLabel(field.label).toLowerCase(),
    field.type.toLowerCase(),
    (field.name ?? '').toLowerCase(),
  ].join('|')
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 20)
}

/* ------------------------------------------------------------ rung 2: rules */

/**
 * The label patterns that cover most of every form, mapped to the kit.
 *
 * This was the whole of the old implementation. It stays, because it is free
 * and it answers the majority of fields — it is simply no longer the only
 * thing between us and a stuck application.
 */
const HEURISTICS: Array<[RegExp, keyof PortalProfile | string]> = [
  [/^(?:full\s*)?name$|\byour name\b/i, 'fullName'],
  [/\bfirst\s*name\b|\bgiven name\b/i, 'firstName'],
  [/\blast\s*name\b|\bsurname\b|\bfamily name\b/i, 'lastName'],
  [/\be-?mail\b/i, 'email'],
  [/\b(?:phone|mobile|contact number)\b/i, 'phone'],
  [/\blinked-?in\b/i, 'linkedin'],
  [/\bgithub\b/i, 'github'],
  [/\b(?:portfolio|website|personal site)\b/i, 'portfolio'],
  [/\b(?:address|street)\b/i, 'addressLine1'],
  [/\bcity\b|\btown\b/i, 'city'],
  [/\b(?:state|province|region)\b/i, 'region'],
  [/\b(?:postal|zip|pin)\s*code\b/i, 'postalCode'],
  [/\bcountry\b/i, 'country'],
  [/\b(?:notice period|availability|start date|when can you start)\b/i, 'noticePeriod'],
  [/\b(?:current|present)\s+(?:company|employer)\b/i, 'currentCompany'],
  [/\b(?:headline|current title|current role)\b/i, 'headline'],
  [/\b(?:years?\s+of\s+experience|total experience|experience in years)\b/i, 'totalExperience'],
]

export function valueFromProfile(key: string, profile: PortalProfile): string | null {
  const parts = profile.fullName.trim().split(/\s+/)
  const map: Record<string, string | undefined> = {
    fullName: profile.fullName,
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
    email: profile.email,
    phone: profile.phone,
    linkedin: profile.links.linkedin,
    github: profile.links.github,
    portfolio: profile.links.portfolio,
    addressLine1: profile.address.line1,
    city: profile.address.city,
    region: profile.address.region,
    postalCode: profile.address.postalCode,
    country: profile.address.country,
    noticePeriod: profile.noticePeriod,
    headline: profile.headline,
  }
  const value = map[key]
  return value && value.trim() ? value : null
}

/**
 * Above this, a label is a question rather than a field name.
 *
 * Heuristics match a phrase anywhere in the label, which is right for "Phone"
 * and wrong for a hundred-character question that merely contains the words
 * "current employer". Long labels go to the model rung, which can read the
 * whole sentence.
 */
const HEURISTIC_LABEL_LIMIT = 80

export function heuristicMatch(field: FormField): string | null {
  if (field.label.length > HEURISTIC_LABEL_LIMIT) return null
  const label = normaliseLabel(field.label)
  for (const [pattern, key] of HEURISTICS) {
    if (pattern.test(label)) return String(key)
  }
  return null
}

/* ------------------------------------------------------------ rung 3: model */

const mappingSchema = z.object({
  maps_to: z
    .string()
    .describe(
      'One of: fullName, firstName, lastName, email, phone, linkedin, github, portfolio, addressLine1, city, region, postalCode, country, noticePeriod, headline, totalExperience — or "none" when the question is not asking for any of them.',
    ),
  confidence: z.number().min(0).max(1),
})

const MAPPING_SYSTEM = `You map a job application form field onto a known candidate detail.

Answer "none" unless the field is clearly asking for one of the listed details. A wrong mapping puts a phone number in a cover letter box, which is worse than leaving it blank for a human.

Never map a field asking about salary, visa status, demographics, or criminal history. Those are answered by the candidate, not by you.`

/** Asks what an unfamiliar field wants. Cached afterwards, so asked once. */
async function mapWithModel(
  userId: string,
  field: FormField,
): Promise<{ mapsTo: string; confidence: number } | null> {
  if (!hasModelAccess) return null
  try {
    const answer = await structured(mappingSchema, {
      purpose: 'map-field',
      userId,
      system: MAPPING_SYSTEM,
      prompt: `Label: ${field.label}\nType: ${field.type}\nName: ${field.name ?? '(none)'}\nRequired: ${field.required}${
        field.options?.length ? `\nOptions: ${field.options.slice(0, 20).join(', ')}` : ''
      }`,
      effort: 'low',
      think: false,
      maxTokens: 500,
    })
    if (answer.maps_to === 'none' || answer.confidence < 0.6) return null
    return { mapsTo: answer.maps_to, confidence: answer.confidence }
  } catch (error) {
    logger.debug({ err: error, label: field.label }, 'field mapping failed')
    return null
  }
}

/* --------------------------------------------------------------- the ladder */

export interface ResolveContext {
  userId: string
  host: string
  profile: PortalProfile
  /** A recipe's answer for this field, when the portal has one. */
  fromRecipe?: string | null
}

export async function resolveField(
  field: FormField,
  context: ResolveContext,
): Promise<ResolvedField> {
  // Sensitive questions stop before any rung runs. This is checked first on
  // purpose: a cached or recipe answer must not be able to route around it.
  const sensitive = sensitiveReason(field.label, field.options)
  if (sensitive) return { value: null, via: 'skipped', blocked: 'sensitive_field' }

  if (context.fromRecipe) return { value: context.fromRecipe, via: 'recipe' }

  const signature = fieldSignature(field)

  // The user's own answer first, then the shared mapping layer.
  const cached = await db
    .select()
    .from(fieldAnswers)
    .where(
      and(
        eq(fieldAnswers.host, context.host),
        eq(fieldAnswers.fieldSignature, signature),
        or(eq(fieldAnswers.userId, context.userId), isNull(fieldAnswers.userId)),
      ),
    )
    .limit(2)
    .catch(() => [])

  const own = cached.find((row) => row.userId === context.userId)
  if (own?.value) {
    void bumpUsage(own.id)
    return { value: own.value, via: 'cache' }
  }

  const shared = cached.find((row) => row.userId === null)
  if (shared?.mapsTo) {
    const value = valueFromProfile(shared.mapsTo, context.profile)
    if (value) {
      void bumpUsage(shared.id)
      return { value, via: 'cache' }
    }
  }

  const heuristic = heuristicMatch(field)
  if (heuristic) {
    const value = valueFromProfile(heuristic, context.profile)
    if (value) return { value, via: 'heuristic' }
  }

  const mapped = await mapWithModel(context.userId, field)
  if (mapped) {
    // Remember the mapping for everyone — it is a fact about the form, not
    // about this person. The value itself is never shared.
    await rememberMapping(context.host, signature, field.label, mapped.mapsTo)
    const value = valueFromProfile(mapped.mapsTo, context.profile)
    if (value) return { value, via: 'model' }
  }

  // Only a required field we cannot answer is worth stopping for.
  return {
    value: null,
    via: 'skipped',
    ...(field.required ? { blocked: 'unknown_field' as const } : {}),
  }
}

async function bumpUsage(id: string): Promise<void> {
  await db
    .update(fieldAnswers)
    .set({ timesUsed: sql`${fieldAnswers.timesUsed} + 1`, updatedAt: new Date() })
    .where(eq(fieldAnswers.id, id))
    .catch(() => undefined)
}

/** Shared layer: what this question is asking, never what this person answered. */
export async function rememberMapping(
  host: string,
  signature: string,
  label: string,
  mapsTo: string,
): Promise<void> {
  await db
    .insert(fieldAnswers)
    .values({ userId: null, host, fieldSignature: signature, label, mapsTo })
    .onConflictDoNothing()
    .catch(() => undefined)
}

/** A value this user gave for this question. Private to them. */
export async function rememberAnswer(
  userId: string,
  host: string,
  field: FormField,
  value: string,
): Promise<void> {
  const signature = fieldSignature(field)
  await db
    .insert(fieldAnswers)
    .values({
      userId,
      host,
      fieldSignature: signature,
      label: field.label,
      value,
      confirmed: true,
    })
    .onConflictDoUpdate({
      target: [fieldAnswers.userId, fieldAnswers.host, fieldAnswers.fieldSignature],
      set: { value, confirmed: true, updatedAt: new Date() },
    })
    .catch(() => undefined)
}
