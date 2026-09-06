import type { SiteSkill } from '../types.js'
import { linkedinManifest } from './manifest.js'
import { linkedinPlaybook } from './playbook.js'

/**
 * LinkedIn carries no `source` and no `apply`: it is neither searched for jobs
 * nor applied to. Its capability is outreach, which is reached through
 * `outreach.ts` and `find.ts` rather than through the generic apply path,
 * because sending a message in someone's name is not the same operation as
 * filling in a form and should not share a code path with it.
 */
export const linkedinSkill: SiteSkill = {
  manifest: linkedinManifest,
  playbook: linkedinPlaybook,
}
