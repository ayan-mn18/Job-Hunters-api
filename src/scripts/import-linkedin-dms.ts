import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { closeDatabase, db } from '../db/client.js'
import { portalAccounts, users } from '../db/schema.js'
import { importLinkedInDmExport } from '../services/linkedin-dm-import.js'

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const filePath = path.resolve(
  argument('--file') ?? '../linked-in-dm-scraper/data/linkedin-dms.json',
)
const dryRun = process.argv.includes('--dry-run')
let userId = argument('--user-id')

try {
  if (!userId) {
    const accounts = await db
      .select({ userId: portalAccounts.userId })
      .from(portalAccounts)
      .where(and(
        eq(portalAccounts.portalId, 'linkedin-referrals'),
        eq(portalAccounts.status, 'ready'),
      ))
    if (accounts.length !== 1) {
      throw new Error(`Expected exactly one ready LinkedIn referral account; found ${accounts.length}. Pass --user-id.`)
    }
    userId = accounts[0]!.userId
  }

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!user) throw new Error('Target Job Hunters user was not found.')

  const result = await importLinkedInDmExport({
    filePath,
    userId,
    referrerName: user.name,
    dryRun,
  })
  console.log(JSON.stringify({ userId, filePath, ...result }, null, 2))
} finally {
  await closeDatabase()
}
