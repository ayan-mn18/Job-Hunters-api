import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler, ok } from '../../lib/http.js'
import { currentUser, requireAuth } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import {
  answerPairwise,
  completeIntake,
  nextPairwise,
  nextQuestion,
  submitAnswer,
} from '../../persona/intake.js'
import { loadPersona } from '../../persona/store.js'
import { INTAKE_SLOTS } from '../../persona/slots.js'

export const intakeRouter: Router = Router()
intakeRouter.use(requireAuth)

/**
 * The server picks the questions.
 *
 * The client renders whatever it is handed and posts the answer back. It never
 * holds the question list, because which question is worth asking depends on
 * what the resume already said and on what would change this user's results —
 * neither of which the browser can know.
 */
intakeRouter.get(
  '/next',
  asyncHandler(async (req, res) => {
    ok(res, await nextQuestion(currentUser(req).id))
  }),
)

const answerSchema = z.object({
  slotId: z.string().trim().min(1).max(60),
  // Shape depends on the slot: a chip list, a single choice, or a line of text.
  value: z.union([
    z.string().max(2000),
    z.array(z.string().max(200)).max(50),
    z.number(),
    z.boolean(),
  ]),
})

intakeRouter.post(
  '/answer',
  validate({ body: answerSchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof answerSchema>
    ok(res, await submitAnswer(currentUser(req).id, body.slotId, body.value))
  }),
)

intakeRouter.post(
  '/complete',
  asyncHandler(async (req, res) => {
    ok(res, await completeIntake(currentUser(req).id))
  }),
)

const roundSchema = z.object({ round: z.coerce.number().int().min(1).max(5).default(1) })

/**
 * Two real postings, side by side.
 *
 * This is the part that does the work of several questions. Which of two jobs
 * someone would take reveals a trade-off — brand against stack, salary against
 * remote — that they cannot reliably report on a form, and it reads as a game
 * rather than an interrogation.
 */
intakeRouter.get(
  '/pairwise',
  validate({ query: roundSchema }),
  asyncHandler(async (req, res) => {
    const round = Number((req.query as { round?: string }).round ?? 1)
    ok(res, await nextPairwise(currentUser(req).id, round))
  }),
)

const pairwiseAnswerSchema = z.object({
  chosenJobId: z.string().uuid(),
  rejectedJobId: z.string().uuid(),
})

intakeRouter.post(
  '/pairwise',
  validate({ body: pairwiseAnswerSchema }),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof pairwiseAnswerSchema>
    await answerPairwise(currentUser(req).id, body.chosenJobId, body.rejectedJobId)
    ok(res, { recorded: true })
  }),
)

/** The persona itself, editable. Everything asked is visible and reversible. */
intakeRouter.get(
  '/persona',
  asyncHandler(async (req, res) => {
    const persona = await loadPersona(currentUser(req).id)
    ok(
      res,
      INTAKE_SLOTS.map((slot) => {
        const entry = persona.slots.get(slot.id)
        return {
          slotId: slot.id,
          prompt: slot.question.prompt,
          value: entry?.value ?? null,
          confidence: entry?.confidence ?? 0,
          source: entry?.source ?? 'default',
        }
      }),
    )
  }),
)
