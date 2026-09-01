import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { htmlToText, sanitiseHtml } from '../html.js'
import { readJobPosting } from '../jsonld.js'
import { extractExperience } from './experience.js'
import { extractResponsibilities } from './responsibilities.js'
import { extractSalary } from './salary.js'
import { splitSections } from './sections.js'
import { extractSkills, skillNames } from './skills.js'

const POSTING = `
About the role

We are hiring a Senior Backend Engineer to own our payments platform.

Responsibilities
<ul>
<li>Design and ship services that move money for millions of customers.</li>
<li>Own the reliability of the payments API, including on-call rotation.</li>
<li>Mentor two engineers and raise the bar in code review.</li>
<li>Partner with product to shape the roadmap for the next quarter.</li>
</ul>

Requirements
<ul>
<li>4+ years of professional experience building backend services.</li>
<li>Strong TypeScript and Node.js, plus PostgreSQL and Redis.</li>
<li>Comfortable with Kubernetes and CI/CD pipelines.</li>
</ul>

Benefits
<ul>
<li>Free lunch and a yearly learning budget of $2,000.</li>
</ul>
`

const TEXT = htmlToText(POSTING)

describe('html', () => {
  it('keeps list structure as bullets', () => {
    assert.match(TEXT, /• Design and ship services/)
    assert.ok(TEXT.split('\n').length > 8)
  })

  it('strips scripts and unsafe links when sanitising', () => {
    const dirty = '<p onclick="steal()">Hi</p><script>steal()</script><a href="javascript:alert(1)">x</a>'
    const clean = sanitiseHtml(dirty)
    assert.ok(!clean.includes('script'))
    assert.ok(!clean.includes('onclick'))
    assert.ok(!clean.includes('javascript:'))
    assert.match(clean, /<p>Hi<\/p>/)
  })
})

describe('sections', () => {
  it('labels responsibilities, requirements and benefits', () => {
    const kinds = splitSections(TEXT).map((section) => section.kind)
    assert.ok(kinds.includes('responsibilities'))
    assert.ok(kinds.includes('requirements'))
    assert.ok(kinds.includes('benefits'))
  })
})

describe('skills', () => {
  it('finds taxonomy skills and prefers the requirements section', () => {
    const found = extractSkills({ title: 'Senior Backend Engineer', descriptionText: TEXT })
    const names = skillNames(found)
    for (const expected of ['TypeScript', 'Node.js', 'PostgreSQL', 'Redis', 'Kubernetes', 'CI/CD']) {
      assert.ok(names.includes(expected), `missing ${expected} in ${names.join(', ')}`)
    }
  })

  it('resolves aliases to one canonical name', () => {
    const names = skillNames(extractSkills({ descriptionText: 'We use reactjs, React.js and React daily with k8s.' }))
    assert.equal(names.filter((name) => name === 'React').length, 1)
    assert.ok(names.includes('Kubernetes'))
  })

  it('does not match short ambiguous aliases in the wrong case', () => {
    const names = skillNames(extractSkills({ descriptionText: 'Please go to our careers page and apply.' }))
    assert.ok(!names.includes('Go'))
  })
})

describe('experience', () => {
  it('reads an open-ended minimum', () => {
    const range = extractExperience({ descriptionText: TEXT })
    assert.equal(range.min, 4)
    assert.ok(range.text)
  })

  it('reads ranges', () => {
    const range = extractExperience({ descriptionText: 'Requirements\n3-5 years of relevant experience required.' })
    assert.equal(range.min, 3)
    assert.equal(range.max, 5)
  })

  it('reads spelled-out numbers', () => {
    const range = extractExperience({ descriptionText: 'Requirements\nMinimum of three (3) years of experience.' })
    assert.equal(range.min, 3)
  })

  it('recognises entry level', () => {
    const range = extractExperience({ descriptionText: 'Freshers welcome. No prior experience is required.' })
    assert.equal(range.min, 0)
  })

  it('returns nulls rather than guessing when the posting is silent', () => {
    const range = extractExperience({ descriptionText: 'We build great products with great people.' })
    assert.equal(range.min, null)
    assert.equal(range.max, null)
  })

  it('prefers schema.org months when the source publishes them', () => {
    const range = extractExperience({ descriptionText: TEXT, monthsFromSource: 72 })
    assert.equal(range.min, 6)
  })
})

describe('responsibilities', () => {
  it('takes bullets from the responsibilities section only', () => {
    const bullets = extractResponsibilities({ descriptionText: TEXT })
    assert.ok(bullets.length >= 3 && bullets.length <= 6)
    assert.match(bullets[0] ?? '', /Design and ship services/)
    assert.ok(!bullets.some((line) => /Free lunch/.test(line)))
    assert.ok(!bullets.some((line) => /years of professional experience/.test(line)))
  })

  it('truncates long bullets on a word boundary', () => {
    const long = `Responsibilities\n• ${'ship '.repeat(60)}done`
    const bullets = extractResponsibilities({ descriptionText: long })
    assert.ok((bullets[0]?.length ?? 0) <= 141)
    assert.match(bullets[0] ?? '', /…$/)
  })
})

describe('salary', () => {
  it('reads a currency range', () => {
    const salary = extractSalary({ descriptionText: 'The salary range is $120,000 - $150,000 per year.' })
    assert.equal(salary.min, 120_000)
    assert.equal(salary.max, 150_000)
    assert.equal(salary.currency, 'USD')
    assert.equal(salary.period, 'year')
  })

  it('understands lakh notation', () => {
    const salary = extractSalary({ descriptionText: 'CTC: ₹18 LPA to ₹24 LPA depending on experience.' })
    assert.equal(salary.min, 1_800_000)
    assert.equal(salary.max, 2_400_000)
    assert.equal(salary.currency, 'INR')
  })

  it('ignores money that is not pay', () => {
    const salary = extractSalary({ descriptionText: 'We process $2,000 of payments a second.' })
    assert.equal(salary.min, null)
  })

  it('does not read a bare number range as money', () => {
    const salary = extractSalary({ descriptionText: 'You will work with 2 to 5 other engineers.' })
    assert.equal(salary.min, null)
  })

  it('prefers structured values from the source', () => {
    const salary = extractSalary({
      descriptionText: 'The salary range is $10 - $20 per hour.',
      fromSource: { min: 90_000, max: 110_000, currency: 'USD', period: 'year', text: null },
    })
    assert.equal(salary.min, 90_000)
    assert.equal(salary.period, 'year')
    assert.equal(salary.text, 'USD 90,000–110,000 per year')
  })
})

describe('json-ld', () => {
  it('reads a JobPosting block', () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Backend Engineer',
      description: '<p>Build things</p>',
      employmentType: 'FULL_TIME',
      datePosted: '2026-08-01',
      hiringOrganization: { '@type': 'Organization', name: 'Acme' },
      jobLocation: { '@type': 'Place', address: { addressLocality: 'Berlin', addressCountry: 'DE' } },
      baseSalary: { '@type': 'MonetaryAmount', currency: 'EUR', value: { minValue: 70000, maxValue: 90000, unitText: 'YEAR' } },
      experienceRequirements: { '@type': 'OccupationalExperienceRequirements', monthsOfExperience: 48 },
    })}</script></head><body></body></html>`
    const posting = readJobPosting(html)
    assert.ok(posting)
    assert.equal(posting?.title, 'Backend Engineer')
    assert.equal(posting?.company, 'Acme')
    assert.equal(posting?.employmentType, 'full_time')
    assert.equal(posting?.salary?.min, 70_000)
    assert.equal(posting?.salary?.currency, 'EUR')
    assert.equal(posting?.experienceMonths, 48)
    assert.match(posting?.locationText ?? '', /Berlin/)
  })

  it('finds a posting inside an @graph', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@graph': [{ '@type': 'WebPage' }, { '@type': 'JobPosting', title: 'SRE' }],
    })}</script>`
    assert.equal(readJobPosting(html)?.title, 'SRE')
  })

  it('returns null when there is no posting', () => {
    assert.equal(readJobPosting('<html><body>nothing</body></html>'), null)
  })
})

describe('salary false positives', () => {
  it('rejects a bare range with no currency and no period', () => {
    const salary = extractSalary({
      descriptionText: 'We offer a competitive package. Team size 5–7 across two squads.',
    })
    assert.equal(salary.min, null)
  })

  it('rejects company-scale figures', () => {
    const salary = extractSalary({
      descriptionText: 'We process $5.6 billion in payments. Salary is competitive.',
    })
    assert.equal(salary.min, null)
  })

  it('still reads a real hourly rate', () => {
    const salary = extractSalary({ descriptionText: 'The rate of pay is $50-$75 per hour.' })
    assert.equal(salary.min, 50)
    assert.equal(salary.period, 'hour')
  })
})

describe('experience headline requirement', () => {
  it('takes the first requirement, not the smallest per-skill minimum', () => {
    const jd = [
      'Requirements',
      'Bachelor’s degree plus 5 years of professional experience as a Machine Learning Engineer.',
      'Must also have: 3 years of professional experience designing large systems.',
      '2 years of professional experience working with modern cloud platforms.',
      '1 year of professional experience leading technical initiatives.',
    ].join('\n')
    const range = extractExperience({ descriptionText: jd })
    assert.equal(range.min, 5)
  })
})
