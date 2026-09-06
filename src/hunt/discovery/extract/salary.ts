import type { RawSalary, SalaryPeriod } from '../types.js'

/**
 * Salary parsing.
 *
 * Structured fields are always preferred — most boards publish `salary_min` or
 * a JSON-LD `baseSalary`, and guessing from prose when the number is right
 * there is how you end up storing an equity percentage as an annual figure.
 * The regex path is the fallback, and it only accepts a figure that either
 * spans a range or sits next to an explicit pay word, because a lone "$500"
 * in a JD is far more often a stipend, a bonus, or a customer's invoice.
 */

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD',
  '£': 'GBP',
  '€': 'EUR',
  '₹': 'INR',
  '₨': 'INR',
  '¥': 'JPY',
  '₩': 'KRW',
  '₽': 'RUB',
  '₺': 'TRY',
  '₦': 'NGN',
  R$: 'BRL',
  'د.إ': 'AED',
  '﷼': 'SAR',
}

const CURRENCY_CODES = [
  'USD', 'EUR', 'GBP', 'INR', 'AED', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR',
  'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'JPY', 'CNY', 'CHF', 'SEK', 'NOK',
  'DKK', 'PLN', 'ZAR', 'BRL', 'MXN', 'PHP', 'IDR', 'MYR', 'THB', 'VND',
]

const MULTIPLIERS: Array<[RegExp, number]> = [
  [/^(?:k|thousand)$/i, 1_000],
  [/^(?:m|mn|million)$/i, 1_000_000],
  [/^(?:l|lac|lakh|lakhs|lpa)$/i, 100_000],
  [/^(?:cr|crore|crores)$/i, 10_000_000],
  // Only ever appears in company-size boasts ("$5.6 billion in payments"),
  // never in pay. Captured so the plausibility check can throw it out.
  [/^(?:b|bn|billion|trillion)$/i, 1_000_000_000],
]

/** Sanity bounds per period, in the posting's own currency units. */
const PLAUSIBLE: Record<SalaryPeriod, [number, number]> = {
  hour: [1, 5_000],
  day: [10, 40_000],
  week: [50, 200_000],
  month: [100, 5_000_000],
  year: [1_000, 100_000_000],
}

function plausible(amount: number, period: SalaryPeriod | null, currency?: string | null): boolean {
  if (amount <= 0) return false
  // With no period stated, only reject the obviously absurd.
  if (!period) return amount < 100_000_000
  const [low, high] = PLAUSIBLE[period]
  if (amount < low || amount > high) return false
  // The generic ceilings have to accommodate rupees and rupiah; a figure in a
  // strong currency gets a much tighter one.
  if (currency && STRONG_CURRENCIES.has(currency) && amount > STRONG_LIMITS[period]) return false
  return true
}

const PERIOD_WORDS: Array<[RegExp, SalaryPeriod]> = [
  [/per\s+hour|hourly|\/\s?hour|\/\s?hr\b|an\s+hour/i, 'hour'],
  [/per\s+day|daily|\/\s?day\b/i, 'day'],
  [/per\s+week|weekly|\/\s?week\b/i, 'week'],
  [/per\s+month|monthly|\/\s?month\b|\/\s?mo\b|a\s+month|pm\b/i, 'month'],
  [/per\s+(?:year|annum)|annually|yearly|annual|\/\s?year\b|\/\s?yr\b|p\.?a\.?\b|lpa\b|a\s+year/i, 'year'],
]

/**
 * "budget" is deliberately absent: in a job ad it almost always means an ad
 * budget or a learning budget, and including it stored a $500K monthly media
 * spend as somebody's pay.
 */
const PAY_CONTEXT =
  /salary|compensation|base\s+pay|pay\s+range|pay\s+band|remuneration|\bctc\b|package|offer(?:ing)?|earn|stipend|\brate\b/i

/** Currencies where a five-figure monthly salary is already extraordinary. */
const STRONG_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'CHF', 'CAD', 'AUD', 'SGD', 'NZD'])

const STRONG_LIMITS: Record<SalaryPeriod, number> = {
  hour: 2_000,
  day: 10_000,
  week: 50_000,
  month: 150_000,
  year: 2_000_000,
}

const AMOUNT = String.raw`(\d{1,3}(?:[, \s]\d{2,3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(k|m|mn|million|thousand|b|bn|billion|trillion|l|lac|lakhs?|lpa|cr|crores?)?`
const SYMBOL = String.raw`(R\$|[$£€₹₨¥₩₽₺₦]|USD|EUR|GBP|INR|AED|SAR|QAR|KWD|CAD|AUD|SGD|CHF|ZAR|BRL|PHP|MYR)`

const RANGE_PATTERN = new RegExp(
  String.raw`${SYMBOL}?\s*${AMOUNT}\s*(?:-|–|—|to|up\s+to)\s*${SYMBOL}?\s*${AMOUNT}`,
  'gi',
)
const SINGLE_PATTERN = new RegExp(String.raw`${SYMBOL}\s*${AMOUNT}`, 'gi')

function multiplierFor(suffix: string | undefined): number {
  if (!suffix) return 1
  for (const [pattern, factor] of MULTIPLIERS) {
    if (pattern.test(suffix)) return factor
  }
  return 1
}

function toAmount(digits: string | undefined, suffix: string | undefined): number | null {
  if (!digits) return null
  const value = Number(digits.replace(/[, \s]/g, ''))
  if (!Number.isFinite(value) || value <= 0) return null
  return value * multiplierFor(suffix)
}

function currencyOf(token: string | undefined, context: string): string | null {
  const symbol = token?.trim()
  if (symbol) {
    const mapped = CURRENCY_SYMBOLS[symbol]
    if (mapped) return mapped
    const upper = symbol.toUpperCase()
    if (CURRENCY_CODES.includes(upper)) return upper
  }
  const code = CURRENCY_CODES.find((value) => new RegExp(`\\b${value}\\b`).test(context))
  if (code) return code
  if (/\blpa\b|\blakhs?\b|\bcrores?\b|₹/i.test(context)) return 'INR'
  return null
}

function periodOf(context: string, amount: number | null, currency: string | null): SalaryPeriod | null {
  for (const [pattern, period] of PERIOD_WORDS) {
    if (pattern.test(context)) return period
  }
  if (amount === null) return null
  // Fall back on magnitude. An INR figure needs a different threshold from a
  // USD one, which is why currency is part of the decision.
  const yearly = currency === 'INR' ? 400_000 : 20_000
  if (amount >= yearly) return 'year'
  if (amount >= (currency === 'INR' ? 25_000 : 2000)) return 'month'
  if (amount <= (currency === 'INR' ? 5000 : 500)) return 'hour'
  return null
}

/** `context` is the surrounding text used to decide currency and period. */
function contextAround(text: string, index: number, length: number): string {
  return text.slice(Math.max(0, index - 90), index + length + 90)
}

export interface SalaryInput {
  descriptionText?: string
  /** Already-structured values from the source or from JSON-LD. */
  fromSource?: RawSalary | undefined
  /** Verbatim salary string a board sometimes publishes on its own. */
  sourceText?: string | undefined
}

export function formatSalary(salary: RawSalary): string | null {
  const { min, max, currency, period } = salary
  if (min === null && max === null) return null
  const format = (value: number): string =>
    value >= 1000 ? `${Math.round(value).toLocaleString('en-US')}` : String(Math.round(value))
  const prefix = currency ? `${currency} ` : ''
  const body = min !== null && max !== null && min !== max
    ? `${format(min)}–${format(max)}`
    : format((min ?? max) as number)
  const suffix = period ? ` per ${period}` : ''
  return `${prefix}${body}${suffix}`
}

export function extractSalary(input: SalaryInput): RawSalary {
  const empty: RawSalary = { min: null, max: null, currency: null, period: null, text: null }

  if (input.fromSource && (input.fromSource.min !== null || input.fromSource.max !== null)) {
    const salary = { ...input.fromSource }
    if (!salary.period) {
      salary.period = periodOf(input.sourceText ?? '', salary.min ?? salary.max, salary.currency)
    }
    salary.text = input.sourceText?.trim() || formatSalary(salary)
    return salary
  }

  const text = input.sourceText ?? input.descriptionText ?? ''
  if (!text) return empty

  for (const match of text.matchAll(RANGE_PATTERN)) {
    const context = contextAround(text, match.index ?? 0, match[0].length)
    const min = toAmount(match[2], match[3])
    const max = toAmount(match[5], match[6])
    if (min === null || max === null || max < min) continue
    const currency = currencyOf(match[1] ?? match[4], context)
    const period = periodOf(context, min, currency)
    // A range with no currency symbol at all needs an explicit period word to
    // be money — "5–7" next to the word "package" is a team size or a rating,
    // and was being stored as an hourly rate.
    const explicitPeriod = PERIOD_WORDS.some(([pattern]) => pattern.test(context))
    if (!currency && !explicitPeriod) continue
    if (!currency && !PAY_CONTEXT.test(context)) continue
    if (!plausible(min, period, currency) || !plausible(max, period, currency)) continue
    return {
      min,
      max,
      currency,
      period,
      text: match[0].replace(/\s+/g, ' ').trim(),
    }
  }

  for (const match of text.matchAll(SINGLE_PATTERN)) {
    const context = contextAround(text, match.index ?? 0, match[0].length)
    if (!PAY_CONTEXT.test(context)) continue
    const value = toAmount(match[2], match[3])
    if (value === null) continue
    const currency = currencyOf(match[1], context)
    const period = periodOf(context, value, currency)
    if (!plausible(value, period, currency)) continue
    return {
      min: value,
      max: value,
      currency,
      period,
      text: match[0].replace(/\s+/g, ' ').trim(),
    }
  }

  return empty
}
