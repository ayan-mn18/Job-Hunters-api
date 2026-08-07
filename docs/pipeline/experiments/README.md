# experiments/

A runnable check for the one claim in the resume-engine design that is worth
proving rather than asserting: **that a single-column PDF rendered from
structured data parses back cleanly, and a pretty one does not.**

```bash
cd docs/pipeline/experiments
npm install
npm run experiment       # render both templates, extract, score
node src/determinism.mjs # is the same input byte-reproducible?
```

Findings are written up in [RESULTS.md](./RESULTS.md).

## Layout

| File | What it is |
| --- | --- |
| `fixtures/resume.sample.json` | A `ResumeDocument` (see `../contracts/resume.ts`) |
| `src/templates.mjs` | `ats` (recommended) and `pretty` (control) HTML templates |
| `src/render.mjs` | ResumeDocument → HTML → PDF via headless Chrome |
| `src/check.mjs` | PDF → text via unpdf, then six ATS-shaped assertions |
| `src/run.mjs` | Render + score both templates, compare |
| `src/determinism.mjs` | Render twice, diff the bytes and the extracted text |

## Notes

- Chrome is invoked directly (`--headless=new --print-to-pdf`) so the
  experiment needs no browser-automation dependency. Production uses Playwright's
  `page.pdf()`, which drives the same Chromium print pipeline. Override the
  binary with `CHROME_PATH=…`.
- `DUMP_TEXT=1 node src/check.mjs out/resume.pretty.pdf` prints the extracted
  text, which is the fastest way to see *why* a template fails.
- `out/` is generated; nothing in it needs to be committed.
- This directory has its own `package.json` on purpose. It is a documentation
  artifact, not part of the API build.
