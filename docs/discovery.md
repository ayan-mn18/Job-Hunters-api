# Discovery

**Query planner → tiered connectors → merge → two-stage rank.**

## What was wrong

Discovery could not find what it was never told to look for.

`hunt_specs.roles` and `.locations` were read only by the *scorer*, after
results had already arrived. The network saw a hardcoded list of ~110 company
board tokens in `boards.ts` — the same list for every user, chosen once. A user
asking for "backend engineer in Bengaluru" got whatever those boards happened
to be posting, and then had it ranked.

That is a fixed crawl wearing the costume of a search, and no amount of ranking
work fixes it: better scoring only reorders the wrong list.

## The planner

`planner.ts` turns a person into searches: their roles expanded through a
synonym table into the phrasings boards actually use, crossed with the markets
their locations imply, round-robined so one market cannot eat the budget.

Two details that matter:

- **Synonyms are not decoration.** Searching `SDE` misses every posting that
  said "Software Engineer", and the reverse is just as true — both phrasings
  are common in India, and a keyword search matches the words a posting used.
- **Remote is always included.** A remote role is open to someone in Bengaluru
  and someone in Dubai alike, so it is never a market the user has to remember
  to ask for.

The budget is 30 queries, and the sub-caps (8 titles × 5 markets = 40 possible)
are set so the budget is what actually binds.

## The tiers

| Tier | Sources | Why |
|---|---|---|
| **1 — licensed search** | Google for Jobs (JSearch or SerpApi), Adzuna, Jooble | Keyword and location aware. **This is what reaches LinkedIn, Naukri, Foundit, Bayt and Indeed listings** — through Google's index, with no session and no ToS exposure. |
| **2 — employer ATS** | Greenhouse, Lever, Ashby, SmartRecruiters, Workable, plus the remote boards | Best data, and the most reliable apply URLs. Crawl-only: they list what is recent and ignore the query plan. |
| **3 — session** | Not enabled | The user's own logged-in account. Opt-in, off by default. |

Tier 1 is always included when configured, regardless of which portals the user
has ticked — they are the only sources that can act on what the user asked for,
so excluding them over an unticked checkbox would defeat the point.

A connector with no API key reports an `unavailableReason` and is skipped. The
reason reaches the run's progress, so the UI can say what would make it work
instead of silently returning less.

## Company boards

`boards.ts` is now a *seed*, not the universe. `company_boards` holds them, and
rows arrive three ways: the original seed, a dream company resolved by probing
each ATS for a slug derived from its name, and companies seen in tier-1
results.

Probing is a guess and only stores a board that actually answers. The
alternative is asking users to know which applicant tracking system their dream
employer runs, which nobody knows. In the first real run this resolved Razorpay
— a company the hardcoded list never contained.

Boards that stop answering accumulate `consecutiveFailures` and are parked
after five, rather than costing a request and a warning on every run forever.

## Merge

Fingerprint dedupe catches byte-identical repeats. `canonicalise.ts` catches
the real case: an ATS publishes a role, an aggregator republishes it with a
shortened description, Google indexes both.

**Which copy survives matters more than it looks.** The aggregator's URL
usually lands on an interstitial the apply runtime cannot complete; the ATS
copy is a form it can fill. So an applicable URL beats a longer description —
a rich listing nobody can apply through is worth less than a thin one they can.
The discarded copy's tags are kept, so the user still sees the role was also on
LinkedIn.

## Two-stage ranking

**Stage A** (`ranking.ts`) scores everything: skill coverage, stack, seniority,
location. Fast, free, and every component is visible to the user.

**Stage B** (`rerank.ts`) reads the posting. Stage A will happily rank a job it
does not understand — a "Backend Engineer" role that is really three years of
maintaining a legacy monolith scores the same as one building what the
candidate wants, because the words match.

It runs on the top 120 only, is cached on `(descriptionHash, personaVersion)`
so a reposted job is free and editing the hunt spec invalidates the verdict,
and it returns a fit score, a rationale, and an explicit *why not* — always
filled in, even for a strong match.

The two are **blended half and half**, deliberately. Handing the whole ranking
to a model would make "why is this job first" unanswerable; keeping the model
out entirely leaves stage A unable to tell a good posting from one that merely
matches keywords. Half and half lets the model rescue or sink a job without
either being able to act alone.

Without `ANTHROPIC_API_KEY`, stage B is skipped and stage A stands. A failed
batch keeps its stage-A scores — a slightly worse ordering beats a dead run.

## Traceability

Every tier-1 search is written to `search_queries` with its result count and
duration, and `GET /hunt/runs/:id/queries` returns them alongside the plan and
the list of unavailable connectors.

This exists so "why didn't I see the job at X?" has an answer. It is one of
three things — the search was never issued, it was issued and returned nothing,
or it returned the job and the scorer rejected it — and they need different
fixes. Without these rows, all three look identical.

Crawl sources issue no queries, so an empty list is not the same as "nothing
was searched"; the endpoint says so explicitly.

## Measured

One run against the demo account, no tier-1 keys configured:

- 630 jobs from 8 crawl sources in ~23 s (the gate is 500 in under 3 minutes)
- 61 candidates above threshold, 4 distinct sources in the top 20
- Plan: 24 queries across 8 titles and 3 markets (remote, AE, IN)
- 4 dream companies resolved to boards, 0 unresolved
- 3 connectors correctly reported as unavailable, each with the key that would enable it
