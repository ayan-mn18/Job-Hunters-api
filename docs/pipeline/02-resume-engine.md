# 2 — Resume tailoring and ATS score

Contracts: [`contracts/resume.ts`](./contracts/resume.ts)
Evidence: [`experiments/RESULTS.md`](./experiments/RESULTS.md)

## The one decision everything else follows from

**The resume is structured data. A PDF is a render of it, never the source.**

Once that is true, most of the hard problems in this document stop being hard:

- "How do we read the base resume?" — once, at upload. Never again.
- "How do we tailor?" — reorder and select rows in a data structure, which is
  checkable, instead of rewriting prose, which is not.
- "How do we keep the ATS score high?" — control the renderer, not the parser.
- "Can we regenerate a past variant?" — yes, because the inputs are small and
  the render is deterministic (proved below).
- "Did the model invent a job?" — it structurally cannot, because the output
  schema has no field for one.

## Reading the base resume

### The options, honestly

| Approach | Reality |
| --- | --- |
| **Parse the PDF on every use** (`pdf-parse`) | `pdf-parse` is effectively unmaintained and depends on the native `canvas` module, which does not build on Lambda/Vercel/edge runtimes. Do not start here in 2026. |
| **Parse the PDF on every use** (`unpdf`) | The right library *if* you must parse: a serverless build of Mozilla pdf.js, zero native dependencies, actively maintained, works in Node/edge/workers. It is what the experiment in this repo uses. But the library is not the problem — parsing is. |
| **Parse the PDF, generally** | The failure modes are exactly the ones the experiment demonstrated, pointed the other way. If the user's designed base resume is two-column, the parse interleaves education into work history. If its headings use letter-spacing, there are no headings. You inherit every layout sin of a document you did not render, and you inherit it *silently* — a lossy parse looks like a successful one. |
| **Ask the user for LaTeX / structured source** | Precise, but it asks the user to maintain a second artifact forever and to keep it in sync with a design tool. And "parse the LaTeX" means parsing a Turing-complete macro language with user-defined commands — `\resumeSubheading{}{}{}{}` is whatever the template author decided it is. This shifts the fragility, it does not remove it. |
| **Store the resume as structured data once, and treat every PDF as a render of it** | ✅ **Recommended.** |

### Recommendation

Parse exactly once, at upload, then own the structure:

```
upload PDF/DOCX
   → unpdf extractText()                     raw text, reading order
   → Claude structured-output extraction     → draft ResumeDocument + per-field confidence
   → USER CONFIRMS in the UI                 ← the load-bearing step
   → ResumeDocument v1 becomes the base
```

Three things make this work:

1. **The confirmation step is not optional.** Extraction is lossy and the user
   is the only party who knows what is true. `ResumeIngestResult.confidence`
   drives the UI: anything below 0.8 is pre-highlighted for review. The Hunt
   screen already has the affordance — "last parsed 2 days ago · 34 skills
   found" becomes a link into a real editor.
2. **The uploaded PDF is kept as an archival original and never read again.**
   Everything downstream reads `ResumeDocument`.
3. **The base is versioned.** Every variant pins `baseResumeVersion`, so
   "which resume went to this job" survives the user rewriting their summary
   next month.

This also happens to be the answer to the user's LaTeX/Overleaf question. They
can keep designing in Overleaf if they like the output — but that artifact
becomes a *reference*, not an input. The system's canonical resume lives in the
database, and what goes to employers is rendered from it.

## Producing a tailored variant

### The shape of the work

Given `JDAnalysis` and a base `ResumeDocument`, tailoring is four moves, in
order:

1. **Score every bullet against the JD.** Deterministic, no model:
   `bullet.skills ∩ jd.requiredSkills` weighted 1.0, `∩ jd.preferredSkills`
   weighted 0.5, plus a small recency multiplier (a bullet from the current role
   outranks an equally relevant one from three years ago), plus a bonus for
   carrying a metric. This produces a ranked list *before* any LLM sees
   anything, which means the model's job shrinks to judgement rather than
   retrieval.
2. **Select under the length budget.** `TailoringConstraints.maxBullets` with
   `minBulletsPerRole` so the second job never collapses to one line. One page
   is the default; the constraint is passed to the model *and* re-enforced by
   the renderer.
3. **Reorder.** Roles stay reverse-chronological — reordering employment
   history is a red flag to a human reader and gains nothing with a parser.
   Bullets *within* a role are reordered freely, most-relevant first, because
   recruiters read the first two bullets of the top role and skim the rest.
4. **Reword, within bounds.** If the base says "Rewrote the billing service in
   Node.js and PostgreSQL" and the JD says "backend services in TypeScript",
   the rewrite may surface that this was TypeScript *because the bullet's
   `skills` array already says so*. It may not add TypeScript to a bullet that
   never had it.

Keyword alignment is a consequence of steps 1 and 4, not a separate step.
Nobody should be writing a keyword-stuffing pass. The skills line is emitted
from `base.skills` filtered and reordered by `plan.skillOrder` — the model
picks ids from a list, so it cannot type a skill name at all.

### Where the fabrication line sits

**Allowed:** reordering, selecting a subset, rewording an existing claim,
choosing which projects to show, rewriting the summary from claims that already
exist elsewhere in the document, choosing which of the user's real skills to
lead with.

**Forbidden, without exception:** a new employer, a new job title, a changed
date range, a new credential or institution, a new skill, a new metric, a
changed metric value, adding a technology to a bullet that did not use it,
claiming more years than the dates support, adding a certification, changing
employment type (contract → full-time), or promoting a project to a job.

The line, stated once: **the tailored resume may change what is emphasised and
how it is worded. It may not change what is true.** A resume that invents
experience does not just risk an offer being rescinded — it wastes the user's
own interview slots on roles they will fail, which is the more expensive
failure.

### How the design enforces it — four layers, not one prompt

A prompt instruction is a request. These are guarantees.

**Layer 1 — the schema has no slot for a lie.** `TailoringPlan` contains no
`company`, no `startDate`, no `credential`, no `skillName`. Roles, bullets,
skills and projects are all referenced by **id**. The only free text the model
emits is `summary.text` and `bulletRewrites[id]`. Enforced with structured
outputs (`output_config.format` + a JSON schema with `additionalProperties:
false`), so the model literally cannot return a shape that contains an invented
employer.

**Layer 2 — referential validation.** Every id in the plan must exist in the
pinned `ResumeDocument`. Any miss is `unknown_bullet_id` /
`unknown_experience_id` / `unknown_skill_id` and the plan is rejected outright.
Cheap, total, and it catches a model that pattern-matches an id it half-recalls.

**Layer 3 — metric preservation.** For every rewrite, extract the numeric
tokens (numbers, percentages, currency, durations, multipliers) from both the
source bullet and the rewrite:

- a number in the rewrite that is not in the source → `metric_invented`
- a number in the source whose value changed → `metric_inflated`
- a number dropped entirely → `metric_dropped` (a **warning**, not a failure —
  shortening a bullet legitimately drops detail)

"38%" may become "by a third". "38%" may not become "40%". This one check
catches the most common and most damaging LLM resume failure, which is quiet
inflation rather than outright invention.

**Layer 4 — entity and drift checks.** Named entities in a rewrite (product
names, technologies, company names, proper nouns) must appear in the source
bullet or in `base.skills` — otherwise `entity_invented`. And an embedding
cosine floor between source and rewrite (≥ 0.75) catches rewrites that keep
every number and every entity while changing the claim ("*contributed to* a
migration" → "*led* a migration"). Below the floor: `semantic_drift`.

`TailoringResult.accepted` is `violations.length === 0`. **Nothing else may
render.** A rejected plan is retried once with the violations fed back as
input; a second rejection drops the job and emits a `RunEvent` — one skipped
application is a much cheaper outcome than one fabricated one.

**And a fifth, human, layer:** every `ResumeVariant` stores the full `plan`
forever, so months later the Applications screen can show the exact diff that
was sent. If the user is asked about a bullet in an interview, they can see
what the employer read.

## Keeping the ATS score high

### What ATS parsers actually choke on

The experiment in this repo rendered the same resume two ways and parsed both
back. Six checks; the "designer" layout failed three. **Read
[`experiments/RESULTS.md`](./experiments/RESULTS.md) for the raw output** — the
short version:

| Breaks | Why | Evidence |
| --- | --- | --- |
| **`letter-spacing` on headings** | Chrome emits each character as its own glyph run. `Core Skills` extracts as `C O R E S K I L L S`. No heading matcher recovers that. | control failed `headings` on all three of skills/experience/education |
| **Multi-column layouts** | The sidebar is emitted before the main column in the content stream. A linear parser reads Education *before* Experience. | control: text order was `name > summary > education > job1 > job2` |
| **Running headers/footers** | Re-emitted per page, so the contact block appears twice and the second copy reads as body text. | control: `name x2, email x2` |
| **Non-standard section headings** | "Professional Journey" does not match any ATS synonym for "Experience". | control failed even ignoring the letter-spacing |
| **Tables for layout** | Cell traversal order is renderer-dependent; some parsers read column-major. The control survived this one, which is luck, not a property. | — |
| **Text inside images / graphics / icon fonts** | Not text at all. Glyph icons (`●`, Font Awesome) leak into the extracted string as noise or as `?`. | control's skills extracted as `● React ● TypeScript …` |
| **Exotic or non-embedded fonts** | Substituted or dropped; ligatures (`ﬁ`) extract as one unmapped codepoint. | — |
| **Hyphenation** | `experi- ence` across a line break becomes two tokens. Disable `hyphens` entirely. | — |

Note the check that did *not* discriminate: **keyword recovery was 10/10 on
both**. That is the metric every commercial "ATS checker" sells, and it is the
one that tells you least — the unparseable control scored perfectly on it. The
production `AtsReport` weights structural checks and treats keyword coverage as
a tiebreak, not a gate.

### The rendering path

**Recommendation: structured data → HTML → PDF via Playwright/Chromium.**

| Path | For | Against | Verdict |
| --- | --- | --- | --- |
| **HTML → PDF (Playwright/Chromium)** | Text is emitted in DOM order, so reading order is source order by construction; flow layout handles page breaks; font subsetting and embedding are automatic; the same HTML powers the in-app preview, so WYSIWYG is free; the team already writes CSS. Proved 6/6 clean, 1 page, 1662 chars extracted. | ~350 MB runtime, real memory per render, and determinism requires pinning the browser build. | ✅ **ship this** |
| **LaTeX via tectonic** | Best typography by a distance; self-contained binary, no TeX distribution to install; reproducible builds are a design goal of the project. | LaTeX positions glyphs at absolute coordinates, and the content-stream order frequently does not match visual order — this is the root of the long-running "my LaTeX resume doesn't parse" complaint. Single-column templates like Jake's Resume *do* parse well, so it is achievable — but you would be re-running exactly the parse-back gate below anyway, on a templating language that is a full macro system. You get better kerning and a much worse authoring loop. | ❌ |
| **react-pdf / pdfkit** | No browser; small and fast; you control text emission order explicitly, which is the thing that matters. | No flow layout — page breaks, widow control and "does this fit on one page" become your problem. Font embedding is manual. Typography is visibly worse. | ⚠️ **plan B** if the deploy target cannot host Chromium |
| **.docx** | Genuinely the most parseable format — headings are real semantic headings, not inferred from font size. Several ATS vendors parse it more reliably than any PDF. | The user cannot see what the recruiter sees; rendering varies by Word version; some portals reject it; and it looks less finished. | ✅ **as a secondary artifact** |

Because everything is generated from `ResumeDocument`, the `.docx` path costs
almost nothing — it is a second template, not a second pipeline. Emit PDF by
default; emit `.docx` for the specific portals whose adapter declares it
preferred. That is the pragmatic version of "which format parses best": ship
both, from one source.

### Renderer rules (these are the template's contract)

- Single column. No CSS grid or flex for page-level structure.
- No `letter-spacing` on anything a parser must classify. `text-transform:
  uppercase` is fine — it changes glyphs, not positions.
- Standard section headings, spelled the boring way: Summary, Skills,
  Experience, Projects, Education. `AtsCheckId: 'headings'` validates against a
  synonym table.
- No `position: fixed`, no `@page` margin boxes, no running headers or footers.
  Contact details go in the first text block of the body.
- No tables, no icon glyphs, no images, no text in SVG.
- Embed a subset of one boring font family. `hyphens: none`.
- Dates as `Jan 2024 – Present`, in a text node adjacent to the role, never in a
  separate positioned column.

### The gate

Every render is parsed back before it is allowed near a portal:

```
render → unpdf extractText → AtsReport → blockingFailures.length === 0 ?
   yes → apply
   no  → drop the variant, emit a RunEvent, do not submit
```

Blocking checks: `contact`, `headings`, `readingOrder`, `attribution`,
`pageArtifacts`, `pageCount`. Non-blocking: `keywords` (informational),
`fontEmbedding`.

This is the same code as `experiments/src/check.mjs`, promoted into the service.
Running it on every render costs a few hundred milliseconds and it is the only
thing standing between a template regression and 100 unparseable applications.

## The LLM layer

### Model and settings

| Call | Model | Why |
| --- | --- | --- |
| Resume ingest (once per upload) | `claude-opus-5` | One-off, accuracy dominates cost entirely. |
| JD analysis (once per unique JD) | `claude-haiku-4-5` | Structured extraction from text. Cached by `jdHash`, so a cross-posted role costs nothing the second time. |
| Tailoring plan (once per application) | `claude-opus-5` | The judgement call — which of the user's *real* bullets best evidences this requirement — is the whole product. This is where the tier earns its money. |

Settings for tailoring: `thinking: {type: "adaptive"}` (on by default on
Claude Opus 5), `output_config: { effort: "medium" }`, structured outputs with
a strict `TailoringPlan` schema. Start at `medium` and sweep — this task is
well-specified with the candidate set pre-ranked, so it does not need `high`.

### Prompt contract

Ordering is chosen for the prompt cache, which is a prefix match — stable
content first, volatile content last:

```
system  [cache_control: ephemeral]
  ├─ role + the fabrication rules, verbatim
  ├─ the TailoringPlan schema and what each field means
  └─ worked examples of a legal rewrite and an illegal one
user    [cache_control: ephemeral]
  └─ the full ResumeDocument as JSON     ← stable for the whole day, per user
user
  ├─ JDAnalysis (structured, not the raw JD)
  ├─ TailoringConstraints
  └─ pre-ranked bullet candidates with their deterministic scores
```

The cached prefix is ~2,800 tokens — comfortably above Claude Opus 5's
512-token minimum — and it is identical for every one of that user's 100 daily
tailorings. Only the last block varies. Two rules keep it that way: **no
timestamps or request ids in the system prompt**, and **serialise the
`ResumeDocument` with sorted keys** so a re-serialisation never silently
invalidates the day's cache.

Feeding `JDAnalysis` rather than the raw JD is deliberate: it is smaller, it is
cached by `jdHash` across portals, and it keeps scraped third-party text — which
is untrusted input and can contain instructions aimed at the model — out of the
tailoring prompt.

### Keeping output schema-valid

Structured outputs, not parsing and hoping. `additionalProperties: false` and
explicit `required` on every object. That guarantees the *shape*; layers 2–4
above guarantee the *content*. A schema-valid plan referencing `bullet_9999` is
still rejected.

### Cost at 100 tailorings a day

Per call, with prompt caching, at Claude Opus 5's $5/$25 per MTok:

| Component | Tokens | Rate | Cost |
| --- | ---: | --- | ---: |
| Cached prefix (system + resume) | 2,800 | $5/M × 0.1 | $0.0014 |
| Uncached input (JD analysis, constraints, candidates) | 600 | $5/M | $0.0030 |
| Output incl. adaptive thinking at `effort: medium` | ~2,000 | $25/M | $0.0500 |
| **Per tailoring** | | | **≈ $0.054** |

- 100/day synchronous: **≈ $5.45/day, ~$165/month.**
- **100/day via the Message Batches API (50% off): ≈ $2.72/day, ~$82/month.** ✅
- Same, on `claude-sonnet-5` ($3/$15) via batch: ≈ $1.65/day, ~$50/month.

**Use the Batch API for tailoring.** This workload is the textbook fit: the
day's tailoring is known by ~06:15, the first submission slot is not until
08:00, and nothing about it is latency-sensitive. Batches support prompt
caching, so the cached-prefix saving stacks with the 50% discount. Submit the
whole day as one batch after scoring, poll it, and fall back to synchronous
calls for anything not returned by the first submit slot — most batches finish
inside the hour, and the fallback path costs full price on a handful of jobs
rather than on all of them.

Add JD analysis on Haiku 4.5: ~2,000 in / 400 out ≈ $0.004 per unique JD. Run
the deterministic filter first so only postings that clear `minMatchScore`'s
cheap proxy reach the model — that keeps it near 150 calls/day, **≈ $0.60/day**,
and caching by `jdHash` cuts it further as cross-postings collapse.

Total steady-state: **roughly $3.30/day, ~$100/month, at 100 applications a
day.** `RunBudget.llmSpendCapUsd` pauses the run rather than letting a bug turn
into a bill.

### Verifying the output did not hallucinate

Layers 2–4 run on the plan. Two more checks run on the artifact:

1. **Attribution against the rendered PDF.** After rendering, extract the text
   and assert every experience bullet in it maps to a `bulletId` in the plan,
   and that it falls between the right employer heading and the next one. This
   catches template bugs as well as model bugs — it is the `attribution` check
   in the experiment, and it is why that check exists.
2. **A rendered diff, shown to the user.** The Applications screen already
   displays a resume variant per row (`✂️ resume—fullstack—fintech.pdf`).
   Make it open a three-pane view: base bullet, tailored bullet, and the
   violations that were checked and passed. The system should be auditable by
   the person whose name is on the document.

What is deliberately *not* used: asking the model to self-report whether it
fabricated anything. A model's confidence in its own faithfulness is not
evidence. Every check above is either a set operation on ids, a numeric
comparison, or a distance metric.
