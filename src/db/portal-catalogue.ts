import { notInArray } from 'drizzle-orm'
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
  // Tier 1: keyword search. Google for Jobs is the one that reaches LinkedIn,
  // Naukri, Foundit and Indeed listings without touching anyone's account.
  { id: 'google-jobs', name: 'Google for Jobs', emoji: '🔍', websiteUrl: 'https://jobs.google.com', sortOrder: 1 },
  { id: 'adzuna', name: 'Adzuna', emoji: '📊', websiteUrl: 'https://www.adzuna.com', sortOrder: 2 },
  { id: 'jooble', name: 'Jooble', emoji: '🌍', websiteUrl: 'https://jooble.org', sortOrder: 3 },
  { id: 'greenhouse', name: 'Greenhouse employers', emoji: '🏢', websiteUrl: 'https://www.greenhouse.com', sortOrder: 10 },
  { id: 'ashby', name: 'Ashby employers', emoji: '🧩', websiteUrl: 'https://www.ashbyhq.com', sortOrder: 20 },
  { id: 'lever', name: 'Lever employers', emoji: '🛠️', websiteUrl: 'https://www.lever.co', sortOrder: 30 },
  { id: 'smartrecruiters', name: 'SmartRecruiters employers', emoji: '🎯', websiteUrl: 'https://www.smartrecruiters.com', sortOrder: 32 },
  { id: 'workable', name: 'Workable employers', emoji: '📌', websiteUrl: 'https://www.workable.com', sortOrder: 34 },
  { id: 'remoteok', name: 'RemoteOK', emoji: '🌍', websiteUrl: 'https://remoteok.com', sortOrder: 40 },
  { id: 'weworkremotely', name: 'We Work Remotely', emoji: '🏝️', websiteUrl: 'https://weworkremotely.com', sortOrder: 50 },
  { id: 'remotive', name: 'Remotive', emoji: '🛰️', websiteUrl: 'https://remotive.com', sortOrder: 60 },
  { id: 'jobicy', name: 'Jobicy', emoji: '🧭', websiteUrl: 'https://jobicy.com', sortOrder: 70 },
  { id: 'arbeitnow', name: 'Arbeitnow', emoji: '🌐', websiteUrl: 'https://www.arbeitnow.com', sortOrder: 80 },
  { id: 'instahyre', name: 'Instahyre', emoji: '⚡', websiteUrl: 'https://www.instahyre.com', sortOrder: 90 },
  // No discovery adapter: Wellfound's listings are behind a login, so reaching
  // them means a session (tier 3), which is not enabled. The row stays because
  // portal *accounts* still use it for applying — but it is not offered as a
  // source, because it cannot be one yet.
  { id: 'wellfound', name: 'Wellfound account', emoji: '🚀', websiteUrl: 'https://wellfound.com/jobs', sortOrder: 100, isAvailable: false },
  { id: 'workatastartup', name: 'Work at a Startup (YC)', emoji: '▲', websiteUrl: 'https://www.workatastartup.com/jobs', sortOrder: 110 },
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
          // A catalogue entry may declare itself unavailable — a portal we can
          // apply through but cannot yet search.
          isAvailable: 'isAvailable' in portal ? portal.isAvailable : true,
          updatedAt: new Date(),
        },
      })
  }
  await db
    .update(portals)
    .set({ isAvailable: false, updatedAt: new Date() })
    .where(notInArray(portals.id, PORTAL_CATALOGUE.map((portal) => portal.id)))
  return PORTAL_CATALOGUE.length
}
