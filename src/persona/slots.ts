/**
 * The persona, as a catalogue of slots.
 *
 * Two rules decide what belongs here, and both were learned from what the old
 * wizard got wrong.
 *
 * **Only ask about things the system can act on.** A question about company
 * stage or preferred domain sounds insightful, but nothing downstream reads
 * the answer — not the query planner, not the scorer. Asking it would be
 * theatre. Every slot below feeds one or both.
 *
 * **Form fields are not intake.** Phone, notice period, CTC and work
 * authorisation buy no matching accuracy whatsoever; they are needed once, to
 * fill a form, at the moment of the first application. They live here marked
 * `apply` so the intake never asks for them, which is most of what made the
 * old six-step wizard feel long.
 */

export type SlotStage = 'intake' | 'apply'
export type SlotSource = 'resume' | 'asked' | 'inferred' | 'default'

export type QuestionKind = 'chips' | 'choice' | 'text'

export interface Question {
  kind: QuestionKind
  /** Shown as the question. Written to be answerable in one glance. */
  prompt: string
  /** A sentence of context, when the question needs one. Often none. */
  help?: string
  options?: Array<{ value: string; label: string }>
  /** Chips only: how many may be picked. */
  max?: number
}

export interface SlotDefinition {
  id: string
  stage: SlotStage
  /**
   * Fallback estimate of how much this slot moves the result set, used before
   * there are any jobs to measure against. Measured impact always wins.
   */
  prior: number
  question: Question
  /**
   * The plausible answers, with rough priors, used to simulate what each
   * branch would do to the ranking. Not shown to the user.
   */
  branches: string[][]
}

export const SENIORITY_OPTIONS = [
  { value: 'junior', label: 'Junior — 0 to 2 years' },
  { value: 'mid', label: 'Mid — 2 to 5 years' },
  { value: 'senior', label: 'Senior — 5 to 9 years' },
  { value: 'staff', label: 'Staff and above' },
]

export const LOCATION_OPTIONS = [
  { value: 'remote', label: 'Remote only' },
  { value: 'hybrid', label: 'Hybrid — some days in an office' },
  { value: 'onsite', label: 'On-site' },
  { value: 'any', label: 'Any of these' },
]

/**
 * Intake slots, roughly in the order they tend to matter. The selector
 * reorders by measured impact — this is only the tie-break.
 */
export const SLOTS: SlotDefinition[] = [
  {
    id: 'target_titles',
    stage: 'intake',
    prior: 1,
    question: {
      kind: 'chips',
      prompt: 'Which roles should Hunty search for?',
      help: 'Pick the ones you would actually take. Each becomes a search.',
      max: 5,
      options: [
        { value: 'backend engineer', label: 'Backend Engineer' },
        { value: 'full stack engineer', label: 'Full Stack Engineer' },
        { value: 'frontend engineer', label: 'Frontend Engineer' },
        { value: 'software engineer', label: 'Software Engineer / SDE' },
        { value: 'devops engineer', label: 'DevOps / SRE' },
        { value: 'platform engineer', label: 'Platform Engineer' },
        { value: 'mobile engineer', label: 'Mobile Engineer' },
        { value: 'data engineer', label: 'Data Engineer' },
      ],
    },
    branches: [['backend engineer'], ['frontend engineer'], ['devops engineer']],
  },
  {
    id: 'location_mode',
    stage: 'intake',
    prior: 0.9,
    question: {
      kind: 'choice',
      prompt: 'Where do you want to work?',
      options: LOCATION_OPTIONS,
    },
    branches: [['remote'], ['hybrid'], ['onsite']],
  },
  {
    id: 'markets',
    stage: 'intake',
    prior: 0.85,
    question: {
      kind: 'chips',
      prompt: 'Which places should Hunty look in?',
      help: 'Remote roles are always included.',
      max: 4,
      options: [
        { value: 'India', label: '🇮🇳 India' },
        { value: 'Dubai', label: '🇦🇪 UAE' },
        { value: 'Riyadh', label: '🇸🇦 Saudi Arabia' },
        { value: 'Singapore', label: '🇸🇬 Singapore' },
        { value: 'London', label: '🇬🇧 UK' },
        { value: 'United States', label: '🇺🇸 US' },
        { value: 'Germany', label: '🇩🇪 Germany' },
      ],
    },
    branches: [['India'], ['Dubai'], ['United States']],
  },
  {
    id: 'seniority',
    stage: 'intake',
    prior: 0.7,
    question: {
      kind: 'choice',
      prompt: 'What level are you aiming at?',
      options: SENIORITY_OPTIONS,
    },
    branches: [['junior'], ['mid'], ['senior'], ['staff']],
  },
  {
    id: 'must_have_stack',
    stage: 'intake',
    prior: 0.6,
    question: {
      kind: 'chips',
      prompt: 'Which of these do you want to keep working with?',
      help: 'We read these off your resume — fix anything wrong.',
      max: 10,
    },
    branches: [],
  },
  {
    id: 'avoid',
    stage: 'intake',
    prior: 0.5,
    question: {
      kind: 'text',
      prompt: 'Anything that would make you say no immediately?',
      help: 'A stack, a kind of company, a commute. One line is enough.',
    },
    branches: [],
  },

  /* ---- collected at the first application, never during intake ---- */
  { id: 'phone', stage: 'apply', prior: 0, question: { kind: 'text', prompt: 'Phone number' }, branches: [] },
  { id: 'notice_period', stage: 'apply', prior: 0, question: { kind: 'text', prompt: 'Notice period' }, branches: [] },
  { id: 'current_ctc', stage: 'apply', prior: 0, question: { kind: 'text', prompt: 'Current salary' }, branches: [] },
  { id: 'expected_ctc', stage: 'apply', prior: 0, question: { kind: 'text', prompt: 'Expected salary' }, branches: [] },
  { id: 'work_authorization', stage: 'apply', prior: 0, question: { kind: 'text', prompt: 'Work authorisation' }, branches: [] },
  { id: 'relocation', stage: 'apply', prior: 0, question: { kind: 'text', prompt: 'Willing to relocate?' }, branches: [] },
]

export const INTAKE_SLOTS = SLOTS.filter((slot) => slot.stage === 'intake')

export function slotById(id: string): SlotDefinition | undefined {
  return SLOTS.find((slot) => slot.id === id)
}

/** Above this a slot is considered known and is never asked about. */
export const CONFIDENT_ENOUGH = 0.6

/** Hard ceiling on intake questions. The target is five. */
export const QUESTION_CAP = 7

/**
 * Stop when the best remaining question would not change the results much.
 * Asking anyway costs a question and buys a rounding error.
 */
export const IMPACT_FLOOR = 0.12

/**
 * `avoid` is the one free-text intake slot, so its stored value is a string
 * while every consumer wants a list. Coercing at every read rather than at
 * write keeps whatever the user actually typed intact — and forgetting it once
 * crashed the ranking with `dealBreakers.map is not a function`.
 */
export function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string')
  if (typeof value === 'string') {
    return value
      .split(/[,\n;]/)
      .map((part) => part.trim())
      .filter(Boolean)
  }
  return []
}
