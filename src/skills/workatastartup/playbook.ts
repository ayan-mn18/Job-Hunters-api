import { playbookLoader } from '../types.js'

/**
 * Loading SKILL.md is its own module so that `apply.ts` can read the playbook
 * without importing `skill.ts`, which imports `apply.ts`.
 */
export const workAtAStartupPlaybook = playbookLoader(import.meta.url)
