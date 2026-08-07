/**
 * We Work Remotely — Tier 1, sanctioned.
 *
 * WWR publishes RSS: a firehose at /remote-jobs.rss and per-category feeds at
 * /categories/<slug>.rss. Every <item> carries a real RFC 2822 <pubDate>, which
 * is what makes the 24-hour filter trustworthy here.
 *
 * robots.txt allows everything except account and admin paths, and an RSS feed
 * is published precisely so it can be read by machines. The feed is capped at
 * 100 items, so a daily sweep is comfortably inside it — but if WWR ever posts
 * more than 100 jobs in a day we would silently truncate, so the adapter warns
 * when the oldest item in the feed is still inside our window.
 *
 * The company name is not its own element: WWR encodes it in the title as
 * "Company: Role". The description is HTML with a "Headquarters:" preamble.
 */
import { XMLParser } from 'fast-xml-parser'
import { fetchText } from '../http.ts'
import {
  fingerprintOf,
  inferRemoteMode,
  normaliseLocations,
  stripHtml,
} from '../normalise.ts'
import { isWithinWindow, representativeInstant, toInterval } from '../freshness.ts'
import type { AdapterContext, AdapterResult, PortalAdapter, ScrapedJob } from '../types.ts'

/**
 * Category feeds rather than the firehose: they are the same data sliced, and
 * pulling only the engineering ones keeps us relevant and keeps the byte count
 * down. The firehose is the fallback if a category slug ever 404s.
 */
const FEEDS = [
  'https://weworkremotely.com/categories/remote-programming-jobs.rss',
  'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss',
  'https://weworkremotely.com/remote-jobs.rss',
]

interface WwrItem {
  title?: string
  region?: string
  country?: string
  category?: string
  type?: string
  description?: string
  link?: string
  guid?: string | { '#text'?: string }
  pubDate?: string
}

/**
 * WWR embeds each job's full HTML description as escaped entities, so one feed
 * legitimately contains tens of thousands of them. fast-xml-parser defaults to
 * maxTotalExpansions: 1000 and maxExpandedLength: 100_000 as a billion-laughs
 * guard, and throws past either — which silently cost us the entire feed until
 * the spike was actually run. We raise the ceilings rather than disable the
 * guard: these feeds are ~1MB, so the limits below still stop a hostile payload.
 *
 * The v4 typings only describe the boolean form of processEntities, hence the
 * cast; the object form is what the runtime reads.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  processEntities: {
    enabled: true,
    maxTotalExpansions: 500_000,
    maxExpandedLength: 20_000_000,
    maxEntityCount: 100_000,
  },
} as unknown as ConstructorParameters<typeof XMLParser>[0])

/** WWR titles read "Company: Role". Fall back to the whole string. */
function splitTitle(raw: string): { company: string; title: string } {
  const idx = raw.indexOf(':')
  if (idx > 0 && idx < raw.length - 1) {
    return { company: raw.slice(0, idx).trim(), title: raw.slice(idx + 1).trim() }
  }
  return { company: 'Unknown', title: raw.trim() }
}

export const weWorkRemotelyAdapter: PortalAdapter = {
  id: 'weworkremotely',
  label: 'We Work Remotely',
  tier: 1,
  legal: 'sanctioned',
  legalNote:
    'Public RSS feeds published for machine consumption. robots.txt allows all job paths. Link back to the WWR posting.',

  async fetchRecent(ctx: AdapterContext): Promise<AdapterResult> {
    const started = Date.now()
    const warnings: string[] = []
    const jobs: ScrapedJob[] = []
    const seenGuids = new Set<string>()
    let seen = 0

    for (const feed of FEEDS) {
      if (jobs.length >= ctx.maxItems) break

      let xml: string
      try {
        const res = await fetchText(feed, { headers: { accept: 'application/rss+xml' } })
        xml = res.body
      } catch (err) {
        warnings.push(`feed failed ${feed}: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }

      let items: WwrItem[]
      try {
        const doc = parser.parse(xml)
        const channel = doc?.rss?.channel
        if (!channel) {
          warnings.push(`no rss>channel in ${feed} — feed format changed`)
          continue
        }
        const raw = channel.item
        items = Array.isArray(raw) ? raw : raw ? [raw] : []
      } catch (err) {
        warnings.push(`unparseable XML from ${feed}: ${err instanceof Error ? err.message : err}`)
        continue
      }

      if (items.length === 0) {
        warnings.push(`zero items in ${feed}`)
        continue
      }
      seen += items.length

      let oldestInFeed = Number.POSITIVE_INFINITY
      const fetchedAt = new Date().toISOString()

      for (const item of items) {
        const guidRaw = typeof item.guid === 'object' ? item.guid?.['#text'] : item.guid
        const guid = String(guidRaw ?? item.link ?? '')
        if (!guid || seenGuids.has(guid)) continue

        const interval = toInterval(item.pubDate, ctx.now)
        if (!interval) {
          warnings.push(`unparseable pubDate "${item.pubDate}" on ${guid}`)
          continue
        }
        oldestInFeed = Math.min(oldestInFeed, interval.earliest.getTime())

        if (!isWithinWindow(interval, ctx.since, ctx.now)) continue
        seenGuids.add(guid)

        const rawTitle = String(item.title ?? '').trim()
        if (!rawTitle) {
          warnings.push(`item with no title in ${feed}`)
          continue
        }
        const { company, title } = splitTitle(rawTitle)
        if (company === 'Unknown') {
          warnings.push(`could not split company from title "${rawTitle}"`)
        }

        const locationRaw = [item.region, item.country].filter(Boolean).join(', ') || 'Remote'
        const locations = normaliseLocations(locationRaw)
        const descriptionHtml = item.description ? String(item.description) : undefined

        jobs.push({
          sourceId: guid,
          portal: 'weworkremotely',
          url: String(item.link ?? guid),
          title,
          company,
          locations,
          remote: inferRemoteMode(`${locationRaw} remote`, locations),
          employmentType: item.type ? String(item.type) : undefined,
          descriptionHtml,
          descriptionText: stripHtml(descriptionHtml),
          tags: item.category ? [String(item.category).toLowerCase()] : [],
          postedAt: representativeInstant(interval, ctx.now).toISOString(),
          postedAtPrecision: interval.precision,
          fetchedAt,
          fingerprint: fingerprintOf({ title, company, locations }),
          raw: item,
        })

        if (jobs.length >= ctx.maxItems) break
      }

      // If even the oldest item in a capped feed is still fresh, the feed is
      // full and we are probably missing older-but-still-in-window postings.
      if (items.length >= 100 && oldestInFeed >= ctx.since.getTime()) {
        warnings.push(
          `${feed} returned ${items.length} items and all are inside the window — feed may be truncating`,
        )
      }
    }

    return {
      portal: 'weworkremotely',
      seen,
      jobs,
      warnings,
      durationMs: Date.now() - started,
    }
  },
}
