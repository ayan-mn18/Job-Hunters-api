import { eq, sql } from 'drizzle-orm'
import { hasDatabase } from '../config/env.js'
import { logger } from '../lib/logger.js'
import { hashPassword } from '../lib/password.js'
import { avatarFor } from '../modules/auth/service.js'
import { closeDatabase, getDb } from './client.js'
import { syncPortalCatalogue } from './portal-catalogue.js'
import {
  activityEvents,
  applicationEvents,
  applications,
  employments,
  huntSpecs,
  kits,
  referrals,
  resumes,
  userPortals,
  users,
  type ApplicationStatus,
  type ReferralSource,
} from './schema.js'

/**
 * Loads the same demo data the UI currently hard-codes in
 * `Job-Hunters-UI/src/data/mock.ts`, so the frontend can be pointed at a real
 * server and look identical.
 *
 * Two things are done deliberately:
 *
 *  - Dates are relative to *now*, not the fixed 2026-08-07 in the mock. The
 *    mock's "Today" chip is a hard-coded string; here the day labels have to
 *    be computed, so the data has to land on the actual current day or the
 *    Referrals screen would open on an empty "Today".
 *
 *  - The headline numbers (68 applied today, 3 interviews, 12-day streak,
 *    7 DMs + 4 emails) are computed from real rows rather than stored as
 *    totals. So the seed generates filler rows to reach them. The named
 *    records from the mock are all present and appear at the top.
 *
 * Re-running wipes and recreates the demo account only. Other accounts are
 * untouched.
 */

const DEMO_EMAIL = (process.env.SEED_EMAIL ?? 'demo@jobhunters.test').toLowerCase()
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'hunty-demo-2026'
const DEMO_NAME = process.env.SEED_NAME ?? 'Ayan Mansoori'

const db = getDb()

const day = 86_400_000
const hour = 3_600_000
const minute = 60_000

/** A timestamp N days ago at a given local-ish hour, for readable feeds. */
function daysAgo(days: number, atHour = 10, atMinute = 0): Date {
  const date = new Date(Date.now() - days * day)
  date.setHours(atHour, atMinute, 0, 0)
  return date
}

function minutesAgo(count: number): Date {
  return new Date(Date.now() - count * minute)
}

function hoursAgo(count: number): Date {
  return new Date(Date.now() - count * hour)
}

/* ---------------------------------------------------------------- mock data */

const PORTAL_STATE = [
  { id: 'linkedin', connected: true, jobsFound: 412 },
  { id: 'wellfound', connected: true, jobsFound: 96 },
  { id: 'remoteok', connected: true, jobsFound: 138 },
  { id: 'weworkremotely', connected: true, jobsFound: 74 },
  { id: 'ycombinator', connected: false, jobsFound: 0 },
  { id: 'naukri', connected: true, jobsFound: 203 },
  { id: 'instahyre', connected: false, jobsFound: 0 },
  { id: 'indeed', connected: true, jobsFound: 187 },
]

/** Verbatim from the UI's `applications` export. */
const NAMED_APPLICATIONS = [
  {
    role: 'Senior Frontend Engineer',
    company: 'Nimbus Labs',
    logo: '🌩️',
    location: 'Remote — worldwide',
    portalId: 'linkedin',
    portalName: 'LinkedIn',
    salary: '$120k – $150k',
    matchScore: 94,
    status: 'interview' as ApplicationStatus,
    appliedAt: daysAgo(2, 11),
    resumeVariantName: 'resume—frontend—react.pdf',
  },
  {
    role: 'Full-stack Developer (Node + React)',
    company: 'Pastel Pay',
    logo: '🍭',
    location: 'Bengaluru, India',
    portalId: 'instahyre',
    portalName: 'Instahyre',
    salary: '₹32L – ₹45L',
    matchScore: 91,
    status: 'viewed' as ApplicationStatus,
    appliedAt: hoursAgo(5),
    resumeVariantName: 'resume—fullstack—fintech.pdf',
  },
  {
    role: 'Platform Engineer',
    company: 'Otterly',
    logo: '🦦',
    location: 'Remote — EU',
    portalId: 'remoteok',
    portalName: 'RemoteOK',
    salary: '€75k – €95k',
    matchScore: 88,
    status: 'applied' as ApplicationStatus,
    appliedAt: hoursAgo(6),
    resumeVariantName: 'resume—platform—infra.pdf',
  },
  {
    role: 'Software Engineer II',
    company: 'Bluewhale',
    logo: '🐋',
    location: 'Hyderabad, India',
    portalId: 'naukri',
    portalName: 'Naukri',
    salary: '₹28L – ₹38L',
    matchScore: 84,
    status: 'applied' as ApplicationStatus,
    appliedAt: hoursAgo(7),
    resumeVariantName: 'resume—backend—java.pdf',
  },
  {
    role: 'Product Engineer',
    company: 'Sunny Side',
    logo: '🍳',
    location: 'Remote — India',
    portalId: 'wellfound',
    portalName: 'Wellfound',
    salary: '₹25L – ₹35L',
    matchScore: 79,
    status: 'queued' as ApplicationStatus,
    appliedAt: null,
    resumeVariantName: 'resume—product—generalist.pdf',
  },
  {
    role: 'Backend Engineer (Go)',
    company: 'Tinbox',
    logo: '📦',
    location: 'Remote — US hours',
    portalId: 'weworkremotely',
    portalName: 'We Work Remotely',
    salary: '$110k – $130k',
    matchScore: 72,
    status: 'rejected' as ApplicationStatus,
    appliedAt: daysAgo(9, 14),
    resumeVariantName: 'resume—backend—go.pdf',
  },
]

/** Filler pool, so 68-applications-today does not read as the same row 68 times. */
const FILLER_COMPANIES = [
  ['Meadowlark', '🐦'],
  ['Copperline', '🔶'],
  ['Driftwood', '🪵'],
  ['Salt & Pine', '🌲'],
  ['Northbend', '🧭'],
  ['Lantern Labs', '🏮'],
  ['Quiet Harbor', '⚓'],
  ['Paper Kite', '🪁'],
  ['Rivergate', '🌉'],
  ['Fernway', '🌿'],
  ['Brasswork', '🎺'],
  ['Cobblestone', '🧱'],
  ['Hollowpoint', '⭕'],
  ['Amberfield', '🟠'],
  ['Wildcard', '🃏'],
  ['Tidepool', '🌊'],
  ['Foxglove', '🌸'],
  ['Sandpiper', '🏖️'],
] as const

const FILLER_ROLES = [
  'Frontend Engineer',
  'Senior Software Engineer',
  'Full-stack Engineer',
  'Backend Engineer',
  'Product Engineer',
  'Platform Engineer',
  'Software Engineer III',
  'Web Engineer',
]

const FILLER_LOCATIONS = [
  'Remote — worldwide',
  'Remote — India',
  'Bengaluru, India',
  'Pune, India',
  'Remote — EU',
  'Hyderabad, India',
]

const FILLER_SALARIES = [
  '₹24L – ₹36L',
  '₹30L – ₹42L',
  '$90k – $120k',
  '$110k – $140k',
  '€65k – €85k',
]

const CONNECTED_PORTALS = PORTAL_STATE.filter((portal) => portal.connected)

/** Verbatim from the UI's `referrals` export. */
const NAMED_REFERRALS = [
  {
    requesterName: 'Meera Iyer',
    requesterHeadline: 'SDE-2 @ Fintech · 4 yrs · React, Node',
    requesterAvatar: '🦊',
    source: 'linkedin' as ReferralSource,
    receivedAt: 9 * hour + 12 * minute,
    targetRole: 'Senior Frontend Engineer',
    jobRequisitionId: 'JR-48210',
    resumeName: 'meera—iyer—resume.pdf',
    note: 'Hey! Saw you work at Nimbus. Would you be open to referring me for JR-48210?',
    matchScore: 92,
    handled: false,
    draft:
      "Happy to refer Meera Iyer for JR-48210 (Senior Frontend Engineer). We overlapped on a payments dashboard rebuild, where she owned the React migration end to end and cut first-paint by 40%. She writes tests without being asked and gives the kind of code review that makes the whole team better — exactly the bar we hold here. Resume attached; glad to answer anything else.",
  },
  {
    requesterName: 'Rahul Deshmukh',
    requesterHeadline: 'Backend Engineer · 3 yrs · Go, Postgres',
    requesterAvatar: '🐨',
    source: 'email' as ReferralSource,
    receivedAt: 10 * hour + 41 * minute,
    targetRole: 'Platform Engineer',
    jobRequisitionId: 'JR-51007',
    resumeName: 'rahul—d—cv.pdf',
    note: 'Applying to the Platform Engineer role. Attaching my CV — would really appreciate a referral.',
    matchScore: 85,
    handled: false,
    draft:
      'Referring Rahul Deshmukh for JR-51007 (Platform Engineer). He spent three years on Go services handling ~8k rps and led the Postgres sharding work that kept their p99 flat through a 4x traffic year. Calm in incidents, writes runbooks nobody has to rewrite. Strong fit for the reliability work on this team.',
  },
  {
    requesterName: 'Sana Qureshi',
    requesterHeadline: 'New grad · CS · internships at 2 startups',
    requesterAvatar: '🐝',
    source: 'linkedin' as ReferralSource,
    receivedAt: 11 * hour + 58 * minute,
    targetRole: 'Software Engineer I',
    jobRequisitionId: 'JR-49933',
    resumeName: 'sana—q—resume.pdf',
    note: 'Hi! I am a 2026 grad and would love a referral for the SDE-1 opening.',
    matchScore: 71,
    handled: true,
    draft:
      'Referring Sana Qureshi for JR-49933 (Software Engineer I). Two startup internships where she shipped to production in week two both times, plus an open-source CLI with real users. Early-career, but the learning speed is the standout — worth an interview slot.',
  },
  {
    requesterName: 'Devansh Kapoor',
    requesterHeadline: 'Data Engineer · 5 yrs · Spark, Airflow',
    requesterAvatar: '🦉',
    source: 'email' as ReferralSource,
    receivedAt: 14 * hour + 20 * minute,
    targetRole: 'Senior Data Engineer',
    jobRequisitionId: 'JR-50488',
    resumeName: 'devansh—kapoor.pdf',
    note: 'Long shot, but are referrals open for the senior data role? CV attached.',
    matchScore: 88,
    handled: false,
    draft:
      'Referring Devansh Kapoor for JR-50488 (Senior Data Engineer). He rebuilt a nightly Spark pipeline that had been failing weekly into something that has not paged anyone in a year, and he did the unglamorous data-quality work that made the numbers trustworthy. Exactly the profile this team keeps saying it needs.',
  },
]

/** From the UI's `referralDays`: day offset → { linkedin, email }. */
const REFERRAL_DAY_COUNTS = [
  { offset: 0, linkedin: 7, email: 4 },
  { offset: 1, linkedin: 5, email: 2 },
  { offset: 2, linkedin: 3, email: 3 },
  { offset: 3, linkedin: 6, email: 1 },
  { offset: 4, linkedin: 2, email: 0 },
]

const FILLER_PEOPLE = [
  ['Priya Nair', '🐧', 'SDE-1 · 2 yrs · Python'],
  ['Arjun Menon', '🦁', 'Frontend · 3 yrs · Vue, TS'],
  ['Kavya Reddy', '🐢', 'QA Engineer · 4 yrs'],
  ['Rohan Bhat', '🦔', 'DevOps · 5 yrs · K8s'],
  ['Nisha Verma', '🦋', 'Product Designer · 3 yrs'],
  ['Imran Sheikh', '🐘', 'Android · 6 yrs · Kotlin'],
  ['Tara Joshi', '🦩', 'Data Analyst · 2 yrs · SQL'],
  ['Vikram Rao', '🐺', 'SRE · 7 yrs'],
  ['Anaya Gupta', '🐬', 'ML Engineer · 4 yrs'],
  ['Karan Malhotra', '🦌', 'Fullstack · 5 yrs · Rails'],
  ['Divya Pillai', '🐌', 'Technical Writer · 3 yrs'],
  ['Sameer Khan', '🦅', 'Security Engineer · 6 yrs'],
] as const

const SKILLS = [
  'React',
  'TypeScript',
  'Node.js',
  'PostgreSQL',
  'AWS',
  'Docker',
  'GraphQL',
  'Redis',
  'CI/CD',
]

/** From the UI's `activity` export. */
const ACTIVITY = [
  { emoji: '📮', text: 'Applied to Platform Engineer at Otterly', at: minutesAgo(4), kind: 'application_submitted' as const },
  { emoji: '✂️', text: 'Tailored resume for Pastel Pay JD', at: minutesAgo(11), kind: 'resume_tailored' as const },
  { emoji: '👀', text: 'Nimbus Labs viewed your application', at: hoursAgo(1), kind: 'application_status_changed' as const },
  { emoji: '🔎', text: 'Scraped 138 new jobs from RemoteOK', at: hoursAgo(3), kind: 'jobs_scraped' as const },
  { emoji: '🤝', text: '3 new referral requests landed in inbox', at: hoursAgo(5), kind: 'referral_received' as const },
]

/* --------------------------------------------------------------------- seed */

function pick<T>(list: readonly T[], index: number): T {
  return list[index % list.length]!
}

async function main(): Promise<void> {
  if (!hasDatabase) {
    logger.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.')
    process.exit(1)
  }

  await syncPortalCatalogue()

  // Cascades wipe every child row, so a re-run is a clean slate.
  const removed = await db
    .delete(users)
    .where(eq(users.email, DEMO_EMAIL))
    .returning({ id: users.id })
  if (removed.length > 0) logger.info('removed the previous demo account')

  const [user] = await db
    .insert(users)
    .values({
      email: DEMO_EMAIL,
      passwordHash: await hashPassword(DEMO_PASSWORD),
      name: DEMO_NAME,
      avatar: avatarFor(DEMO_EMAIL),
      onboarded: true,
      onboardedAt: daysAgo(14, 9),
      joinedAt: daysAgo(14, 9),
    })
    .returning()

  if (!user) throw new Error('Could not create the demo user')
  const userId = user.id

  /* -- kit ---------------------------------------------------------------- */

  await db.insert(kits).values({
    userId,
    fullName: DEMO_NAME,
    email: DEMO_EMAIL,
    phone: '+91 98765 43210',
    addressLine1: '221B Marigold Lane',
    city: 'Pune',
    state: 'Maharashtra',
    postalCode: '411001',
    country: 'India',
    linkedinUrl: 'linkedin.com/in/ayan-mn18',
    githubUrl: 'github.com/ayan-mn18',
    headline: 'Full-stack Engineer',
    noticePeriod: '30 days',
    totalExperience: '4 years',
    currentCtc: '₹24,00,000',
    expectedCtc: '₹36,00,000',
    workAuthorization: 'Indian citizen — no sponsorship needed',
    willingToRelocate: 'Yes, for the right team',
    skills: SKILLS,
  })

  await db.insert(employments).values([
    {
      userId,
      emoji: '🌩️',
      role: 'Software Engineer',
      company: 'Nimbus Labs',
      startedOn: '2024-01-01',
      isCurrent: true,
      blurb: 'React + Node platform work. Owned the billing rewrite.',
      sortOrder: 0,
    },
    {
      userId,
      emoji: '🍭',
      role: 'Junior Developer',
      company: 'Pastel Pay',
      startedOn: '2022-06-01',
      endedOn: '2023-12-31',
      isCurrent: false,
      blurb: 'Payments dashboard, internal tooling, on-call rotation.',
      sortOrder: 1,
    },
  ])

  /* -- resume ------------------------------------------------------------- */

  // NOTE: this row points at an object that does not exist in Supabase
  // Storage. The screens that only show the filename work; downloading it
  // will 404 until a real file is uploaded through POST /resumes.
  await db.insert(resumes).values({
    userId,
    kind: 'base',
    fileName: 'ayan—resume—2026.pdf',
    storagePath: `${userId}/base/seed-placeholder-ayan-resume-2026.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: 184_320,
    isBase: true,
    parseStatus: 'parsed',
    parsedAt: daysAgo(2, 9),
    parsedSkills: SKILLS,
    parsedTitles: ['Software Engineer', 'Junior Developer'],
    parsedYearsExperience: 4,
  })

  /* -- hunt spec + portals ------------------------------------------------ */

  await db.insert(huntSpecs).values({
    userId,
    roles: ['Senior Frontend Engineer', 'Full-stack Engineer', 'Product Engineer'],
    dreamCompanies: ['Stripe', 'Linear', 'Vercel', 'Razorpay'],
    locations: ['Remote', 'Bengaluru', 'Pune'],
    dealBreakers: ['on-site only', 'unpaid', '<2 yrs experience required'],
    minMatchScore: 70,
    dailyTarget: 100,
  })

  await db.insert(userPortals).values(
    PORTAL_STATE.map((portal) => ({
      userId,
      portalId: portal.id,
      connected: portal.connected,
      jobsFound: portal.jobsFound,
      connectedAt: portal.connected ? daysAgo(14, 9) : null,
      lastSyncedAt: portal.connected ? hoursAgo(3) : null,
    })),
  )

  /* -- applications ------------------------------------------------------- */

  const applicationRows: (typeof applications.$inferInsert)[] = NAMED_APPLICATIONS.map((row) => ({
    userId,
    role: row.role,
    company: row.company,
    logo: row.logo,
    location: row.location,
    salary: row.salary,
    portalId: row.portalId,
    portalName: row.portalName,
    matchScore: row.matchScore,
    status: row.status,
    resumeVariantName: row.resumeVariantName,
    appliedAt: row.appliedAt,
    queuedAt: row.appliedAt ?? new Date(),
    externalJobId: null,
  }))

  // Top up today to the 68 the Den screen shows. Two of the named rows were
  // applied today (Pastel Pay, Otterly, Bluewhale = 3), so the filler makes up
  // the difference rather than adding 68 more on top.
  const namedToday = NAMED_APPLICATIONS.filter(
    (row) => row.appliedAt !== null && Date.now() - row.appliedAt.getTime() < 12 * hour,
  ).length
  const TODAY_TARGET = 68

  for (let index = 0; index < TODAY_TARGET - namedToday; index += 1) {
    const [company, logo] = pick(FILLER_COMPANIES, index)
    const portal = pick(CONNECTED_PORTALS, index)
    // Two interviews and a handful of "viewed" among today's batch, so the
    // funnel on the Den screen is not a flat wall of "applied".
    const status: ApplicationStatus =
      index === 3 || index === 17 ? 'interview' : index % 9 === 0 ? 'viewed' : 'applied'

    applicationRows.push({
      userId,
      role: pick(FILLER_ROLES, index),
      company,
      logo,
      location: pick(FILLER_LOCATIONS, index),
      salary: pick(FILLER_SALARIES, index),
      portalId: portal.id,
      portalName: null,
      matchScore: 70 + ((index * 7) % 28),
      status,
      resumeVariantName: `resume—${pick(FILLER_ROLES, index).toLowerCase().replace(/\W+/g, '-')}.pdf`,
      appliedAt: minutesAgo(20 + index * 7),
      queuedAt: minutesAgo(30 + index * 7),
      externalJobId: null,
    })
  }

  // Backfill the previous 11 days so the 12-day streak is real rather than a
  // stored number. Volume tapers off in the past — it reads more like a log.
  for (let dayOffset = 1; dayOffset <= 11; dayOffset += 1) {
    const perDay = 12 + ((dayOffset * 5) % 20)
    for (let index = 0; index < perDay; index += 1) {
      const [company, logo] = pick(FILLER_COMPANIES, dayOffset * 3 + index)
      const portal = pick(CONNECTED_PORTALS, index + dayOffset)
      applicationRows.push({
        userId,
        role: pick(FILLER_ROLES, index + dayOffset),
        company,
        logo,
        location: pick(FILLER_LOCATIONS, index + dayOffset),
        salary: pick(FILLER_SALARIES, index),
        portalId: portal.id,
        portalName: null,
        matchScore: 70 + ((index * 11 + dayOffset) % 28),
        status: index % 11 === 0 ? 'rejected' : 'applied',
        resumeVariantName: 'resume—generalist.pdf',
        appliedAt: daysAgo(dayOffset, 8 + (index % 10), (index * 5) % 60),
        queuedAt: daysAgo(dayOffset, 6, 0),
        externalJobId: null,
      })
    }
  }

  const insertedApplications = await db
    .insert(applications)
    .values(applicationRows)
    .returning({ id: applications.id, status: applications.status })

  await db.insert(applicationEvents).values(
    insertedApplications.map((row) => ({
      applicationId: row.id,
      fromStatus: null,
      toStatus: row.status,
      note: 'seeded',
    })),
  )

  /* -- referrals ---------------------------------------------------------- */

  const referralRows: (typeof referrals.$inferInsert)[] = []

  for (const row of NAMED_REFERRALS) {
    const receivedAt = new Date()
    receivedAt.setHours(0, 0, 0, 0)
    referralRows.push({
      userId,
      requesterName: row.requesterName,
      requesterHeadline: row.requesterHeadline,
      requesterAvatar: row.requesterAvatar,
      source: row.source,
      receivedAt: new Date(receivedAt.getTime() + row.receivedAt),
      targetRole: row.targetRole,
      jobRequisitionId: row.jobRequisitionId,
      resumeName: row.resumeName,
      note: row.note,
      matchScore: row.matchScore,
      handled: row.handled,
      handledAt: row.handled ? hoursAgo(2) : null,
      draft: row.draft,
      draftModel: 'seed',
      draftGeneratedAt: hoursAgo(6),
    })
  }

  // Top each day up to the counts the day-picker shows.
  let personIndex = 0
  for (const bucket of REFERRAL_DAY_COUNTS) {
    for (const source of ['linkedin', 'email'] as const) {
      const namedOnThisDay =
        bucket.offset === 0
          ? NAMED_REFERRALS.filter((row) => row.source === source).length
          : 0
      const wanted = source === 'linkedin' ? bucket.linkedin : bucket.email

      for (let index = 0; index < wanted - namedOnThisDay; index += 1) {
        const [name, avatar, headline] = pick(FILLER_PEOPLE, personIndex)
        personIndex += 1
        referralRows.push({
          userId,
          requesterName: name,
          requesterHeadline: headline,
          requesterAvatar: avatar,
          source,
          receivedAt: daysAgo(bucket.offset, 9 + (index % 9), (index * 13) % 60),
          targetRole: pick(FILLER_ROLES, personIndex),
          jobRequisitionId: `JR-${48_000 + personIndex * 37}`,
          resumeName: `${name.toLowerCase().replace(/\s+/g, '-')}-resume.pdf`,
          note: 'Would really appreciate a referral if you have a moment. Thank you!',
          matchScore: 62 + ((personIndex * 9) % 34),
          // Older requests are mostly dealt with; today's are what needs doing.
          handled: bucket.offset > 0 && index % 3 !== 0,
          handledAt: bucket.offset > 0 && index % 3 !== 0 ? daysAgo(bucket.offset, 18) : null,
          // Left blank on purpose: pressing "Rewrite" in the UI is the fastest
          // way to see the (stubbed) generator actually run.
          draft: null,
        })
      }
    }
  }

  await db.insert(referrals).values(referralRows)

  /* -- activity feed ------------------------------------------------------ */

  await db.insert(activityEvents).values(
    ACTIVITY.map((row) => ({
      userId,
      kind: row.kind,
      emoji: row.emoji,
      text: row.text,
      createdAt: row.at,
    })),
  )

  // createdAt has a database default, so it has to be written back explicitly
  // for the feed to show the intended relative times.
  for (const row of ACTIVITY) {
    await db
      .update(activityEvents)
      .set({ createdAt: row.at })
      .where(sql`${activityEvents.userId} = ${userId} and ${activityEvents.text} = ${row.text}`)
  }

  logger.info(
    {
      email: DEMO_EMAIL,
      applications: applicationRows.length,
      referrals: referralRows.length,
    },
    'seed complete',
  )
  logger.info(`Sign in with  ${DEMO_EMAIL}  /  ${DEMO_PASSWORD}`)
  logger.warn(
    'The seeded resume row points at a file that is not in Supabase Storage — downloading it will fail until a real one is uploaded.',
  )
}

main()
  .then(async () => {
    await closeDatabase()
    process.exit(0)
  })
  .catch(async (error) => {
    logger.error({ err: error }, 'seed failed')
    await closeDatabase()
    process.exit(1)
  })
