# Scraping architecture

Companion to [`portals.md`](./portals.md), which establishes what each portal
actually exposes. This document answers the design question: how the daily sweep
is built, and whether it needs a browser.

---

## The verdict on browser automation

**No. Do not build the pipeline around a headless browser.**

Every source worth ingesting — RemoteOK, We Work Remotely, Greenhouse, Ashby,
Lever, SmartRecruiters, Remotive, Jobicy, Himalayas, Arbeitnow, Adzuna — is a
plain HTTP `GET` returning JSON or RSS with an exact publish timestamp. The
proof-of-concept in `spikes/scraper/` pulls **531 postings across three portals
in under 5 seconds** using nothing but `undici`. A browser would make that
slower, heavier, and no more capable.

The portals that *would* require a browser are, without exception, the ones you
should not be scraping anyway:

| Portal | Needs a browser because | But also |
| --- | --- | --- |
| LinkedIn | SPA + auth wall + bot detection | Terms prohibit it; Proxycurl was sued into shutdown and permanently enjoined in 2025 |
| Naukri | SPA over a header-signed internal API | Terms prohibit it; ban risk on the account you job-hunt with |
| Wellfound | Cloudflare on `/graphql` | robots disallows the query URLs you'd want |
| YC WaaS | 406 to non-browser clients, login-gated | Its companies are all on Greenhouse/Lever/Ashby |
| Bayt / GulfTalent | Akamai/Cloudflare WAF | 403 on every path including `robots.txt` — a browser does not fix a WAF ban, it just makes evading one look deliberate |

That last point is the one that settles it. A headless browser is not a
capability that unlocks these portals; it is an escalation in a fight you would
be choosing to have. The cost is not just legal — it is a permanently brittle
pipeline whose failures land on your own accounts.

**The correct architecture is tiered, and tier 3 stays empty.**

### Tier 1 — official API or feed (target: 100% of volume)

`undici` for HTTP. Chosen over global `fetch` because we want an explicit
`Agent`: connection pooling, per-host limits, our own header/body timeouts, and
composable interceptors for redirects and gzip. It is the same engine Node's
`fetch` is built on, minus the parts you cannot configure.

- JSON → `JSON.parse`. No library needed.
- RSS/Atom → `fast-xml-parser`. Faster than `xml2js` and, importantly, it has
  billion-laughs guards on entity expansion. Those guards bite on real feeds —
  see "What running it actually taught us" below.

### Tier 2 — plain HTTP + HTML parse (target: rare, and only where robots permits)

`undici` + `cheerio`. Cheerio is a jQuery-shaped API over `parse5`; it is
parse-only with no layout, no JS execution, and is roughly two orders of
magnitude cheaper than a browser page load.

Before writing a tier-2 adapter, check for embedded structured data first. Many
job pages carry a `<script type="application/ld+json">` block with
`schema.org/JobPosting`, which includes a real `datePosted`. Parsing that is
dramatically more stable than CSS selectors, because it is contractual output
aimed at Google rather than incidental markup.

### Tier 3 — headless browser (target: zero adapters)

If a genuinely sanctioned source ever demands JS execution, use **Playwright**,
not Puppeteer:

- Cross-browser (Chromium/Firefox/WebKit) from one API; Puppeteer is
  Chromium-first.
- Auto-waiting built into every action, which removes the sleep-and-pray retry
  code that makes Puppeteer scripts flaky.
- First-class `BrowserContext` isolation and `context.storageState()` for
  cookie/session handling.
- Better tracing and video artefacts, which matters when a nightly job fails at
  00:30 UTC and you are asleep.

Puppeteer is only preferable if you are already deep in a Chrome DevTools
Protocol codebase. You are not.

Budget for tier 3 if you ever add it: ~300 MB of browser binary, ~200–400 MB RSS
per context, and roughly 50–100× the wall time of an HTTP fetch. Isolate it in
its own worker with its own concurrency limit so a hung page cannot starve the
tier-1 adapters.

---

## The 24-hour freshness filter

This is the part that looks trivial and is not. Implementation:
`spikes/scraper/src/freshness.ts`.

### Everything is UTC, always

The cron fires at **06:00 Asia/Kolkata = 00:30 UTC**. That `:30` is the trap:
IST is `UTC+05:30`, so any arithmetic that assumes whole-hour offsets is wrong
here. The rules:

1. Store and compare **only** UTC. `ScrapedJob.postedAt` is always ISO 8601 UTC.
2. IST exists in exactly two places: the cron expression, and rendering for
   humans (`formatIST()`).
3. Never reconstruct a date from local components. `new Date(y, m, d)` uses the
   server's timezone and will differ between your laptop and the deploy box.
4. Set `TZ=UTC` on the worker process so a misconfigured host cannot change
   behaviour.
5. Schedule the cron with an explicit timezone (`{ tz: 'Asia/Kolkata' }`) rather
   than hardcoding `30 0 * * *` UTC — India has no DST today, but expressing
   intent beats encoding a coincidence.

### A relative string is an interval, not an instant

"3 days ago" does not mean a point in time. Boards floor rather than round, so
it means *somewhere between 3 and 4 days ago*. Modelling that as a single
instant either drops fresh jobs or admits stale ones.

So every source date resolves to a `PostedInterval { earliest, latest,
precision }`, and a posting is kept when that interval **overlaps** the window:

```ts
type PostedAtPrecision = 'exact' | 'day' | 'relative' | 'first-seen'
```

- `exact` — epoch or ISO timestamp. Strict comparison. Every Tier 1 source gives
  this.
- `day` — date with no time. The interval is the whole UTC day.
- `relative` — parsed from text. `[now - (n+1)·unit, now - n·unit]`.
- `first-seen` — the portal gave nothing usable (Instahyre). The timestamp is
  when *we* first observed the posting.

Overlap rather than containment means borderline jobs are **included**.
Over-including costs one scoring pass. Under-including means the user never sees
the job at all. The asymmetry is obvious once stated, and it should drive every
judgement call in this layer.

Clock skew is handled by allowing `latest` up to 6 hours into the future — some
boards stamp postings ahead of real time, and discarding those would drop the
newest listings.

### Portals with no timestamp: the first-seen store

For a source like Instahyre — open JSON, stable ids, no date field anywhere —
freshness comes from diffing:

- Redis set `seen:<portal>`, member `sourceId`, value = first-seen timestamp.
- A `sourceId` absent from the set is new; record `postedAt = now`,
  `precision = 'first-seen'`.
- TTL entries at ~30 days so the set does not grow without bound.

**Critical caveat:** on the first run, *every* posting looks new. Suppress
first-seen sources on cold start, or the user gets 1,336 "new" Instahyre jobs on
day one. Only trust `first-seen` once the store has been running longer than the
freshness window.

### Widen the window, then dedupe

The PoC surfaced a real operational fact: **RemoteOK's newest posting was 24.5
hours old**, so a strict 24-hour window returned zero jobs from it. Feeds lag,
cron runs drift, and a run that fails and retries an hour late will silently
lose an hour of postings.

Fix: sweep a **26–30 hour** window and rely on the ingest-side unique constraint
on `(portal, sourceId)` to discard what you already have. The overlap costs a
few hundred wasted comparisons and buys immunity to feed lag and missed runs.
Never let the freshness window be the only thing preventing duplicates.

---

## Deduplication

The same role appears on RemoteOK, WWR, the company's Greenhouse board and
LinkedIn, with four ids, four URLs and four slightly different titles.
Implementation: `spikes/scraper/src/normalise.ts`.

**The fingerprint** is a SHA-1 of `canonicalCompany :: canonicalTitle ::
countryBucket`, deliberately excluding portal, URL, id, description and salary —
precisely the fields that differ between two listings of the same job.

- `canonicalTitle` strips parentheticals (`(Remote)`, `[Contract]`), drops
  everything after a separator, and expands `Sr.`→senior, `Eng`→engineer.
- `canonicalCompany` strips legal suffixes, including the Gulf-specific ones
  that matter here: `FZ`, `FZE`, `FZCO`, `DMCC`, `PJSC`, alongside `Inc`, `Ltd`,
  `GmbH`, `Pvt`.
- The country bucket keeps a genuinely different Dubai vs Bengaluru opening at
  the same company as two jobs.

**Which copy wins** is ranked: company ATS > aggregator (first-hand data, and
the ATS is where the application is actually submitted later), then exact
timestamp over fuzzy, then the richer description. Losers are not discarded —
they are recorded in `alsoSeenOn[]`, which is genuinely useful signal: a job
cross-posted to four boards is being pushed hard.

This works. In the PoC it correctly collapsed *"Associate Solutions Architect
(French or German fluency)"* at GitLab, posted to a Spain board and an Ireland
board three seconds apart, into one job.

For a production system, add a second pass: near-duplicate detection on
`descriptionText` via SimHash or MinHash, catching cases where the title differs
too much for exact-match canonicalisation. Do it as a *review* step, not an
auto-merge — false merges silently hide jobs, which is the failure mode you can
least afford.

---

## Politeness and durability

Implementation: `spikes/scraper/src/http.ts`.

- **Identify honestly.** A real UA string with a contact URL. This is what
  separates a well-behaved daily sweep from something that looks like an attack,
  and it gives an operator someone to email instead of someone to block.
- **One request in flight per host**, with a configurable minimum gap
  (default 1.1s; RemoteOK's `robots.txt` asks for `Crawl-delay: 1`). Adapters
  run in parallel because they hit different hosts; each host stays serialised.
- **Retry with exponential backoff and full jitter**, honouring `Retry-After`.
  Full jitter, not fixed backoff, so parallel adapters that trip the same limit
  do not retry in lockstep.
- **Conditional GET.** Store `ETag`/`Last-Modified` per URL (Redis hash in
  production; in-memory in the spike) and send `If-None-Match` /
  `If-Modified-Since`. An unchanged feed then costs one 304 — this is what keeps
  a daily sweep cheap and keeps you off the portals' radar.
- **Respect robots.txt** for tier-2 HTML sources. For a documented API whose
  terms grant access it is not the governing document, but for anything you are
  reading off a web page it is. Fetch it once per host per day and cache it.
- **Sessions/cookies:** not needed. Every Tier 1 source is unauthenticated, and
  that is a feature. No adapter should ever hold portal credentials. If one ever
  must, it belongs in a separate worker with its own secret scope, and
  credentials must never be logged — the `raw` field on `ScrapedJob` should be
  scrubbed before it goes anywhere near a log line.

### Detecting breakage fast

A scraper does not fail loudly when markup changes — it silently returns zero.
Every adapter returns `warnings[]` alongside its jobs, and the runner surfaces
them. The signals that matter:

- **Zero jobs from a source that is normally non-zero.** The single most
  important alarm. Alert on it per portal.
- **Volume anomaly.** Compare against a 7-day rolling median per portal; alert
  outside roughly ±60%.
- **Structural assertions**, not just parse success. RemoteOK's adapter warns if
  the legal-notice row disappears. WWR's warns if a feed returns 100 items *and
  all of them are inside the window*, which means the feed is truncating and
  postings are being missed.
- **Field-level null rates.** A jump in "missing company" means the markup moved
  even though the fetch still returns 200.
- **Contract tests in CI** hitting each live endpoint weekly and asserting the
  shape. Portals change quietly; you want to hear it from CI, not from a user
  wondering why no jobs arrived.

---

## The two interfaces

Full definitions: `spikes/scraper/src/types.ts`. The shape held up unchanged
across a JSON API, an RSS feed and a multi-tenant ATS, which is the evidence
that matters.

```ts
interface ScrapedJob {
  sourceId: string            // portal-native id; unique within portal
  portal: PortalId
  url: string                 // canonical posting URL (RemoteOK requires this be rendered)
  applyUrl?: string

  title: string
  company: string
  companyDomain?: string

  locations: NormalisedLocation[]   // { raw, city, country, countryCode, isRemote }
  remote: 'remote' | 'hybrid' | 'onsite' | 'unknown'
  employmentType?: string

  descriptionHtml?: string
  descriptionText?: string
  tags: string[]
  salary?: SalaryRange

  postedAt: string            // ISO 8601, always UTC
  postedAtPrecision: PostedAtPrecision
  fetchedAt: string

  fingerprint: string         // cross-portal dedupe key
  raw?: unknown               // untouched payload, for debugging and re-parsing
}

interface PortalAdapter {
  readonly id: PortalId
  readonly label: string
  readonly tier: 1 | 2 | 3
  readonly legal: 'sanctioned' | 'permitted-by-robots' | 'grey' | 'prohibited'
  readonly legalNote: string
  fetchRecent(ctx: AdapterContext): Promise<AdapterResult>
}
```

Three deliberate choices:

- **`legal` and `legalNote` live on the adapter.** The compliance posture is a
  property of the code, visible in the run report, and reviewable in a diff —
  not a note in a wiki that goes stale.
- **`postedAtPrecision` travels with `postedAt`.** A consumer that does not know
  how much to trust a timestamp will misuse it. Making precision impossible to
  ignore is the point.
- **An adapter returns warnings rather than throwing.** One dead board must not
  sink the sweep. `AdapterResult.error` is for total failure; `warnings[]` is
  for the partial degradation that is the normal case.

Adding a portal is one file exporting one `PortalAdapter`, plus one line in the
registry. Nothing else in the system changes.

---

## Where this lives relative to the API

**A separate worker process, not the API process.** Non-negotiable: a sweep is
minutes of I/O-bound work with unpredictable latency, and it must never share an
event loop with request handling. Separate process means separate scaling,
separate memory limits, separate crash blast radius, and the option to put the
browser worker (if it ever exists) on its own box.

```
Job-Hunters-api/
  src/                  HTTP API                       ← another agent owns this
  src/scraping/         adapters + normalise + http    ← promoted from this spike
  src/workers/          BullMQ workers                 ← another agent owns this
```

The scraping module is a **pure library**: adapters in, `ScrapedJob[]` out. It
knows nothing about Redis, BullMQ, or the database. That is what makes it
testable without infrastructure and what keeps this handoff clean.

### Handoff to the queue (owned by the other agent)

The BullMQ/Redis pipeline is being designed separately. This module's contract
with it is deliberately minimal — **the queue owns scheduling, retries and
concurrency; the scraping module owns fetching and normalising**:

```ts
// What the worker calls. The only entry point the queue needs.
async function runAdapter(
  portalId: string,
  ctx: AdapterContext,
): Promise<AdapterResult>
```

Suggested shape, for the queue designer to accept or reject:

- **One repeatable job per portal**, not one job for the whole sweep. A portal
  that fails or rate-limits retries alone, and portals are naturally parallel.
  Cron: `30 0 * * *` UTC, or `0 6 * * *` with `tz: 'Asia/Kolkata'`.
- **Job data in:** `{ portalId, sinceIso, nowIso, maxItems }`. `since` and `now`
  are computed by the scheduler once and passed to every portal job, so all
  portals in a sweep share one window even if they start minutes apart.
- **Job result out:** `AdapterResult` — `{ portal, seen, jobs, warnings, error,
  durationMs }`.
- **Dedupe and persistence are a separate downstream job**, fanned in after the
  portal jobs settle. It must dedupe across the whole sweep, so it cannot live
  inside a per-portal job.
- **Idempotency at the DB layer:** unique index on `(portal, source_id)`, upsert
  on conflict. Combined with the widened window, a retried or double-run job is
  harmless. Do not rely on the queue for exactly-once — rely on the constraint.
- **Rate limiting stays in `http.ts`**, not in BullMQ. It is per-host, and
  several adapters share hosts (Greenhouse boards for many companies). The
  queue's limiter is per-queue and cannot express that.

Everything after this — scoring against the user's spec, resume tailoring,
submitting applications — consumes `ScrapedJob` and nothing else.

### Mapping onto the pipeline contract as it currently stands

The queue design in [`../pipeline/contracts/pipeline.ts`](../pipeline/contracts/pipeline.ts)
already models this stage, and the two line up well. `ScrapeJob { portal, since,
query, cursor }` is very close to `AdapterContext`, and one scrape lane per
portal (`hunt.scrape:${portal}`) is exactly the sharding recommended above.
`jobs.dedupe_key` is this module's `fingerprint` — `normalise.ts` can produce it
directly.

Three gaps worth resolving between the two, in priority order:

1. **`RawPosting` has `postedAt?: string` with no precision field.** This is the
   important one. A consumer cannot tell an exact epoch from a parsed "3 days
   ago", and will inevitably treat them alike. Recommend adding
   `postedAtPrecision` alongside it, and — given every Tier 1 source supplies a
   real timestamp — making `postedAt` required, with `'first-seen'` as the
   honest precision value for sources that have no date at all.
2. **`RawPosting.location` is a single string.** Multi-location postings are the
   norm, not the exception: GitLab's Greenhouse board routinely lists four
   countries on one role, and We Work Remotely's `region` field can carry
   twenty-six. Flattening loses the country signal the Gulf and India filters
   depend on. Recommend `locations: NormalisedLocation[]`.
3. **`ScrapeJob.since` is present but there is no `now`.** Resolving relative
   dates and clamping future-dated postings both need the run's wall clock, and
   it must be the *scheduler's* clock so every portal in a sweep shares one
   window. Recommend passing `now` alongside `since`.

Everything else maps without change.

---

## What running it actually taught us

The spike was run, not just written. Three things only showed up on execution,
and all three are the kind that would otherwise have shipped silently:

1. **`fast-xml-parser` silently cost us the entire WWR feed.** Its
   billion-laughs guard defaults to `maxTotalExpansions: 1000`, and WWR embeds
   full HTML descriptions as escaped entities — ~1,100 per feed. Every feed
   threw, the adapter caught it, logged a warning, and returned zero jobs. **A
   scraper that returns zero looks exactly like a quiet day.** Raising the
   ceiling (not disabling the guard) took WWR from 0 to 11 fresh jobs. This is
   the strongest possible argument for the zero-jobs alarm above.

2. **RemoteOK's feed lags ~24 hours.** Newest posting at probe time was 24.5h
   old; a strict 24-hour window returned zero. Not a bug — an operational fact
   that motivates the widened window.

3. **The dedupe fires on same-portal duplicates too**, which was unplanned and
   correct: GitLab posting one role to a Spain board and an Ireland board three
   seconds apart is genuinely one job.

### Known limitations of the spike

Stated plainly so they are not mistaken for finished work:

- **`normaliseLocations` does not split comma-separated country lists.** WWR's
  `region` field can carry 26 countries in one string; the parser produces a
  single location and takes the first country match. The Gulf filter still
  catches it, but the location data is lossy.
- **Conditional-GET cache is in-memory**, so it is useless across process
  restarts. Redis in production.
- **No first-seen store**, so no timestamp-less portal is implemented.
- **The Gulf registry has three entries.** It works; it is not comprehensive.
  Growing it is the real ongoing cost of the Gulf strategy.
