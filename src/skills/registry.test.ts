import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { allSkills, skillById, skillForUrl, skillsWith } from './registry.js'

describe('site skill registry', () => {
  it('resolves a URL to the skill that owns its host', () => {
    assert.equal(skillForUrl('https://www.workatastartup.com/jobs/93806')?.manifest.id, 'workatastartup')
    assert.equal(skillForUrl('https://www.linkedin.com/in/someone')?.manifest.id, 'linkedin')
  })

  it('matches subdomains but not lookalike domains', () => {
    assert.equal(skillForUrl('https://jobs.workatastartup.com/x')?.manifest.id, 'workatastartup')
    // The suffix check must be on a dot boundary, or `notlinkedin.com` matches.
    assert.equal(skillForUrl('https://notlinkedin.com/in/someone'), null)
  })

  it('returns null for a site nothing covers, and for a non-URL', () => {
    assert.equal(skillForUrl('https://boards.greenhouse.io/acme/jobs/1'), null)
    assert.equal(skillForUrl('not a url'), null)
  })

  it('lists skills by capability', () => {
    assert.deepEqual(
      skillsWith('search').map((skill) => skill.manifest.id),
      ['workatastartup'],
    )
    assert.deepEqual(
      skillsWith('outreach').map((skill) => skill.manifest.id),
      ['linkedin'],
    )
  })

  it('gives every skill a manifest whose allowed domains include its own', () => {
    for (const skill of allSkills()) {
      for (const domain of skill.manifest.domains) {
        assert.ok(
          skill.manifest.allowedDomains.includes(domain),
          `${skill.manifest.id} may not navigate to its own domain ${domain}`,
        )
      }
    }
  })

  it('finds a skill by id', () => {
    assert.equal(skillById('linkedin')?.manifest.label, 'LinkedIn')
    assert.equal(skillById('nope'), null)
  })
})
