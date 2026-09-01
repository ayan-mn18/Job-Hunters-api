import type { BrowserContext, Page } from 'playwright-core'
import { logger } from '../lib/logger.js'
import { classifyRole } from '../hunt/role-filter.js'
import { CheckpointError } from './send.js'
import type { Prospect, Relationship } from './rank.js'

/**
 * Finding people who could refer you.
 *
 * Reading, not acting — no invitation is sent from this file. It is still the
 * riskiest kind of reading LinkedIn offers, because people-search at speed is
 * exactly what their scraping detection is tuned for, so it is deliberately
 * slow, capped low, and it stops at the first sign of a checkpoint.
 *
 * The order of the passes matters more than the parsing. Existing connections
 * come first because they need no invitation at all: no search, no risk taken,
 * and the highest conversion rate in the whole engine.
 */

const CHECKPOINT = /checkpoint|challenge|security\s+verification|unusual\s+activity/i

/** Kept small on purpose. The ranker only ever keeps 5–8 of these. */
const MAX_RESULTS_PER_PASS = 25
const MAX_PAGES = 2

async function dwell(page: Page, min = 2_200, max = 5_000): Promise<void> {
  await page.waitForTimeout(min + Math.random() * (max - min))
}

async function assertNoCheckpoint(page: Page, where: string): Promise<void> {
  if (CHECKPOINT.test(page.url())) throw new CheckpointError(where)
  const body = await page.locator('body').innerText().catch(() => '')
  if (CHECKPOINT.test(body)) throw new CheckpointError(where)
}

/** What a search result card gives us, before any scoring. */
interface RawPerson {
  profileUrl: string
  name: string
  title: string | null
  degree: 1 | 2 | 3
  mutualConnections: number
  location: string | null
}

function degreeFrom(text: string): 1 | 2 | 3 {
  if (/(^|\W)1st(\W|$)/i.test(text)) return 1
  if (/(^|\W)2nd(\W|$)/i.test(text)) return 2
  return 3
}

function mutualsFrom(text: string): number {
  const match = text.match(/(\d+)\s+(?:other\s+)?mutual/i)
  return match ? Number(match[1]) : 0
}

/** Strips LinkedIn's tracking query so the same person dedupes by URL. */
function cleanProfileUrl(href: string): string | null {
  try {
    const url = new URL(href, 'https://www.linkedin.com')
    if (!url.pathname.startsWith('/in/')) return null
    return `https://www.linkedin.com${url.pathname.replace(/\/$/, '')}`
  } catch {
    return null
  }
}

async function readResultCards(page: Page): Promise<RawPerson[]> {
  return page
    .locator('li.reusable-search__result-container, div.entity-result, li[class*="result"]')
    .evaluateAll((nodes) =>
      nodes.slice(0, 40).flatMap((node) => {
        const anchor = node.querySelector('a[href*="/in/"]') as HTMLAnchorElement | null
        if (!anchor) return []
        const text = (node as HTMLElement).innerText ?? ''
        const lines = text
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
        // The card repeats the name in the accessible label; the first line
        // that is not a status badge is the closest thing to a title.
        const name = (anchor.innerText ?? lines[0] ?? '').trim()
        const title =
          lines.find(
            (line) =>
              line !== name &&
              !/^(?:1st|2nd|3rd|3rd\+)$/i.test(line) &&
              !/mutual|connection|follower|·/i.test(line) &&
              line.length > 3,
          ) ?? null
        return [{ href: anchor.getAttribute('href') ?? '', name, title, text }]
      }),
    )
    .then((rows) =>
      rows.flatMap((row): RawPerson[] => {
        const profileUrl = cleanProfileUrl(row.href)
        if (!profileUrl || !row.name) return []
        return [
          {
            profileUrl,
            name: row.name,
            title: row.title,
            degree: degreeFrom(row.text),
            mutualConnections: mutualsFrom(row.text),
            location: null,
          },
        ]
      }),
    )
}

async function searchPeople(
  context: BrowserContext,
  params: { company: string; keywords: string; connectionsOnly: boolean },
): Promise<RawPerson[]> {
  const page = await context.newPage()
  const found: RawPerson[] = []
  try {
    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
      const url = new URL('https://www.linkedin.com/search/results/people/')
      url.searchParams.set('keywords', `${params.keywords} ${params.company}`.trim())
      url.searchParams.set('page', String(pageNumber))
      // "F" is LinkedIn's own code for first-degree connections. Filtering
      // server-side means the safest pass never reads a stranger's card.
      if (params.connectionsOnly) url.searchParams.set('network', '["F"]')

      await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await assertNoCheckpoint(page, 'people search')
      await dwell(page)

      const cards = await readResultCards(page)
      found.push(...cards)
      if (cards.length === 0 || found.length >= MAX_RESULTS_PER_PASS) break
    }
    return found.slice(0, MAX_RESULTS_PER_PASS)
  } finally {
    await page.close().catch(() => undefined)
  }
}

export interface CandidateContext {
  /** The role the user is aiming at, used to judge same-function and level. */
  targetRole: string | null
  /** Seniority words in the user's own target, e.g. "senior". */
  targetIsSenior: boolean
  pastEmployers: string[]
  schools: string[]
  city: string | null
  skills: string[]
}

const SENIOR = /\b(?:senior|sr\.?|staff|principal|lead|head|director|vp|chief)\b/i
const JUNIOR = /\b(?:junior|jr\.?|intern|associate|graduate|trainee)\b/i
// Trailing \b would fail on "Recruiter" and "Recruiting" — the boundary
// cannot sit between two word characters. Prefix-match instead.
const RECRUITER = /\b(?:recruit\w*|talent|sourcer|people\s+ops|hiring)\b|\bhr\b/i

/** −1 below the target, 0 the same, +1 one above, +2 further. */
export function levelDeltaFor(title: string | null, targetIsSenior: boolean): number {
  if (!title) return 0
  if (/\b(?:vp|vice\s+president|chief|cto|head\s+of|director)\b/i.test(title)) return 2
  const isSenior = SENIOR.test(title)
  const isJunior = JUNIOR.test(title)
  if (isJunior) return targetIsSenior ? -1 : 0
  if (isSenior) return targetIsSenior ? 0 : 1
  return targetIsSenior ? -1 : 0
}

function relationshipFor(person: RawPerson, context: CandidateContext): Relationship {
  if (person.degree === 1) return 'first_degree'
  const title = person.title ?? ''
  if (context.pastEmployers.some((employer) => employer && title.toLowerCase().includes(employer.toLowerCase()))) {
    return 'ex_colleague'
  }
  if (person.mutualConnections >= 3) return 'strong_mutual'
  return 'cold'
}

export function toProspect(person: RawPerson, context: CandidateContext): Prospect {
  const title = person.title
  const verdict = title ? classifyRole(title) : null
  const isRecruiter = RECRUITER.test(title ?? '')

  return {
    profileUrl: person.profileUrl,
    name: person.name,
    title,
    degree: person.degree,
    relationship: relationshipFor(person, context),
    // A recruiter is a different kind of ask, not the same function.
    sameFunction: !isRecruiter && verdict?.kind === 'software',
    levelDelta: levelDeltaFor(title, context.targetIsSenior),
    isRecruiter,
    // Search cards do not publish education or history. Rather than guess,
    // these stay false and the ranker simply scores affinity lower — an
    // invented shared school in a draft would be worse than a duller note.
    sharedSchool: false,
    sharedEmployer: relationshipFor(person, context) === 'ex_colleague',
    sharedCity: false,
    skillOverlap: 0,
    mutualConnections: person.mutualConnections,
    monthsAtCompany: null,
    activeRecently: false,
    openProfile: false,
  }
}

/**
 * Two passes: existing connections first, then a wider search only if that did
 * not find enough. Most people have more useful first-degree connections than
 * they remember, and every one of them is a person we never have to invite.
 */
export async function findProspects(
  context: BrowserContext,
  params: { company: string; targetRole: string | null; candidate: CandidateContext },
): Promise<Prospect[]> {
  const keywords = params.targetRole ?? 'engineer'
  const seen = new Set<string>()
  const prospects: Prospect[] = []

  const add = (people: RawPerson[]) => {
    for (const person of people) {
      if (seen.has(person.profileUrl)) continue
      seen.add(person.profileUrl)
      prospects.push(toProspect(person, params.candidate))
    }
  }

  try {
    add(await searchPeople(context, { company: params.company, keywords, connectionsOnly: true }))

    // Only widen when the safe pass came up short. If someone already knows
    // eight people at the company there is no reason to touch cold search at
    // all.
    if (prospects.length < 5) {
      add(await searchPeople(context, { company: params.company, keywords, connectionsOnly: false }))
    }
  } catch (error) {
    if (error instanceof CheckpointError) throw error
    logger.warn({ err: error, company: params.company }, 'prospect search failed')
  }

  return prospects
}
