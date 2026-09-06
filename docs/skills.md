# Site skills

Everything Huntly knows about one website lives in one directory under
`src/skills/`. Adding a site is adding a directory and one line in
`src/skills/registry.ts`. Nothing in the engine branches on a hostname.

Before this, per-site knowledge was scattered across four places — a scraping
adapter, a selector recipe, a hostname special-case in the apply orchestrator,
and LinkedIn's pacing rules inlined in the outreach code. Adding a site meant
touching all of them and remembering which.

## The shape

```
src/skills/workatastartup/
  manifest.ts   what the engine enforces
  SKILL.md      what the model is told
  playbook.ts   loads SKILL.md
  source.ts     how to list and read postings        (capability: search)
  apply.ts      how to complete an application       (capability: apply)
  skill.ts      the three of them, assembled
```

The split between the manifest and the playbook is the important part.

**The manifest is enforced in code.** `allowedDomains` is checked in
`src/agent/tools.ts` on every navigation, `authMode` decides whether a run gets
a signed-in profile, `proxyCountry` decides whether the session pays for a
residential exit.

**SKILL.md is advice.** It is injected verbatim into the model's system prompt
and it is where site-specific judgement goes — that a Work at a Startup
application *is* a message to the founders, that LinkedIn work stops dead at a
checkpoint. Nothing that matters for safety lives only there, because a prompt
is not a fence.

## Capabilities

| Capability | Means | Supplied by |
|---|---|---|
| `search` | postings can be found here | `source`, a `SourceAdapter` |
| `apply` | an application can be submitted here | `apply()` |
| `outreach` | people can be contacted here | its own module — see `linkedin/outreach.ts` |

A skill's `source` is the same `SourceAdapter` the rest of discovery speaks, so
freshness, deduplication, the detail stage, canonicalisation and scoring are
all shared. A skill supplies how to list and how to read one page, and nothing
else. See [adding-a-source.md](adding-a-source.md).

Outreach is deliberately not routed through the generic apply path. Sending a
message in someone's name is not the same operation as filling in a form and
should not share a code path with one.

## Writing SKILL.md

Write it for someone who has never used the site. It is prose, not
configuration. What it should contain:

- what the site is, and who is on the other end of it;
- how to read it — whether a login is needed, what the URL shapes are, what the
  site does to clients it dislikes;
- what the application or the message actually *is* on this site, and what
  makes a good one;
- a **Do not** section, in plain language.

Keep it under a page. It is paid for on every step of every run.

## Checking one

```bash
npm run skills:check
```

Validates every manifest and, most importantly, that every playbook loads.
SKILL.md is read from disk at run time, so a missing or unbuilt one throws
during a real application rather than at build. `npm run build` copies the
markdown into `dist/` — see `scripts/copy-skill-assets.mjs`.

```bash
npm run skills:source workatastartup 5
```

Runs one skill's source for real and fails if it returns nothing. This exists
because of how the previous Work at a Startup adapter failed: the site began
answering plain HTTP clients with 406, the adapter caught the error, returned
an empty list, and every run since contributed zero postings without anything
reporting a problem.
