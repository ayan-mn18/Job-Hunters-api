import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { kits, resumes } from '../db/schema.js'

/**
 * The answers a form needs, collected at the moment they are first needed.
 *
 * Intake deliberately never asks for these: a phone number cannot reorder
 * anyone's search results, so asking for it up front costs drop-off and buys
 * nothing. That deferral left a real gap, though — the old wizard used to
 * collect them, and nothing replaced it, so the first application would reach
 * `loadPortalProfile`, throw "phone is required in My Kit", and surface to the
 * user as a *failed application* rather than a question.
 *
 * A missing field should be a prompt before the run, not a casualty during it.
 */

/** Without these, `loadPortalProfile` refuses and no application can run. */
const REQUIRED = ['fullName', 'email', 'phone'] as const

/**
 * Not required to submit, but asked by most portals. Missing ones do not block
 * a run — they turn into `needs_review` attempts one at a time, which is a
 * worse way to find out.
 */
const COMMONLY_ASKED = [
  'city',
  'country',
  'noticePeriod',
  'currentCtc',
  'expectedCtc',
  'workAuthorization',
  'willingToRelocate',
] as const

export type ApplyFieldId = (typeof REQUIRED)[number] | (typeof COMMONLY_ASKED)[number]

interface FieldSpec {
  id: ApplyFieldId
  label: string
  help?: string
  placeholder?: string
  required: boolean
}

const SPECS: FieldSpec[] = [
  { id: 'fullName', label: 'Full name', required: true, placeholder: 'As it should appear on applications' },
  { id: 'email', label: 'Email for applications', required: true, help: 'Can differ from your login email.' },
  { id: 'phone', label: 'Phone number', required: true, placeholder: '+91 98765 43210' },
  { id: 'city', label: 'City', required: false },
  { id: 'country', label: 'Country', required: false },
  {
    id: 'noticePeriod',
    label: 'Notice period',
    required: false,
    placeholder: '30 days',
    help: 'Copied into the form exactly as you write it.',
  },
  { id: 'currentCtc', label: 'Current salary', required: false, placeholder: '₹18,00,000' },
  { id: 'expectedCtc', label: 'Expected salary', required: false, placeholder: '₹24,00,000' },
  {
    id: 'workAuthorization',
    label: 'Work authorisation',
    required: false,
    placeholder: 'Indian citizen, no sponsorship needed',
  },
  { id: 'willingToRelocate', label: 'Willing to relocate?', required: false, placeholder: 'Yes, within India' },
]

export interface ApplyFieldsState {
  /** Everything a portal form might ask, with whatever we already know. */
  fields: Array<FieldSpec & { value: string | null }>
  /** Ids that block applying entirely. */
  missingRequired: ApplyFieldId[]
  /** Ids that will cause individual attempts to park for review. */
  missingOptional: ApplyFieldId[]
  /** True when nothing blocks a run. */
  canApply: boolean
  /** Separate from the fields: applying needs something to attach. */
  hasBaseResume: boolean
}

function valueOf(kit: Record<string, unknown> | undefined, id: ApplyFieldId): string | null {
  const raw = kit?.[id]
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

export async function readApplyFields(userId: string): Promise<ApplyFieldsState> {
  const [[kit], [baseResume]] = await Promise.all([
    db.select().from(kits).where(eq(kits.userId, userId)).limit(1),
    db.select({ id: resumes.id }).from(resumes).where(eq(resumes.userId, userId)).limit(1),
  ])

  const fields = SPECS.map((spec) => ({ ...spec, value: valueOf(kit, spec.id) }))
  const missingRequired = fields.filter((f) => f.required && !f.value).map((f) => f.id)
  const missingOptional = fields.filter((f) => !f.required && !f.value).map((f) => f.id)

  return {
    fields,
    missingRequired,
    missingOptional,
    canApply: missingRequired.length === 0 && Boolean(baseResume),
    hasBaseResume: Boolean(baseResume),
  }
}

/**
 * Writes answers into the kit, which is where the apply runtime already reads
 * them from. Deliberately not a new table: two homes for a phone number is how
 * they drift apart.
 */
export async function saveApplyFields(
  userId: string,
  answers: Partial<Record<ApplyFieldId, string>>,
): Promise<ApplyFieldsState> {
  const patch: Record<string, string | null> = {}
  for (const spec of SPECS) {
    const value = answers[spec.id]
    if (value === undefined) continue
    const trimmed = value.trim()
    // An empty string means "clear this", not "store a blank".
    patch[spec.id] = trimmed.length > 0 ? trimmed : null
  }

  if (Object.keys(patch).length > 0) {
    await db
      .insert(kits)
      .values({ userId, ...patch })
      .onConflictDoUpdate({ target: kits.userId, set: { ...patch, updatedAt: new Date() } })
  }

  return readApplyFields(userId)
}

/** Human-readable list for an error the user will actually read. */
export function describeMissing(ids: ApplyFieldId[]): string {
  const labels = ids.map((id) => SPECS.find((spec) => spec.id === id)?.label ?? id)
  // Guard the empty case explicitly: the join branch would otherwise reach
  // past the end of the array and render "and undefined" into a sentence the
  // user reads.
  if (labels.length === 0) return ''
  if (labels.length === 1) return labels[0] ?? ''
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}
