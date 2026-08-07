# 4 — The apply step

Contracts: [`contracts/apply.ts`](./contracts/apply.ts)

> Portal-by-portal specifics — selectors, endpoints, auth flows, current
> detection behaviour — are the scraping agent's research and supersede
> anything here. This document fixes the **seam**: one interface, one field-
> mapping model, and an honest framework for deciding which portals to turn on.

## One interface, four very different mechanisms

Every portal implements `PortalAdapter`. The pipeline calls `discoverFields`,
`submit`, and optionally `pollStatus`, and knows nothing about how they work.
Behind that seam there are four genuinely different things:

| `PortalMechanism` | What it is | Ban risk |
| --- | --- | --- |
| `public_api` | Documented, keyed API or public JSON feed. Nothing to detect. | `none` |
| `ats_form` | A hosted Greenhouse / Lever / Ashby / Workday form the board redirects to. Public URL, no login, a plain HTML form. | `low` |
| `authenticated_form` | A form on the portal itself, behind the user's own session. | `medium` |
| `browser_automation` | Headless browser driving a UI that was never meant for it, on a portal that actively looks for exactly this. | `high` |

**The single most useful fact about this pipeline: a large share of postings on
aggregator boards are not applied to on the board at all.** RemoteOK, We Work
Remotely, and many Wellfound and LinkedIn listings redirect to the employer's
own ATS. That path is `ats_form` — a public URL, no account to lose, no session
to fingerprint. Weight the daily budget toward it. It is both the safest lane
and usually the one where a tailored resume gets read by a human rather than by
a portal's own matching layer.

`PortalCapabilities.redirectsToAts` exists so the adapter can say "I found the
posting, but the application lives over there", and the pipeline can route the
submit to the ATS adapter instead of the board's.

## How an application actually gets submitted

```
ApplyJob
  │  guard: run status is 'running'; budget not exhausted; portal lane open
  ▼
adapter.health(userId)                 session alive? else → auth_expired, pause lane
  │
  ▼
INSERT apply_attempts (state='submitting')      ← intent log, written before any side effect
  │
  ▼
adapter.discoverFields(req)            → DiscoveredField[]
  │
  ▼
mapFields(fields, kit, resume)         → FieldMapResult
  │
  ├── unresolvedRequired.length > 0 ──▶ status: needs_review. Do not submit.
  │                                     Emit newQuestions to My Kit.
  ▼
adapter.submit(req, mapped)            fill → verify → click once
  │
  ▼
ApplyOutcome persisted                 external id, redacted field log, evidence
  │
  ▼
unlink(resumePdfPath); stamp pdf_deleted_at
  │
  ▼
RunEvent: "📮 Applied to Platform Engineer at Otterly"
```

Four properties of that sequence matter more than the steps themselves:

- **The intent log precedes the side effect.** See
  [01-queue-architecture](./01-queue-architecture.md#the-dangerous-window-and-how-it-is-closed).
  A crash after the click never produces a silent duplicate.
- **`submit` must be safe to call twice.** Adapters check for an "already
  applied" marker first and return `already_applied` rather than re-submitting.
- **`simulate: true` runs everything except the click.** This is how a new
  adapter is developed and how a suspected regression is diagnosed, without
  spending a real application.
- **One submission at a time per portal.** `hunt.apply:<portal>` has
  concurrency 1. Two concurrent sessions on one account is the most reliable way
  to get flagged.

## Where the Kit answers get injected

`mapFields` is the join between a discovered form and `KitAnswers`. It is
deliberately boring and deliberately conservative.

**Resolution order, first hit wins:**

1. **Adapter-declared mapping.** A maintained adapter knows that Greenhouse's
   `job_application[answers][3]` is "notice period". Highest confidence, no
   guessing.
2. **Label fingerprint.** Normalise the label (lowercase, strip punctuation and
   boilerplate) and look it up in a curated synonym table:
   `notice period` / `how soon can you join` / `availability to start` →
   `employment.noticePeriodDays`. This table is the actual asset — it grows once
   per new question, forever.
3. **Embedding similarity** against the same table, threshold 0.85, for phrasings
   the table has not seen.
4. **Narrative answers** for open-text questions, keyed by question fingerprint,
   so "why do you want to work here" is answered once and reused.
5. **Unmapped** → `confidence: 0`.

**The rule that keeps this safe: a required field below the confidence
threshold is never guessed.** The application is parked as `needs_review` and
the unanswered question is pushed back into My Kit as a `newQuestion`. A wrong
answer to a screening question is not a neutral outcome — most ATS screening
questions are *knockouts*, so guessing "yes" on work authorisation or an
arbitrary number on expected CTC gets the application auto-rejected and burns
the posting permanently. A parked application can be finished in ten seconds
later; a knocked-out one cannot be redone.

Some specifics worth fixing in the mapper:

- **CTC and salary** are stored as `{amount, currency, period}` and formatted per
  portal — some want `2400000`, some `24 LPA`, some `24,00,000`. Never store the
  formatted string.
- **Notice period** is stored in days and coerced to whatever the dropdown
  offers, rounding *up* to the nearest available option. Rounding down promises
  something the user cannot deliver.
- **Work authorisation** is a boolean plus a country list plus a prose
  statement, because portals ask it all three ways.
- **Voluntary EEO/diversity questions** default to "prefer not to say" unless
  the user has explicitly filled them in. Never inferred, never guessed.
- **Total experience** is derived from the `ResumeDocument` date ranges, not
  typed into the Kit, so it cannot drift from the resume.
- The **resume file name** is generated (`ayan-mansoori-frontend-engineer.pdf`)
  rather than reused — recruiters see it, and `resume_final_v3_REAL.pdf` is a
  bad first impression.

## Per-portal picture

Design-level defaults for the eight portals in the UI. **Verify each against the
scraping agent's research before enabling** — detection behaviour changes and
this table will drift.

| Portal | Likely mechanism | Ban risk | Notes |
| --- | --- | --- | --- |
| **RemoteOK** | `public_api` for discovery; most applications `ats_form` off-site | `none` → `low` | Public JSON feed for listings. The board is not the application target. Best lane in the set. |
| **We Work Remotely** | `public_api`/RSS for discovery; applications off-site or by email | `none` → `low` | Some postings say "email us" — the `email` mechanism, which is fully sanctioned. |
| **Greenhouse / Lever / Ashby** (arrived at by redirect) | `ats_form` | `low` | Not portals in the UI, but where a lot of the volume actually lands. Public forms, no account. Where the daily budget should concentrate. |
| **YC Work at a Startup** | `authenticated_form` | `medium` | Requires a login and a completed profile. Application volume is visible to the operator; high-volume automated applying is noticeable and is the kind of thing that gets a profile deprioritised rather than banned. |
| **Wellfound** | `authenticated_form` | `medium` | Login required, anti-automation present. Account restriction is the realistic downside, not a permanent ban. |
| **Instahyre** | `authenticated_form` | `medium` | One-click apply after login; the mechanics are simple, the account is the exposure. |
| **Naukri** | `authenticated_form` / `browser_automation` | `medium`→`high` | ToS prohibits automated access. Bot detection is real. India-specific, and the account is often tied to a phone number, which makes recovery painful. |
| **Indeed** | `browser_automation` | `high` | Automated access is prohibited and actively defended; there is a documented history of enforcement against scraping. Expect detection over a sustained 100/day pattern. |
| **LinkedIn** | `browser_automation` | `high` | The strictest of the set. Automation is explicitly prohibited, detection is mature, and the account at risk is the user's professional identity and network — the highest-value account they have. Easy Apply automation is precisely the pattern the defences target. |

The user has accepted the risk; that is their call. Two things they still need
in order to make it a *choice* rather than a wager:

1. **Risk is per portal, and the blast radii are not comparable.** Losing a
   Naukri account is an inconvenience. Losing a LinkedIn account removes the
   network, the referral flow (the other half of this product), and the resume
   history. Worth deciding separately from "is automation OK".
2. **The volume is what gets detected, not the automation.** 100/day
   concentrated on one high-risk portal is a different proposition from 100/day
   spread across three `ats_form` lanes and one authenticated one. The budget
   allocator should default to filling from low risk upward, and the UI should
   show the split.

### Controls the design provides

- `PortalCapabilities.recommendedDailyCap` is a hard ceiling the user's target
  cannot override. Reallocation goes to lower-risk lanes.
- `banRisk` is surfaced next to each portal toggle on the Hunt screen, so
  turning on LinkedIn is an informed click.
- `captcha` and `auth_expired` **pause the lane and never retry** — retrying
  into a bot wall is what escalates throttling into a ban.
- A `high`-risk portal defaults to `simulate: true` on first enable, so the user
  sees exactly what would be submitted before anything is.
- The kill switch is one flag (`runs.status = 'stopped'`), checked at the top of
  every job.
- Recommend a dedicated account for `high`-risk portals where the portal permits
  it — not as a bypass, but so the blast radius is a job-hunting account rather
  than a professional identity.

## Verification and status

`submit` does not trust its own click. After submitting it looks for a positive
confirmation — a success page, an application id, a state change on the listing
— and captures one screenshot as `evidencePath`. No confirmation means
`status: 'failed'` with `FailureClass` set, not an optimistic `submitted`. An
application recorded as sent but never actually sent is the worst failure mode
in the product, because the user stops applying to that job.

`pollStatus` is optional and only a few portals support it. Where it exists, a
low-frequency sweep (once daily, in the janitor window) drives the
`viewed → interview → rejected` transitions the Applications screen already
renders. Where it does not, status stays `applied` until the user updates it or
an email arrives — which is what the Referrals-side Gmail integration is
already positioned to notice.
