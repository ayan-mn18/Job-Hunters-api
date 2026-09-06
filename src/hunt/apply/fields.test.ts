import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fieldSignature, heuristicMatch, sensitiveReason, valueFromProfile, normaliseLabel } from './fields.js'
import type { PortalProfile } from '../portal-profile.js'

const profile = {
  fullName: 'Ayan Mansoori',
  email: 'ayan@example.com',
  phone: '+91 90000 00000',
  headline: 'Backend Engineer',
  noticePeriod: '30 days',
  workAuthorization: '',
  address: {
    line1: '1 Example Road',
    city: 'Bengaluru',
    region: 'Karnataka',
    postalCode: '560001',
    country: 'India',
  },
  links: {
    linkedin: 'linkedin.com/in/example',
    github: 'github.com/example',
    portfolio: '',
  },
} as unknown as PortalProfile

describe('questions we refuse to answer', () => {
  it('refuses demographic questions', () => {
    // Getting one of these wrong on someone's application is not a bug you can
    // apologise for afterwards.
    for (const label of [
      'Gender',
      'What is your race / ethnicity?',
      'Are you Hispanic or Latino?',
      'Veteran status',
      'Do you have a disability?',
    ]) {
      assert.ok(sensitiveReason(label), `should refuse: ${label}`)
    }
  })

  it('refuses salary expectations', () => {
    assert.ok(sensitiveReason('Expected salary'))
    assert.ok(sensitiveReason('Salary expectation (INR)'))
    assert.ok(sensitiveReason('Desired compensation'))
  })

  it('refuses visa and work-authorisation questions', () => {
    assert.ok(sensitiveReason('Will you require sponsorship?'))
    assert.ok(sensitiveReason('Work authorization'))
    assert.ok(sensitiveReason('Do you have the right to work in the UK?'))
  })

  it('refuses background and reference questions', () => {
    assert.ok(sensitiveReason('Have you ever been convicted of a felony?'))
    assert.ok(sensitiveReason('Reference email'))
  })

  it('still answers ordinary fields', () => {
    for (const label of ['Full name', 'Email', 'Phone', 'LinkedIn URL', 'City']) {
      assert.equal(sensitiveReason(label), null, `should answer: ${label}`)
    }
  })

  it('catches the phrasings real ATS forms actually use', () => {
    // Taken from live Greenhouse, Lever and Ashby forms.
    for (const label of [
      'Are you legally authorized to work in the United States?',
      'Will you now or in the future require sponsorship for employment visa status?',
      'What are your compensation expectations?',
      'Desired Salary Range',
      'Voluntary Self-Identification of Disability',
      'Please select your gender',
      'Minimum expected CTC',
    ]) {
      assert.ok(sensitiveReason(label), `should refuse: ${label}`)
    }
  })

  it('catches an unlabelled group by what it offers', () => {
    // Ashby renders gender as a radio group with no legend, so the label ends
    // up being the first option. The options give it away.
    assert.ok(sensitiveReason('Male', ['Male', 'Female', 'Non-binary', 'Prefer not to say']))
    assert.ok(
      sensitiveReason('Hispanic or Latino', ['Hispanic or Latino', 'White', 'Asian', 'Prefer not to say']),
    )
  })

  it('does not treat an ordinary two-option question as demographic', () => {
    assert.equal(sensitiveReason('Do you have a laptop?', ['Yes', 'No']), null)
    assert.equal(sensitiveReason('Preferred start date', ['Immediately', 'In a month']), null)
  })

  it('does not confuse current salary with an expectation prompt on a name field', () => {
    // "Salary" alone should not trip the expectation rule on unrelated labels.
    assert.equal(sensitiveReason('Salary History Verification Contact Name'), null)
  })
})

describe('field signatures', () => {
  const base = { label: 'Email', type: 'email', required: true }

  it('ignores cosmetic differences', () => {
    assert.equal(
      fieldSignature({ ...base, label: 'Email' }),
      fieldSignature({ ...base, label: '  email  ' }),
    )
    assert.equal(
      fieldSignature({ ...base, label: 'Email' }),
      fieldSignature({ ...base, label: 'Email*' }),
    )
  })

  it('separates genuinely different fields', () => {
    assert.notEqual(
      fieldSignature({ ...base, label: 'Email' }),
      fieldSignature({ ...base, label: 'Personal email' }),
    )
    assert.notEqual(
      fieldSignature({ ...base, label: 'Email', type: 'email' }),
      fieldSignature({ ...base, label: 'Email', type: 'text' }),
    )
  })
})

describe('heuristic mapping', () => {
  it('maps the labels that cover most forms', () => {
    assert.equal(heuristicMatch({ label: 'First Name', type: 'text', required: true }), 'firstName')
    assert.equal(heuristicMatch({ label: 'E-mail', type: 'email', required: true }), 'email')
    assert.equal(heuristicMatch({ label: 'Mobile', type: 'tel', required: false }), 'phone')
    assert.equal(heuristicMatch({ label: 'LinkedIn Profile', type: 'text', required: false }), 'linkedin')
    assert.equal(heuristicMatch({ label: 'PIN code', type: 'text', required: false }), 'postalCode')
    assert.equal(heuristicMatch({ label: 'When can you start?', type: 'text', required: false }), 'noticePeriod')
  })

  it('does not match a phrase buried in a long question', () => {
    // From a live GitLab form. "current employer" appears, but the question is
    // legal and the answer is not a company name.
    const label =
      'Are you subject to any employment agreements and/or restrictive covenants with your current employer?'
    assert.equal(heuristicMatch({ label, type: 'text', required: true }), null)
    // And it is refused outright, so no rung tries to answer it.
    assert.ok(sensitiveReason(label))
  })

  it('returns nothing for a question it does not recognise', () => {
    assert.equal(
      heuristicMatch({ label: 'Describe a system you are proud of', type: 'textarea', required: false }),
      null,
    )
  })

  it('reads values off the profile, and reports empties as missing', () => {
    assert.equal(valueFromProfile('firstName', profile), 'Ayan')
    assert.equal(valueFromProfile('lastName', profile), 'Mansoori')
    assert.equal(valueFromProfile('city', profile), 'Bengaluru')
    // An empty string is not an answer.
    assert.equal(valueFromProfile('portfolio', profile), null)
    assert.equal(valueFromProfile('nonsense', profile), null)
  })
})

describe('label normalisation', () => {
  it('strips the required markers forms actually use', () => {
    // Lever renders a heavy asterisk, not the ASCII one. Matching the raw
    // label meant an anchored pattern failed on the candidate's own name.
    assert.equal(normaliseLabel('Full name✱'), 'Full name')
    assert.equal(normaliseLabel('First Name*'), 'First Name')
    assert.equal(normaliseLabel('Email:'), 'Email')
    assert.equal(normaliseLabel('Phone (required)'), 'Phone')
  })

  it('collapses whitespace without changing the words', () => {
    assert.equal(normaliseLabel('  Current   company  '), 'Current company')
  })

  it('leaves an ordinary label alone', () => {
    assert.equal(normaliseLabel('LinkedIn URL'), 'LinkedIn URL')
  })
})
