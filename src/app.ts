import cors from 'cors'
import express, { type Express } from 'express'
import helmet from 'helmet'
import { env, isProduction } from './config/env.js'
import { forbidden } from './lib/errors.js'
import { errorHandler, notFoundHandler } from './middleware/error.js'
import { globalLimiter } from './middleware/rateLimit.js'
import { httpLogger, requestId } from './middleware/requestId.js'
import { applicationsRouter } from './modules/applications/routes.js'
import { authRouter } from './modules/auth/routes.js'
import { dashboardRouter } from './modules/dashboard/routes.js'
import { healthRouter } from './modules/health/routes.js'
import { huntRouter } from './modules/hunt/routes.js'
import { meRouter } from './modules/me/routes.js'
import { portalsRouter } from './modules/portals/routes.js'
import { referralsRouter } from './modules/referrals/routes.js'
import { resumesRouter } from './modules/resumes/routes.js'

export function createApp(): Express {
  const app = express()

  // Behind a proxy (Railway, Fly, Render, nginx) `req.ip` is otherwise the
  // proxy's address, which would make the rate limiter treat every user as
  // one client. Only trusted in production — enabling it locally would let
  // anyone spoof `X-Forwarded-For` and dodge the limiter.
  if (isProduction) app.set('trust proxy', 1)
  app.disable('x-powered-by')

  app.use(requestId)
  app.use(httpLogger)

  app.use(
    helmet({
      // This process serves JSON to a separate-origin SPA and never renders
      // HTML, so CSP has nothing to protect here and COEP would only break
      // cross-origin fetches.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  )

  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header: curl, health checks, server-to-server. Allowed —
        // CORS is a browser protection and there is no browser here.
        if (!origin) return callback(null, true)
        if (env.CORS_ORIGINS.includes(origin)) return callback(null, true)
        // A plain Error here would surface as an opaque 500. A disallowed
        // origin is a configuration mistake, and saying so saves an hour.
        callback(
          forbidden(
            `Origin ${origin} is not allowed. Add it to CORS_ORIGINS if this is your frontend.`,
          ),
        )
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 86_400,
    }),
  )

  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: true, limit: '1mb' }))

  app.use(healthRouter)
  app.use(globalLimiter)

  app.get('/', (_req, res) => {
    res.json({
      name: 'job-hunters-api',
      version: '0.1.0',
      docs: 'See README.md for the endpoint list.',
      health: '/healthz',
      ready: '/readyz',
    })
  })

  app.use('/auth', authRouter)
  app.use('/me', meRouter)
  app.use('/resumes', resumesRouter)
  app.use('/portals', portalsRouter)
  app.use('/hunt', huntRouter)
  app.use('/applications', applicationsRouter)
  app.use('/referrals', referralsRouter)
  app.use('/dashboard', dashboardRouter)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
