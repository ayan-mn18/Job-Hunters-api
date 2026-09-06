import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentSession } from '../browser/session.js'
import type { SourceAdapter } from '../hunt/discovery/runner.js'

/**
 * A site skill: everything Huntly knows about one website.
 *
 * Before this, per-site knowledge was scattered — a scraping adapter in one
 * file, a selector recipe in another, a hostname special-case in the apply
 * orchestrator, LinkedIn's pacing rules inlined in the outreach code. Adding a
 * site meant touching all of them and remembering which.
 *
 * A skill puts that in one directory, in two halves that are read by two
 * different audiences:
 *
 *  - the **manifest**, which the engine reads: domains, whether a login is
 *    needed, whether to pay for a proxy, how fast we may go, what this site
 *    can be used for;
 *  - **SKILL.md**, which the model reads: what the site is, how its search
 *    behaves, what its apply flow looks like, and what to never do on it.
 *
 * The manifest is enforced in code. The playbook is advice. Nothing that
 * matters for safety lives only in the playbook.
 */

export type AuthMode = 'none' | 'profile'

export interface SiteSkillManifest {
  id: string
  label: string
  /** Hostnames this skill owns. Used to resolve a URL to a skill. */
  domains: string[]
  /**
   * Everywhere a run on this site may navigate. Wider than `domains` because
   * boards hand off to an ATS mid-application, and narrower than the internet
   * because an agent with no boundary is an agent with no rules.
   */
  allowedDomains: string[]
  authMode: AuthMode
  /** Where a person signs in, when this site needs an account. */
  loginUrl?: string
  /** A cookie domain that proves the sign-in took. */
  loginCookieDomain?: string
  /**
   * Two-letter country for a managed residential proxy, or null for a direct
   * connection. Null unless the site is known to fingerprint: managed egress
   * is 25× the price of direct.
   */
  proxyCountry: string | null
  /** Minimum gap between reads, for the sources this skill scrapes. */
  minIntervalMs: number
  capabilities: {
    /** Can find jobs here. */
    search: boolean
    /** Can submit an application here. */
    apply: boolean
    /** Can contact people here. */
    outreach: boolean
  }
}

/**
 * How a skill contributes postings to discovery.
 *
 * A skill does not invent its own search pipeline. It hands back the same
 * `SourceAdapter` the rest of discovery already speaks, so freshness,
 * deduplication, the detail stage, canonicalisation and scoring are all shared
 * — the only thing a skill supplies is how to list and how to read one page.
 */
export type SkillSource = SourceAdapter

export interface ApplyParams {
  session: AgentSession
  userId: string
  applyUrl: string
  dryRun: boolean
  /** Facts the agent may use. Already stripped of anything never-auto. */
  facts: Record<string, unknown>
  /** Local paths, by keyword: `resume`, `cover-letter`. */
  files: Record<string, string>
  onStep?: (step: { index: number; tool: string; result: string; ok: boolean }) => void | Promise<void>
  /**
   * Lets the run put a question to the person watching. Absent in batch runs,
   * where there is nobody to ask and the agent must leave the field blank.
   */
  onAsk?: (question: string) => Promise<string | null>
  /**
   * Overrides the agent's step ceiling. A batch run leaves this alone; a
   * playground run raises it, because there the agent fills the whole form
   * rather than the leftovers the deterministic ladder could not.
   */
  maxSteps?: number
}

export interface ApplyOutcome {
  reached: 'nothing' | 'form' | 'submitted'
  /** False when the agent stopped before it established that submission was safe. */
  canSubmit?: boolean
  filled: Array<{ label: string; value: string }>
  blocked: Array<{ label: string; why: string }>
  note: string
  steps: number
}

export interface SiteSkill {
  manifest: SiteSkillManifest
  /** SKILL.md, verbatim. Cached after the first read. */
  playbook(): Promise<string>
  /** Present when this site can be searched. */
  source?: SkillSource
  /** Present when this site can be applied to. */
  apply?(params: ApplyParams): Promise<ApplyOutcome>
}

/**
 * Loads a skill's SKILL.md.
 *
 * The playbook is a real markdown file rather than a string in a `.ts` because
 * it is prose meant to be edited as prose — by whoever last learned something
 * about the site, not necessarily by whoever wrote the adapter. `npm run
 * build` copies these next to the compiled output; see scripts/copy-skill-assets.mjs.
 */
export function playbookLoader(moduleUrl: string): () => Promise<string> {
  let cached: string | undefined
  return async () => {
    if (cached !== undefined) return cached
    const directory = path.dirname(fileURLToPath(moduleUrl))
    cached = await readFile(path.join(directory, 'SKILL.md'), 'utf8')
    return cached
  }
}
