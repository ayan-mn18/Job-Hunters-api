import { getDb } from './client.js'
import { portals } from './schema.js'

/**
 * The portal catalogue is reference data, not schema, so it lives here rather
 * than in a migration file: adding "Dice" later should be an edit to this list
 * that re-runs safely, not a new DDL file. The upsert is idempotent.
 *
 * It sits in its own module — rather than inside migrate.ts — because both the
 * migrator and the seed script need it, and importing migrate.ts would run the
 * migrator as a side effect.
 */
export const PORTAL_CATALOGUE = [
  { id: 'linkedin', name: 'LinkedIn', emoji: '💼', websiteUrl: 'https://www.linkedin.com/jobs', sortOrder: 10 },
  { id: 'wellfound', name: 'Wellfound', emoji: '🚀', websiteUrl: 'https://wellfound.com/jobs', sortOrder: 20 },
  { id: 'remoteok', name: 'RemoteOK', emoji: '🌍', websiteUrl: 'https://remoteok.com', sortOrder: 30 },
  { id: 'weworkremotely', name: 'We Work Remotely', emoji: '🏝️', websiteUrl: 'https://weworkremotely.com', sortOrder: 40 },
  { id: 'ycombinator', name: 'YC Work at a Startup', emoji: '🧡', websiteUrl: 'https://www.workatastartup.com', sortOrder: 50 },
  { id: 'naukri', name: 'Naukri', emoji: '🇮🇳', websiteUrl: 'https://www.naukri.com', sortOrder: 60 },
  { id: 'instahyre', name: 'Instahyre', emoji: '⚡', websiteUrl: 'https://www.instahyre.com', sortOrder: 70 },
  { id: 'indeed', name: 'Indeed', emoji: '🔎', websiteUrl: 'https://www.indeed.com', sortOrder: 80 },
] as const

export async function syncPortalCatalogue(): Promise<number> {
  const db = getDb()
  for (const portal of PORTAL_CATALOGUE) {
    await db
      .insert(portals)
      .values({ ...portal })
      .onConflictDoUpdate({
        target: portals.id,
        set: {
          name: portal.name,
          emoji: portal.emoji,
          websiteUrl: portal.websiteUrl,
          sortOrder: portal.sortOrder,
          updatedAt: new Date(),
        },
      })
  }
  return PORTAL_CATALOGUE.length
}
