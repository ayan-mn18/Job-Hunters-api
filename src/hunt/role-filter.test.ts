import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { classifyRole, isSoftwareRole } from './role-filter.js'

describe('role filter', () => {
  it('accepts software engineering titles', () => {
    const accepted = [
      'Senior Software Engineer',
      'Software Engineer II',
      'Senior Backend Engineer',
      'Full Stack Engineer',
      'Frontend Developer',
      'Java Developer',
      'Senior TypeScript Engineer',
      'Node.js Engineer',
      'SDE III',
      'Platform Engineer',
      'Senior Software Development Engineer',
      'Web Developer',
      'Senior Software Engineer, Payments',
    ]
    for (const title of accepted) {
      assert.equal(isSoftwareRole(title), true, `expected accepted: ${title}`)
    }
  })

  it('rejects the roles that were cluttering the dashboard', () => {
    const rejected = [
      'Technical Program Manager - Autonomous Systems C2',
      'Senior Product Manager, Developer Platform',
      'Demand Generation Lead, Growth',
      'Freelance Copywriter',
      'Product Designer',
      'Senior Manager, Deal Desk',
      'Enterprise Account Executive',
      'Credit Risk Operations Associate',
      'Senior Underwriting Officer, Construction',
      'Telehealth Mental Health Provider',
      'Sr. Communications Manager',
      'Customer Success Manager, Key Accounts',
      'Accountant',
      'Business Analyst',
      'Engineering Manager, AI',
      'Director of Engineering',
      'Software Engineering Intern',
      'Solutions Architect',
      'Data Scientist',
    ]
    for (const title of rejected) {
      assert.equal(isSoftwareRole(title), false, `expected rejected: ${title}`)
    }
  })

  it('rejects machine learning and QA as out of domain', () => {
    assert.equal(isSoftwareRole('Machine Learning Engineer'), false)
    assert.equal(isSoftwareRole('Senior ML Engineer'), false)
    assert.equal(isSoftwareRole('Senior QA Automation Engineer'), false)
    assert.equal(isSoftwareRole('SDET'), false)
  })

  it('classifies families so scoring can prefer the closest ones', () => {
    assert.deepEqual(classifyRole('Senior Backend Engineer'), { kind: 'software', family: 'backend' })
    assert.deepEqual(classifyRole('Full Stack Engineer'), { kind: 'software', family: 'fullstack' })
    assert.deepEqual(classifyRole('Android Engineer'), { kind: 'software', family: 'mobile' })
    assert.deepEqual(classifyRole('Site Reliability Engineer'), { kind: 'software', family: 'devops' })
  })

  it('does not let a manager title through on the word developer', () => {
    const verdict = classifyRole('Product Manager, Developer Platform')
    assert.equal(verdict.kind, 'rejected')
  })
})

describe('role filter, second pass', () => {
  it('rejects adjacent-but-not-engineering titles seen in the first big scrape', () => {
    for (const title of [
      'Support Engineer (EMEA - Weekends)',
      'Developer Relations Engineer',
      'Sr. Production Engineer, Solutions Engineering',
      'Sr. Forward Deployed Software Engineer - Dubbing Platform',
      'Sales Engineering Manager',
    ]) {
      assert.equal(isSoftwareRole(title), false, `expected rejected: ${title}`)
    }
  })

  it('still accepts the real engineering titles from that scrape', () => {
    for (const title of [
      'Senior Software Engineer Backend',
      'Staff Software Engineer, Storage Platform',
      'Software Engineer, Core Infrastructure',
      'Senior React Developer',
      'Full Stack Developer (AI Agents)',
      'Backend Engineer - Studio Media Platform',
      'Software Engineer L3',
    ]) {
      assert.equal(isSoftwareRole(title), true, `expected accepted: ${title}`)
    }
  })
})
