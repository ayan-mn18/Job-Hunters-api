# Experiment: does a structured-data → PDF render parse back cleanly?

Run date: 2026-08-07. Machine: macOS, Node 22.13.1, Google Chrome (headless),
`unpdf` 1.8.0 (serverless build of Mozilla pdf.js).

## What was tested

One `ResumeDocument` fixture (`fixtures/resume.sample.json`), rendered two ways
by the same headless Chrome, then extracted back to text and scored.

| Template | Layout |
| --- | --- |
| `ats` | Single column, semantic block order, standard section headings, no tables, no letter-spacing, no page header/footer, no icon glyphs. This is the recommended renderer. |
| `pretty` | The control: two-column CSS grid with a skills/education sidebar, a `<table>` for experience, a fixed page header carrying the contact block, `letter-spacing: 1.4px` on headings, `●` icon glyphs, custom section names ("Professional Journey"). This is what a typical designer template looks like. |

Text extraction deliberately uses pdf.js in its raw mode. pdf.js emits glyph
runs in the PDF's own content-stream order — which is exactly what a naive ATS
parser sees. A layout-reconstructing extractor would hide the failure the test
is trying to expose.

Reproduce with `npm install && npm run experiment`.

## Result

```
=== ats ===  out/resume.ats.pdf
    1 page(s), 1662 chars extracted
    PASS  contact       4/4 contact fields intact
    PASS  headings      summary="summary", skills="skills", experience="experience", education="education"
    PASS  readingOrder  7 anchors in document order
    PASS  attribution   7/7 bullets inside the right employer block
    PASS  keywords      10/10 recovered
    PASS  pageArtifacts no repeated header/footer text
    => ATS-CLEAN

=== pretty ===  out/resume.pretty.pdf
    2 page(s), 1781 chars extracted
    PASS  contact       4/4 contact fields intact
    FAIL  headings      missing: skills, experience, education
    FAIL  readingOrder  text order is name > summary > education > job1 > job1.bullet1 > job2 > job2.bullet1,
                        document order is name > summary > job1 > job1.bullet1 > job2 > job2.bullet1 > education
    PASS  attribution   7/7 bullets inside the right employer block
    PASS  keywords      10/10 recovered
    FAIL  pageArtifacts contact block repeated: name x2, email x2 (running header/footer bleeding into body text)
    => NOT ATS-CLEAN

ats    : 6/6 checks pass
pretty : 3/6 checks pass
```

## What actually broke, in the control's own extracted text

```
… Pune, India P R O F I L E Full-stack engineer with 4 years … C O R E S K I L L S
● React ● TypeScript … E D U C A T I O N B.E. Computer Engineering Savitribai Phule
Pune University Aug 2018 - May 2022 L I N K S ● linkedin.com/in/ayan-mn18 …
P R O F E S S I O N A L J O U R N E Y Jan 2024 - Present Software Engineer Nimbus Labs …
```

Three separate failures, each worth naming because each is a rule for the
renderer:

1. **`letter-spacing` shatters every heading.** Chrome positions each character
   as its own glyph run, so `Core Skills` extracts as `C O R E S K I L L S`. No
   heading matcher — regex or embedding — recovers that. **Rule: never apply
   `letter-spacing` to text an ATS needs to classify.** Uppercase is fine
   (`text-transform: uppercase` does not change glyph positioning); tracking is
   not.
2. **The sidebar reorders the document.** Education is visually to the left of
   Experience, but in the content stream it lands *before* it. A parser reading
   linearly sees the education block interleaved into the work-history region.
   **Rule: single column, always.**
3. **The fixed page header is re-emitted per page.** The contact block appears
   twice in the text, so the parser sees a second "Ayan Mansoori
   ayan.mansoori@example.com" after the projects section and may read it as body
   content or as a second candidate. **Rule: no running headers or footers; put
   contact details in the first text block of the body.**

Note that `attribution` and `keywords` passed on *both*. Keyword recovery is the
metric most "ATS checker" tools sell, and it is the one that discriminates
least — the control recovered 10/10 keywords while being structurally
unparseable. Do not use keyword recovery alone as the ATS gate.

## Determinism (`node src/determinism.mjs`)

The same document rendered twice, one second apart:

```
bytes            : 58303 vs 58303
raw sha256       : 4e13db7db7a18698 vs e0c9d56bb062cd51  DIFFER
differing bytes  : 4
normalised sha256: 058232956f30c921 vs 058232956f30c921  MATCH
extracted text   : IDENTICAL
```

The two files differ in **4 bytes**, all inside `/CreationDate (D:…)`. Blank
that field and the hashes match exactly; the extracted text is identical either
way.

**This is the finding storage lifecycle hangs on.** Given the same
`ResumeDocument`, template and renderer, the PDF is reproducible. Storing it is
therefore optional: keep the inputs, regenerate the artifact.

Caveat, stated honestly: reproducibility holds *for a pinned renderer*. A
Chromium upgrade can change font subsetting, hyphenation or line-breaking, and
the bytes will move. Mitigation is in `../03-storage-lifecycle.md` — pin the
renderer image by digest, stamp `rendererVersion` on every variant, and store
the normalised content hash so drift is detectable rather than silent.

## Artifact sizes (used for the storage math)

| Artifact | Raw | Gzipped |
| --- | ---: | ---: |
| `resume.sample.json` (full base document) | 4,568 B | 1,627 B |
| generated HTML | 3,400 B | — |
| rendered PDF, 1 page, subsetted fonts | 58,303 B | 48,372 B |

PDFs do not compress — they are already deflate-compressed internally. Treat
57 KB as the per-application figure.
