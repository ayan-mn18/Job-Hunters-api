import { z } from 'zod'

/** Empty string means "the user cleared this field" and is stored as NULL. */
const optionalText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .optional()

/**
 * URLs are stored as typed, not normalised to `https://…`. The UI shows and
 * accepts `linkedin.com/in/name`, and rewriting what the user typed into a
 * form field they will later see is a small betrayal. Portals accept both.
 */
const optionalUrlish = optionalText(400)

export const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  avatar: z.string().trim().min(1).max(16).optional(),
})

export const updateKitSchema = z.object({
  fullName: optionalText(120),
  pronouns: optionalText(40),
  email: optionalText(254),
  phone: optionalText(40),

  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  state: optionalText(100),
  postalCode: optionalText(20),
  country: optionalText(100),

  linkedinUrl: optionalUrlish,
  githubUrl: optionalUrlish,
  portfolioUrl: optionalUrlish,

  headline: optionalText(160),

  noticePeriod: optionalText(80),
  totalExperience: optionalText(80),
  maxYearsExperience: z.coerce.number().int().min(0).max(50).optional(),
  currentCtc: optionalText(80),
  expectedCtc: optionalText(80),
  workAuthorization: optionalText(200),
  willingToRelocate: optionalText(200),

  skills: z.array(z.string().trim().min(1).max(60)).max(200).optional(),
})

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .nullable()
  .optional()

export const employmentSchema = z.object({
  emoji: z.string().trim().min(1).max(16).optional(),
  role: z.string().trim().min(1).max(160),
  company: z.string().trim().min(1).max(160),
  startedOn: isoDate,
  endedOn: isoDate,
  isCurrent: z.boolean().optional(),
  periodLabel: optionalText(80),
  blurb: optionalText(1000),
  sortOrder: z.number().int().min(0).max(1000).optional(),
})

export const employmentUpdateSchema = employmentSchema.partial()

export const idParamSchema = z.object({ id: z.string().uuid('Not a valid id') })

/**
 * The onboarding wizard's payload, matching `KitDraft` in the UI. Everything
 * is optional because the wizard has a "skip for now" on every step.
 */
export const completeOnboardingSchema = z.object({
  roles: z.string().max(1000).optional(),
  locations: z.string().max(1000).optional(),
  companies: z.string().max(1000).optional(),
  dailyTarget: z.coerce.number().int().min(1).max(500).optional(),
  portals: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  phone: z.string().max(40).optional(),
  city: z.string().max(100).optional(),
  noticePeriod: z.string().max(80).optional(),
  maxYearsExperience: z.coerce.number().int().min(0).max(50).optional(),
  /** Informational: the resume is uploaded by its own endpoint, not here. */
  resumeName: z.string().max(200).optional(),
})

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>
export type UpdateKitInput = z.infer<typeof updateKitSchema>
export type EmploymentInput = z.infer<typeof employmentSchema>
export type EmploymentUpdateInput = z.infer<typeof employmentUpdateSchema>
export type CompleteOnboardingInput = z.infer<typeof completeOnboardingSchema>
