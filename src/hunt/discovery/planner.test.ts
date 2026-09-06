import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { expandTitles, marketFor, planQueries, resolveMarkets } from './planner.js'

describe('query planner', () => {
  it('keeps what the user typed as the first search', () => {
    const titles = expandTitles(['Backend Engineer'])
    assert.equal(titles[0], 'backend engineer')
  })

  it('expands house-style titles that boards phrase differently', () => {
    // A search for "SDE" alone misses every posting that said "Software
    // Engineer", and vice versa. Both matter in India.
    const titles = expandTitles(['SDE 2'])
    assert.ok(titles.includes('software engineer'), 'should reach the common phrasing')
    assert.ok(titles.some((t) => t.includes('sde')), 'should keep the house style')
  })

  it('never returns an empty plan', () => {
    const titles = expandTitles([])
    assert.deepEqual(titles, ['software engineer'])
  })

  it('maps Indian and Gulf cities to their markets', () => {
    assert.equal(marketFor('Bengaluru'), 'IN')
    assert.equal(marketFor('Gurgaon'), 'IN')
    assert.equal(marketFor('Dubai'), 'AE')
    assert.equal(marketFor('Riyadh'), 'SA')
    assert.equal(marketFor('Remote'), 'remote')
  })

  it('does not invent a market for something it does not know', () => {
    assert.equal(marketFor('Atlantis'), null)
  })

  it('always includes remote, because a remote job is open to everyone', () => {
    const markets = resolveMarkets({
      roles: [],
      locations: ['Bengaluru'],
      dreamCompanies: [],
    })
    assert.ok(markets.some((m) => m.market === 'remote'))
    assert.ok(markets.some((m) => m.market === 'IN'))
  })

  it('falls back to the home city when the spec names no location', () => {
    const markets = resolveMarkets({
      roles: [],
      locations: [],
      dreamCompanies: [],
      homeCity: 'Hyderabad',
      homeCountry: 'India',
    })
    assert.ok(markets.some((m) => m.market === 'IN'))
  })

  it('spreads the budget across markets instead of exhausting the first', () => {
    const plan = planQueries({
      roles: ['backend engineer', 'full stack'],
      locations: ['Bengaluru', 'Dubai'],
      dreamCompanies: [],
    })
    const markets = new Set(plan.queries.map((q) => q.market))
    // A budget spent entirely on India would make the Gulf vanish for a user
    // who explicitly asked for both.
    assert.ok(markets.has('IN'))
    assert.ok(markets.has('AE'))
    assert.ok(markets.has('remote'))
  })

  it('stays inside the query budget, and says so when it binds', () => {
    const plan = planQueries({
      roles: ['backend', 'frontend', 'full stack', 'devops', 'python', 'java', 'node', 'sde'],
      locations: ['Bengaluru', 'Dubai', 'Riyadh', 'Singapore', 'London', 'Remote'],
      dreamCompanies: [],
    })
    assert.equal(plan.queries.length, 30, 'the budget should be what stops it')
    assert.ok(plan.notes.some((n) => n.includes('budget')))
  })

  it('does not claim the budget bound when it did not', () => {
    const plan = planQueries({ roles: ['backend'], locations: ['Remote'], dreamCompanies: [] })
    assert.ok(plan.queries.length < 30)
    assert.ok(!plan.notes.some((n) => n.includes('budget')))
  })

  it('does not add remote for someone who wants to be in an office', () => {
    // Remote is appended for everyone by default, which is right for most
    // people and wrong for anyone who explicitly said on-site — they were
    // getting listings they had already ruled out.
    const markets = resolveMarkets({
      roles: [],
      locations: ['Bengaluru'],
      dreamCompanies: [],
      remotePreference: 'onsite',
    })
    assert.ok(!markets.some((m) => m.market === 'remote'))
    assert.ok(markets.some((m) => m.market === 'IN'))
  })

  it('searches only remote for someone who wants only remote', () => {
    const markets = resolveMarkets({
      roles: [],
      locations: ['Bengaluru', 'Dubai'],
      dreamCompanies: [],
      remotePreference: 'remote',
    })
    assert.deepEqual(markets.map((m) => m.market), ['remote'])
  })

  it('marks remote queries so sources can filter on it', () => {
    const plan = planQueries({ roles: ['backend'], locations: ['Remote'], dreamCompanies: [] })
    const remote = plan.queries.find((q) => q.market === 'remote')
    assert.equal(remote?.remoteOnly, true)
  })
})
