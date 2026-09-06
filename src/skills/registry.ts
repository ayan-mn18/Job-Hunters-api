import { logger } from '../lib/logger.js'
import { linkedinSkill } from './linkedin/skill.js'
import { workAtAStartupSkill } from './workatastartup/skill.js'
import type { SiteSkill } from './types.js'

/**
 * Every site Huntly knows how to work.
 *
 * Adding a website is adding a directory and one line here. Nothing in the
 * engine branches on a hostname any more.
 */

const SKILLS: SiteSkill[] = [workAtAStartupSkill, linkedinSkill]

export function allSkills(): SiteSkill[] {
  return SKILLS
}

export function skillById(id: string): SiteSkill | null {
  return SKILLS.find((skill) => skill.manifest.id === id) ?? null
}

/**
 * The skill that owns a URL.
 *
 * Longest domain match wins, so a skill claiming `jobs.example.com` beats one
 * claiming `example.com` rather than losing to whichever was registered first.
 */
export function skillForUrl(url: string): SiteSkill | null {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    logger.debug({ url }, 'not a URL; no skill resolved')
    return null
  }

  let best: { skill: SiteSkill; length: number } | null = null
  for (const skill of SKILLS) {
    for (const domain of skill.manifest.domains) {
      const clean = domain.replace(/^\*\./, '').toLowerCase()
      if (host === clean || host.endsWith(`.${clean}`)) {
        if (!best || clean.length > best.length) best = { skill, length: clean.length }
      }
    }
  }
  return best?.skill ?? null
}

/** Skills that can do a given thing, for a run that needs one. */
export function skillsWith(capability: 'search' | 'apply' | 'outreach'): SiteSkill[] {
  return SKILLS.filter((skill) => skill.manifest.capabilities[capability])
}
