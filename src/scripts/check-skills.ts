import { allSkills } from '../skills/registry.js'

/**
 * A pre-flight for site skills.
 *
 * The failure this exists to catch is a playbook that does not load: SKILL.md
 * is read from disk at run time, so a missing or unbuilt one throws during a
 * real application rather than at build. Everything else here is cheap enough
 * to check while we are at it.
 */

let failures = 0

function check(condition: boolean, message: string): void {
  if (condition) return
  failures += 1
  console.error(`  ✗ ${message}`)
}

for (const skill of allSkills()) {
  const { manifest } = skill
  console.log(`${manifest.id} — ${manifest.label}`)

  check(manifest.domains.length > 0, 'claims no domains, so no URL will ever resolve to it')
  for (const domain of manifest.domains) {
    check(
      manifest.allowedDomains.includes(domain),
      `may not navigate to its own domain ${domain}`,
    )
  }
  check(
    manifest.authMode !== 'profile' || Boolean(manifest.loginUrl),
    'needs a signed-in profile but publishes no login URL, so it can never be connected',
  )
  check(
    !manifest.capabilities.search || Boolean(skill.source),
    'says it can search but supplies no source',
  )
  check(
    !manifest.capabilities.apply || Boolean(skill.apply),
    'says it can apply but supplies no apply function',
  )

  try {
    const playbook = await skill.playbook()
    check(playbook.trim().length > 200, 'has a playbook too short to be worth reading')
    console.log(`  ✓ playbook, ${playbook.length} characters`)
  } catch (error) {
    failures += 1
    console.error(`  ✗ playbook could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (failures > 0) {
  console.error(`\n${failures} problem${failures === 1 ? '' : 's'} found.`)
  process.exit(1)
}
console.log('\nAll skills are well formed.')
