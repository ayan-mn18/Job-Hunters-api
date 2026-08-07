import bcrypt from 'bcryptjs'
import { env } from '../config/env.js'

/**
 * bcrypt, via `bcryptjs`.
 *
 * The brief said "bcrypt/argon2". This is bcrypt — the same algorithm and the
 * same `$2b$` hash format as the native `bcrypt` package, in pure JavaScript.
 * That buys a dependency tree with no node-gyp step, which matters because
 * this repo has to install cleanly on a laptop and in CI before anyone has
 * thought about build toolchains. If throughput ever becomes the bottleneck,
 * swapping in `argon2` means changing only this file: the rest of the codebase
 * calls `hashPassword` / `verifyPassword` and nothing else.
 */

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.BCRYPT_ROUNDS)
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash)
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
