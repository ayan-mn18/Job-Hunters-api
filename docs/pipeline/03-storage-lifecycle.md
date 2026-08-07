# 3 — Storage lifecycle

Contracts: [`contracts/resume.ts`](./contracts/resume.ts) (`ResumeVariant`)
Evidence: [`experiments/RESULTS.md`](./experiments/RESULTS.md) (determinism, sizes)

## The proposal, and the correction

The user's instinct — generate the PDF, apply, delete it, keep a record — is
right. It can be sharpened in one way: **do not write the PDF to Supabase
Storage at all.**

The render happens on the worker. The upload happens on the worker. The gap
between them is seconds. Putting an object-storage round trip in the middle
adds a write, a read, a delete, egress charges, and — most importantly — a
window in which a crash leaves an orphan. Render to the worker's scratch disk,
hand the local path to the portal adapter, `unlink` it when the outcome is
recorded.

Supabase Storage then holds exactly two things:

1. the user's original uploaded resume (archival, one file, never read by the
   pipeline after ingest), and
2. variants the user has explicitly **pinned**.

Both are user-initiated and bounded by user behaviour. The bucket does not grow
with throughput, which is the actual thing being worried about.

## What is worth keeping forever

| Keep forever | Where | Why |
| --- | --- | --- |
| `ResumeDocument`, **every version** | Postgres | The source of truth. Small, and versioning is what makes an old variant reconstructible. |
| `ResumeVariant.plan` | Postgres | *The* record. It is the diff — which bullets, in which order, reworded how. Reproduces the PDF and answers "what did they read". |
| `ResumeVariant.contentHash` | Postgres | sha256 of the normalised PDF. Proves a regenerated file is the file that was sent. |
| `ResumeVariant.baseResumeVersion` / `templateId` / `rendererVersion` | Postgres | The other three inputs to the render. Without these the plan alone is not enough. |
| `JobDescriptionSnapshot.text` + `textHash` | Postgres | The evidence for *why* we tailored this way. JD URLs rot within weeks; the snapshot is the only durable copy, and it is what makes an interview prep view possible later. |
| `ApplyOutcome.submittedFields` (redacted) | Postgres | The audit trail. "Which CTC did we tell them?" is a question that gets asked. |
| `AtsReport` | Postgres | Cheap, and it lets you spot a template regression retroactively. |

| Ephemeral | Lifetime |
| --- | --- |
| Rendered PDF | Minutes. Deleted once the outcome is recorded. |
| Generated HTML | Same request. Never persisted. |
| Confirmation screenshot | Until the `ApplyOutcome` row is written. |
| Raw scraped listing HTML | Discarded after `RawPosting` extraction; only the JD text is kept. |

The shape of the rule: **keep the small structured things that answer questions;
throw away the large derived things that can be rebuilt.**

## Can a past variant be regenerated deterministically?

**Yes — measured, not assumed.** From
[`experiments/src/determinism.mjs`](./experiments/src/determinism.mjs), the same
document rendered twice a second apart:

```
bytes            : 58303 vs 58303
raw sha256       : 4e13db7db7a18698 vs e0c9d56bb062cd51  DIFFER
differing bytes  : 4
normalised sha256: 058232956f30c921 vs 058232956f30c921  MATCH
extracted text   : IDENTICAL
```

Four differing bytes, all inside `/CreationDate (D:…)`. Blank that field and the
files are byte-identical. So:

```
regenerate(variant) =
    render(
      base    = resumeDocument@variant.baseResumeVersion,
      plan    = variant.plan,
      template= variant.templateId,
      renderer= variant.rendererVersion,
    )
assert sha256(normalise(pdf)) === variant.contentHash
```

`normalise` blanks `/CreationDate` and `/ModDate`. That is the whole trick.

**So storing PDFs is optional, and the recommendation is not to.** Every
question the stored PDF could answer is answered by the variant row, and the
file itself is one function call away.

### The honest caveat

Reproducibility holds **for a pinned renderer**. A Chromium upgrade can change
font subsetting, line breaking or hyphenation, and the bytes move — possibly
the layout too. Three mitigations, in order of importance:

1. **Pin the renderer container by image digest**, not by tag. `rendererVersion`
   on every variant stores that digest. `renderer@sha256:…` is the only honest
   version string.
2. **Keep the last N renderer images available** so regeneration uses the
   renderer that produced the original. Practically: retain each digest until no
   un-superseded variant references it, plus a grace period.
3. **Verify and be honest when it fails.** On regeneration, compare the
   normalised hash. On mismatch, still serve the file — but label it: *"Rebuilt
   with renderer v2.4. The original was rendered with v2.1 and may differ
   slightly."* Silently serving a subtly different document as "the one we sent"
   is worse than admitting drift.

Even in the worst case — renderer gone, image unavailable — the *content* is
still fully reconstructible from `plan` + `base`, because that is where the
meaning lives. Only the pixels are at risk, and the pixels were never the record.

## Retention policy

| Data | Retention | Enforced by |
| --- | --- | --- |
| `resume_documents` (all versions) | Forever | — |
| `resume_variants` (plan, hashes, ATS report) | Forever | — |
| `job_description_snapshots` | Forever, deduped by `textHash` | unique index on `textHash` |
| `applications` / `apply_attempts` | Forever | — |
| `run_events` | 90 days | janitor |
| Dead-letter jobs | 30 days | janitor + BullMQ `removeOnFail` |
| Rendered PDF (scratch) | Until outcome recorded, hard cap 24h | apply worker + janitor |
| Rendered PDF (Storage) | Only if `pinned`; otherwise 7 days | janitor |
| Evidence screenshots | 7 days | janitor |
| Original uploaded resume | Forever, or until user deletes | user |

`run_events` at 90 days is the only judgement call. It is the highest-volume
table (a 100-application run writes ~600 rows) and its value decays fast — after
a week nobody reads the log of a completed run. Counters are aggregated onto the
`hunt_runs` row before events expire, so the streak, the daily totals and the
charts survive the pruning.

## The cleanup job

A `hunt.janitor` repeatable job, `pattern: '0 0 3 * * *'`, `tz: 'Asia/Kolkata'`
— 03:00, three hours before the next hunt starts, so a slow sweep never collides
with a run.

```
1. scratch files older than 24h                        → unlink
2. storage objects with no resume_variants row          → delete   (orphans)
3. variants where application is terminal
      AND created_at < now() - 7 days
      AND NOT pinned
      AND pdf_deleted_at IS NULL                        → delete object, stamp pdf_deleted_at
4. evidence screenshots older than 7 days               → delete
5. run_events older than 90 days                        → delete (batched, 10k rows/tx)
6. dead-letter records older than 30 days               → delete
7. renderer image digests with no live variant refs     → report, do not auto-delete
```

Every step is idempotent and driven by a predicate over current state, so
running it twice, or mid-way through a previous run, is safe. Step 7 only
reports — deleting a renderer image is the one action that destroys the ability
to regenerate, so a human confirms it.

**Deletion ordering is crash-safe by construction:** submit → record
`ApplyOutcome` → delete file → stamp `pdf_deleted_at`. A crash anywhere in that
chain leaves a file that the janitor sweeps by age. A crash never leaves a
*missing* record, because the record is written first.

## How the Applications screen still works months later

Everything the current UI renders comes from the variant row, not from a file:

| UI element | Source |
| --- | --- |
| `✂️ resume—fullstack—fintech.pdf` chip | `ResumeVariant.fileName` |
| Match score | `applications.match_score` |
| "Open JD" | `JobDescriptionSnapshot` — renders the stored text, not a dead link |
| **"View resume"** (new) | Regenerate on demand from `plan` + pinned base, stream the bytes, store nothing |
| **"What changed"** (new) | Diff `plan` against the base document — base bullet, tailored bullet, side by side |
| **"Pin"** (new) | Copies the regenerated PDF into Storage and sets `pinned = true`, exempting it from the janitor |

"View resume" is the interesting one. It is a render on a cache-miss, ~1–2
seconds, on a page the user opens a few times a week. That is a trivially good
trade against 2 GB/year of cold storage.

## Storage math at 100 applications a day, for one year

36,500 applications. Measured sizes from the experiment: PDF 58,303 B; base
`ResumeDocument` 4,568 B (1,627 B gzipped). PDFs do not compress meaningfully —
they are already deflate-compressed internally (58,303 → 48,372 B).

**Object storage (Supabase Storage):**

| Option | Steady state after 1 year | Notes |
| --- | ---: | --- |
| A. Keep every PDF forever | **2.08 GB** | Blows the 1 GB free tier in ~6 months; unbounded thereafter, and you pay egress on files nobody opens. |
| B. Keep 30 days | 171 MB | 100 × 30 × 57 KB. Fine, but pays for a window that answers no question the variant row doesn't. |
| C. Keep 7 days | 40 MB | |
| D. **Never persist; regenerate on demand** ✅ | **< 10 MB** | Original upload (~200 KB) + pinned variants. Peak scratch is concurrent renders only: 4 workers × 57 KB. |

**Postgres, under option D:**

| Table | Per row | Rows/year | Total/year |
| --- | ---: | ---: | ---: |
| `resume_variants` (plan + ATS report + hashes) | ~3 KB | 36,500 | ~110 MB |
| `job_description_snapshots` (deduped by hash) | ~6 KB raw | ~50,000 | ~300 MB raw, **~110 MB** after TOAST compression |
| `applications` + `apply_attempts` | ~1.5 KB | 40,000 | ~60 MB |
| `run_events` (90-day window) | ~300 B | ~55,000 live | ~17 MB |
| `resume_documents` (all versions) | ~4.5 KB | ~50 | negligible |
| **Total** | | | **≈ 300 MB/year** |

So: option D turns **2.1 GB/year of cold binaries in object storage** into
**~300 MB/year of queryable, compressible text in Postgres** — and the text is
the part that is actually worth keeping. That is the whole argument.

One number worth keeping in view: at three years the Postgres side is under a
gigabyte, still comfortably inside a small managed instance, and every row still
answers a question. Under option A the bucket is at 6 GB of files, and the
overwhelming majority have never been opened.
