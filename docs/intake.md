# Adaptive intake

The server picks each question. The browser renders what it is handed and
posts the answer back — there is no question list in the UI, and that is the
point.

## What was wrong

The old wizard asked the same six steps of everyone. It asked for things the
resume had just told us, and it asked for things that change nothing about
which jobs get found — phone number, notice period, current CTC. Those are
needed once, to fill a form, at the moment of the first application.

## Two rules

**Only ask about what the system can act on.** A question about company stage
or preferred domain sounds insightful, but nothing downstream reads the
answer — not the query planner, not the scorer. Asking it would be theatre.
Every intake slot feeds one or both.

**Form fields are not intake.** They live in the same catalogue marked
`stage: 'apply'`, so the intake never asks for them. That is most of what made
the old wizard feel long.

## Seeding

The first call to `/intake/next` reads the parsed resume, the kit, and any hunt
spec, and fills the persona before asking anything. Each slot records where its
value came from and how confident we are:

| Source | Confidence | Why |
|---|---|---|
| An explicit hunt spec | 0.9 | The user's own words |
| A title containing "Senior" | 0.85 | Their own word for their level |
| Years of experience | 0.7 | An arithmetic guess, so it loses to a title |
| Last job titles → target titles | 0.55 | What they *did* is a guess at what they *want*, not the same thing — deliberately below the confident-enough bar so it stays askable |
| Home city → markets | 0.45 | Where they live is not where they want to work |

## Choosing the question

Not "which slot are we least sure about" — uncertainty is easy to measure and
the wrong objective. A question is worth asking only if the answer changes
**which jobs the user sees**.

Each unknown slot is scored by simulating its plausible answers and measuring
how much the results disagree, on two axes:

- **Ranking** — top twenty over a pool of 300 real postings, per branch, compared by Jaccard.
- **Search** — the query plan each branch would issue, compared the same way.

Impact is the larger of the two, scaled by how unsure we already are. Below
`IMPACT_FLOOR` (0.12) nothing is asked. Cap is 7; the target is 5.

**Why both axes.** Measuring only the ranking scored `location_mode` at exactly
zero: a pool of already-scraped postings barely reorders when you change remote
preference. But it rewrites the *search*. Without the second axis, a question
the user genuinely needs to answer was unaskable.

## What the measurement caught

Building the simulation surfaced three real bugs that had nothing to do with
the intake:

1. **The planner always appended remote**, even for someone who said on-site
   only — so they were being shown listings they had explicitly ruled out.
   `remotePreference` now suppresses it.
2. **Scalar slots arrived as arrays** during simulation (`['remote']` vs
   `'remote'`), so every branch compared equal.
3. **The free-text slot crashed ranking** with `dealBreakers.map is not a
   function`, because it stores a string and every consumer wants a list.

A slot whose branches cannot move the results is a slot whose plumbing is
broken. The measurement is a test as much as a selector.

## Pairwise cards

Three rounds of "which of these two would you take?", using real postings.

Pairs are chosen to maximise disagreement **on the scoring components**, not on
skill overlap. Choosing on skills produced comparisons where both jobs scored
identically on every component — the user answered and the answer carried no
information. If the best available pair still scores identically, no card is
shown.

Each answer is stored as the difference between the two feature vectors,
because that is what the comparison actually says: not "this job is good" but
"this one beat that one", which is the trade-off a form cannot capture.

## Learning

`preference_events` collects pairwise choices and every approve/reject on the
Hunt screen. The feature vector is `score_breakdown`, which the scorer has been
writing on every job since the first run and nothing ever read.

A nightly job refits each active user's weights: one bounded step (25% max
movement per component) toward what they approved and away from what they
rejected, renormalised to 100 so the score keeps the meaning the UI shows.
Below 8 examples nothing moves — a few rejections on a Tuesday is noise, not
preference.

## Measured

| Case | Questions |
|---|---|
| Fully configured user (spec + kit + resume) | 1 |
| Sparse user (spec only) | 3 |
| New user, resume skipped | 5 |

All at 6/6 slots above the confidence bar afterwards. The cap of 7 was never
reached — the impact floor stops it first, which is the mechanism doing the
work rather than the ceiling.

## Still to come

The `apply`-stage slots are deferred out of intake but nothing collects them
yet. That belongs with the apply runtime: ask once, at the first application
that needs the field, then reuse forever.
