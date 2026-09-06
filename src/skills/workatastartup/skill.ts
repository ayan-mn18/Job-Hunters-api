import type { SiteSkill } from '../types.js'
import { applyOnWorkAtAStartup } from './apply.js'
import { workAtAStartupManifest } from './manifest.js'
import { workAtAStartupPlaybook } from './playbook.js'
import { workAtAStartupSource } from './source.js'

export const workAtAStartupSkill: SiteSkill = {
  manifest: workAtAStartupManifest,
  playbook: workAtAStartupPlaybook,
  source: workAtAStartupSource,
  apply: applyOnWorkAtAStartup,
}
