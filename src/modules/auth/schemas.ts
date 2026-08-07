import { z } from 'zod'

/** Normalised at the edge so `lower(email)` uniqueness can never be dodged. */
export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email('That does not look like an email address')
  .transform((value) => value.toLowerCase())

/**
 * Length over character-class rules. Forcing a symbol mostly produces
 * "Password1!" — length is what actually costs an attacker anything.
 */
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(200, 'Password must be at most 200 characters')

export const signUpSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  email: emailSchema,
  password: passwordSchema,
})

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
})

export const refreshSchema = z.object({
  refreshToken: z.string().min(10, 'refreshToken is required'),
})

export const logoutSchema = z.object({
  refreshToken: z.string().min(10).optional(),
  /** Kill every session for this account, not just this device. */
  allDevices: z.boolean().optional().default(false),
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
})

export type SignUpInput = z.infer<typeof signUpSchema>
export type SignInInput = z.infer<typeof signInSchema>
export type RefreshInput = z.infer<typeof refreshSchema>
export type LogoutInput = z.infer<typeof logoutSchema>
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>
