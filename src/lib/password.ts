import { compare, hash } from '@node-rs/bcrypt'
import { env } from '../config/env.js'

/**
 * bcrypt, via `@node-rs/bcrypt`.
 *
 * Previously `bcryptjs` — the same algorithm and the same `$2b$` hash format,
 * but in pure JavaScript, which put every login and signup at roughly
 * 600–1200 ms at cost factor 12. That was the single largest source of
 * perceived slowness in the product.
 *
 * This is the native Rust implementation: same format, same cost factor, about
 * an order of magnitude faster. It ships prebuilt binaries for the platforms
 * this deploys on, so there is still no node-gyp step. Existing hashes verify
 * unchanged — the format is identical, so no migration is needed.
 *
 * If throughput ever demands argon2, only this file changes: the rest of the
 * codebase calls `hashPassword` / `verifyPassword` and nothing else.
 */

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, env.BCRYPT_ROUNDS)
}

export async function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  try {
    return await compare(plain, hashed)
  } catch {
    return false
  }
}

/**
 * Burn roughly the same CPU as a real comparison when the email did not match
 * any account. Without this, response timing tells an attacker which addresses
 * are registered.
 */
const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEe.7d3.7pQ9J9eJc0N0hcHZ0xJH0y3mQ8O'

export async function fakeVerify(plain: string): Promise<void> {
  await verifyPassword(plain, DUMMY_HASH)
}
