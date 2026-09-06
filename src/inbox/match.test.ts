import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { atsFor, domainOf, matchEmail, type MatchableApplication } from './match.js'

const stripe: MatchableApplication = {
  id: 'app-stripe',
  company: 'Stripe',
  portalId: 'greenhouse',
  jobUrl: 'https://boards.greenhouse.io/stripe/jobs/1234',
  externalJobId: 'stripe:1234',
}

const shopify: MatchableApplication = {
  id: 'app-shopify',
  company: 'Shopify',
  portalId: 'greenhouse',
  jobUrl: 'https://boards.greenhouse.io/shopify/jobs/9999',
  externalJobId: 'shopify:9999',
}

const razorpay: MatchableApplication = {
  id: 'app-razorpay',
  company: 'Razorpay',
  portalId: 'lever',
  jobUrl: 'https://jobs.lever.co/razorpay/abc',
  externalJobId: null,
}

describe('sender domains', () => {
  it('pulls the domain off an address', () => {
    assert.equal(domainOf('no-reply@us.greenhouse-mail.io'), 'us.greenhouse-mail.io')
    assert.equal(domainOf('Recruiting <talent@lever.co>'), 'lever.co')
  })

  it('recognises the ATS platforms application mail actually comes from', () => {
    assert.equal(atsFor('no-reply@us.greenhouse-mail.io'), 'greenhouse')
    assert.equal(atsFor('x@boards.greenhouse.io'), 'greenhouse')
    assert.equal(atsFor('careers@hire.lever.co'), 'lever')
    assert.equal(atsFor('no-reply@ashbyhq.com'), 'ashby')
    assert.equal(atsFor('jobs@myworkdayjobs.com'), 'workday')
  })

  it('does not claim an ordinary company domain is an ATS', () => {
    assert.equal(atsFor('someone@stripe.com'), null)
    assert.equal(atsFor('hr@gmail.com'), null)
  })
})

describe('matching a reply to an application', () => {
  it('matches on a quoted job URL, which is unambiguous', () => {
    const result = matchEmail(
      {
        fromAddress: 'no-reply@us.greenhouse-mail.io',
        subject: 'Your application',
        links: ['https://boards.greenhouse.io/stripe/jobs/1234'],
      },
      [stripe, shopify],
    )
    assert.equal(result.applicationId, 'app-stripe')
    assert.equal(result.matchedBy, 'url')
  })

  it('uses the ATS domain narrowed by the company named in the subject', () => {
    const result = matchEmail(
      { fromAddress: 'no-reply@us.greenhouse-mail.io', subject: 'Your Stripe application' },
      [stripe, shopify],
    )
    assert.equal(result.applicationId, 'app-stripe')
    assert.equal(result.matchedBy, 'ats_domain')
  })

  it('refuses to guess between two applications on the same ATS', () => {
    // Every Greenhouse customer mails from the same domain. Telling someone
    // Stripe replied when it was Shopify is a mistake they will act on.
    const result = matchEmail(
      {
        fromAddress: 'no-reply@us.greenhouse-mail.io',
        subject: 'Update on your application at Stripe and Shopify',
      },
      [stripe, shopify],
    )
    assert.equal(result.applicationId, null)
    assert.equal(result.matchedBy, null)
  })

  it('accepts a lone application on that ATS when nothing contradicts it', () => {
    const result = matchEmail(
      { fromAddress: 'careers@hire.lever.co', subject: 'Thanks for applying' },
      [stripe, razorpay],
    )
    assert.equal(result.applicationId, 'app-razorpay')
    assert.ok(result.confidence < 0.9, 'a weaker signal should carry lower confidence')
  })

  it('falls back to the company name on an ordinary sender domain', () => {
    const result = matchEmail(
      { fromAddress: 'recruiting@razorpay.com', subject: 'Next steps' },
      [stripe, razorpay],
    )
    assert.equal(result.applicationId, 'app-razorpay')
    assert.equal(result.matchedBy, 'company')
  })

  it('does not match a company name that is merely a substring of another', () => {
    const stripey: MatchableApplication = {
      id: 'app-stripey',
      company: 'St',
      portalId: null,
      jobUrl: null,
      externalJobId: null,
    }
    // Two-letter names would otherwise match almost any subject line.
    const result = matchEmail({ fromAddress: 'x@example.com', subject: 'Interview' }, [stripey])
    assert.equal(result.applicationId, null)
  })

  it('returns no match rather than a wrong one', () => {
    const result = matchEmail(
      { fromAddress: 'newsletter@substack.com', subject: 'This week in tech' },
      [stripe, shopify, razorpay],
    )
    assert.equal(result.applicationId, null)
    assert.equal(result.confidence, 0)
  })

  it('handles having no applications at all', () => {
    const result = matchEmail({ fromAddress: 'a@b.com', subject: 'hi' }, [])
    assert.equal(result.applicationId, null)
  })
})
