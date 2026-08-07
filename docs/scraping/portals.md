# Portal capability matrix

Every row was probed directly on **7 August 2026**, not recalled from memory.
"Verified" means an actual HTTP request was made and the response inspected.
Re-probe before trusting any of this six months from now.

The column that matters most is **posting timestamp**. A daily 06:00 IST sweep
that must return only the last 24 hours is only as good as the freshness signal
the portal gives you. A portal with no timestamp is not a 24-hour source; it is
a "diff against what I saw yesterday" source, which is a different and weaker
thing.

---

## Tier 1 — open, timestamped, sanctioned

These need no browser, no auth, and no argument about whether you should be
doing it. This is where the pipeline should get most of its volume.

| Source | Path | Auth | Timestamp | Verified |
| --- | --- | --- | --- | --- |
| **RemoteOK** | `GET https://remoteok.com/api` — public JSON | none | `epoch` (unix seconds) + ISO `date`. **Exact.** | 200, 100 postings, 251 KB |
| **We Work Remotely** | RSS: `/remote-jobs.rss`, `/categories/<slug>.rss` | none | `<pubDate>` RFC 2822. **Exact.** | 200, 100 items/feed, 826 KB |
| **Greenhouse job boards** | `GET https://boards-api.greenhouse.io/v1/boards/<token>/jobs` | none | `first_published` ISO. **Exact.** | 200 for `careem`, `tamara`, `gitlab`, `stripe` |
| **Ashby job boards** | `GET https://api.ashbyhq.com/posting-api/job-board/<token>` | none | `publishedAt` ISO. **Exact.** | 200, 44 postings, incl. full `descriptionHtml` |
| **Lever postings** | `GET https://api.lever.co/v0/postings/<token>?mode=json` | none | `createdAt` epoch ms. **Exact.** | 200, 388 postings |
| **SmartRecruiters** | `GET https://api.smartrecruiters.com/v1/companies/<co>/postings` | none | `releasedDate` ISO. **Exact.** | 200 for `Visa` |
| **Workable** | `GET https://apply.workable.com/api/v1/widget/accounts/<token>` | none | per-account | 200 (empty for the tokens tried) |
| **Remotive** | `GET https://remotive.com/api/remote-jobs` | none | `publication_date` ISO. **Exact.** | 200 |
| **Jobicy** | `GET https://jobicy.com/api/v2/remote-jobs` | none | `pubDate` ISO. **Exact.** | 200 |
| **Himalayas** | `GET https://himalayas.app/jobs/api` | none | `pubDate` epoch. **Exact.** | 200 |
| **Arbeitnow** | `GET https://www.arbeitnow.com/api/job-board-api` | none | `created_at` epoch. **Exact.** | 200 (301 from apex — follow redirects) |
| **Adzuna** | `GET https://api.adzuna.com/v1/api/jobs/<country>/search/1` | app_id + app_key, free tier | `created` ISO, and a native `max_days_old` filter | 401 without key (expected) |

Notes that bite:

- **RemoteOK requires attribution.** The first element of the API array is a
  legal notice, not a job: you must credit Remote OK and link back to the
  posting URL with a direct, *followed* link, or they suspend access. The UI has
  to render that link. `robots.txt` also sets `Crawl-delay: 1` and a
  `Content-Signal: search=yes, ai-train=no, use=reference` — reading the feed to
  surface jobs is the permitted use; training a model on it is not.
- **RemoteOK's feed lags.** At the time of probing, the newest posting in the
  API was **24.5 hours old** and the feed spanned only 5–6 August. A strict
  24-hour window legitimately returned **zero** RemoteOK jobs. This is not a bug
  in your code — plan for it (see the window-widening note in
  `architecture.md`).
- **Adzuna does not cover the UAE.** Its country list is gb, us, ca, au, de, fr,
  es, it, nl, at, be, br, in, mx, nz, pl, sg, za. Useful for **India**, useless
  for the Gulf.
- Greenhouse/Lever/Ashby/SmartRecruiters are **per-company**, not searchable
  globally. You need a registry of board tokens. That is the cost of using them,
  and it is the right cost to pay.

---

## Tier 2 — grey. Public data, no invitation, no explicit ban

| Source | Reality | Timestamp | Assessment |
| --- | --- | --- | --- |
| **Instahyre** | Undocumented but open JSON: `GET https://www.instahyre.com/api/v1/job_search?limit=35` returns 200 with `objects[]` and `meta.total_count` (1336 at probe time). `robots.txt` is effectively empty (`User-agent: *` with no rules). The HTML page `/search-jobs/` returns **403** — the API is more open than the site. | **None.** No `created`, no `posted`. `reviewed_at` was `null` on every record. | Usable, but it cannot answer "posted in the last 24h". Only viable as a first-seen diff source. |
| **Wellfound** | `/jobs` returns 200 HTML; `/graphql` returns **403** (Cloudflare). `robots.txt` allows `/jobs` but disallows every `?jobId=`/`?role=` query form — i.e. exactly the filtered searches you'd want. | Relative strings in HTML | Needs a browser, fights Cloudflare, and robots disallows the useful URLs. Low value for the effort. |
| **YC Work at a Startup** | `workatastartup.com` returns **406** to any non-browser client, including `/companies` and `/jobs`. `robots.txt` is fully permissive (`Disallow:` empty). Most listings sit behind a login. `ycombinator.com/jobs` does return 200 HTML. | Relative | The permissive robots and the 406 send opposite signals. Browser-only, login-gated, low yield per unit of effort. **Better path: YC companies overwhelmingly use Greenhouse/Lever/Ashby — get them via Tier 1 instead.** |
| **Tanqeeb** (Gulf aggregator) | `robots.txt` returned `202` with an empty body — inconclusive, likely a bot-check shim. | Unknown | Probe again before building. |
| **Huzzle** | `robots.txt` is `Allow: /` with three sitemaps. | Unknown | Worth a look; not yet evaluated in depth. |

---

## Tier 3 — closed. Real ban or block risk

You have already decided how you want to handle these. This section is not an
argument, it is a precise statement of what each one does so you can pick portal
by portal.

| Source | What it actually does | Risk |
| --- | --- | --- |
| **LinkedIn** | `robots.txt` opens with a plain-English prohibition: automated access without express permission is "strictly prohibited", with a whitelist-request email. `Disallow: /jobs-guest/`, `/jobs?runSearch*`, `/api/jobPostings/jobs*`. In Jan 2025 LinkedIn/Microsoft sued **Proxycurl** (CFAA, breach of contract, fraud); Proxycurl shut down in July 2025 under a permanent injunction requiring deletion of all scraped data. LinkedIn also deleted Apollo.io's and Seamless.AI's company pages in 2025. | **Highest.** Account ban is the routine outcome; the enforcement posture against tooling is active and litigated. Doing this from a logged-in session risks the account you need for referrals. |
| **Naukri** | `robots.txt` blocks AI crawlers wholesale (`claudebot`, `gptbot`, `perplexitybot`, `ccbot`, `Google-Extended`, and more — `Disallow: /`). The `User-agent: *` block does not disallow job search paths, but Info Edge's terms prohibit automated collection and confirmed violations lead to suspension, termination, or legal action. Front end is an SPA over an internal API with required custom headers. | **High**, and it is the account you use to job-hunt in India. |
| **Indeed** | The Publisher/Job Search API was retired years ago; there is no self-serve replacement. `robots.txt` `Disallow: /*?rss` kills the old RSS trick, and — decisively for you — `User-agent: *` disallows **`/jobs/AE/`, `/jobs/IN/`, `/jobs/QA/`, `/jobs/KW/`, `/jobs/OM/`, `/jobs/BH/`**. The exact countries you are targeting are the ones explicitly disallowed. | **High**, and pointless: robots forbids precisely your markets. |
| **Bayt** | `robots.txt` disallows `/en/jobs/`, `/ar/jobs/`, `/fr/jobs/` and all `*-jobs/` listing paths for `User-agent: *`, and blocks `LinkedInBot`/`IndeedBot` outright. Every direct fetch attempted (`/sitemap.xml`, `/en/rss/`, `/en/uae/jobs/rss/`) returned **403**. | Blocked in practice and disallowed on paper. |
| **GulfTalent** | Akamai returns **403 Access Denied** on *every* path including `/robots.txt`. There is no polite way in. | Blocked. |
| **NaukriGulf** | Connection **failed outright** (curl exit, no response) from this network, on both `/` and `/robots.txt`. | Blocked / unreachable. |
| **Dubizzle** | `robots.txt` disallows `/api/` and `/sitemap-*`. `jobs.dubizzle.com` 404s. | Disallowed on the useful paths. |
| **startup.jobs, Qureos, edarabia** | Cloudflare **403** on `/robots.txt` and on content. | Blocked. |

---

## Gulf / UAE — the finding that changes the design

**There is no Gulf equivalent of the RemoteOK API.** Every Gulf-native job board
probed is either behind an enterprise WAF or disallows its own job paths:

- Bayt — 403 everywhere, and robots disallows `/en/jobs/`
- GulfTalent — Akamai 403 on every path, robots included
- NaukriGulf — connection refused
- Dubizzle — `/api/` disallowed
- Qureos, edarabia, startup.jobs — Cloudflare 403
- Indeed AE — robots explicitly disallows `/jobs/AE/`
- Adzuna — no UAE coverage at all

Chasing those is how this project burns a month and ships nothing.

**The path that works: go to the employers, not the aggregators.** Gulf startups
and the global remote companies that staff Dubai and Riyadh publish through the
same ATSes as everyone else, and those ATSes expose public board APIs with exact
publish timestamps — the same endpoints that render the companies' own careers
pages. Reading them is the intended use.

Verified live, with Gulf-located openings on the day of probing:

| Employer | ATS | Board token | Gulf roles at probe time |
| --- | --- | --- | --- |
| Careem (Dubai) | Greenhouse | `careem` | 11 of 24 in Dubai/UAE |
| Tamara (Riyadh/Dubai) | Greenhouse | `tamara` | 31 of 42 Gulf-located |
| GitLab (all-remote) | Greenhouse | `gitlab` | 4 of 188 Gulf-eligible |

That last row is the pattern worth exploiting hardest for someone with **no
visa**: all-remote global companies hire into the Gulf without sponsoring, and
they publish on Tier 1 endpoints with exact timestamps. A registry seeded with
Gulf-native startups *plus* remote-first global companies covers the realistic
opportunity space far better than any Gulf job board you can actually reach.

Other Gulf-relevant sources worth adding to the registry over time: **Talabat,
Property Finder, Kitopi, Tabby, Swvl, noon, Alef, Huspy, Floward, TruKKer** —
none matched the naive board tokens tried, so each needs its careers page opened
once to read the real token off the URL. That is a one-time, ten-minute-per-
company job, and it is the honest cost of this approach.

**Recall is the tradeoff.** This is high-precision, low-recall: you only see
companies you have registered. It will not find a role at a company you have
never heard of. Accept that, and compensate by growing the registry
deliberately — it is a far better failure mode than a scraper that gets your
Bayt and LinkedIn accounts banned.

---

## Ranking — freshness × legal safety × implementation cost

**Build now (all Tier 1, exact timestamps, no browser, no ban risk):**

1. **Greenhouse / Ashby / Lever board registry** — the highest-value source for
   this user. Exact timestamps, full descriptions, first-hand data, and the only
   working route into the Gulf. Also the ATS where the application actually
   gets submitted later.
2. **We Work Remotely** — RSS, exact `pubDate`, trivially parsed, welcomes
   aggregation. Best effort-to-value ratio of any single source.
3. **RemoteOK** — public JSON, exact epoch, one request for the whole feed. Cost
   is a link-back you should be rendering anyway. Note the feed lag.
4. **Remotive / Jobicy / Himalayas / Arbeitnow** — four more free, timestamped,
   remote-focused JSON APIs. Near-zero marginal cost once the adapter interface
   exists; they mostly duplicate 2 and 3, which is exactly what the dedupe layer
   is for.
5. **Adzuna** — for the **India** side only. Free key, and a native
   `max_days_old` parameter that does the freshness filter server-side.

**Consider later:**

6. **Instahyre** — open JSON, India-only, but **no timestamp at all**. Only
   worth it once a first-seen store exists.
7. **Huzzle / Tanqeeb** — unevaluated, permissive-looking robots. Probe first.

**Do not build:**

8. **Wellfound** — Cloudflare on the API, robots disallows the useful query
   URLs, and its startups are reachable via Tier 1 anyway.
9. **YC Work at a Startup** — 406 to non-browsers, login-gated. Its companies
   are on Greenhouse/Lever/Ashby. Get them there.
10. **Indeed** — robots disallows every country you care about.
11. **Bayt / GulfTalent / NaukriGulf / Dubizzle** — WAF-blocked and/or
    disallowed. Unreachable regardless of intent.
12. **Naukri** — ban risk on the account you need, SPA + custom headers, and
    prohibited by terms.
13. **LinkedIn** — highest risk of all, actively litigated, and a ban costs you
    the referrals half of this product too.

The uncomfortable but useful summary: **items 1–5 are all Tier 1**, need no
browser automation, and between them cover remote-worldwide, Gulf, and India.
The portals that carry real risk are also the ones with the worst freshness
signals and the highest implementation cost. There is no tradeoff to agonise
over here — the safe sources are also the better sources.
