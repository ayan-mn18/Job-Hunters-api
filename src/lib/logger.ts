import pino from 'pino'
import { env, isProduction } from '../config/env.js'

/**
 * Structured logs. JSON in production so a log shipper can index it; pretty in
 * development so a human can read it.
 *
 * The redaction list is not optional decoration — this process handles
 * passwords, JWTs and the Supabase service-role key.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'job-hunters-api', env: env.NODE_ENV },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.currentPassword',
      'req.body.newPassword',
      'req.body.refreshToken',
      'res.headers["set-cookie"]',
      'password',
      'passwordHash',
      'password_hash',
      'refreshToken',
      'accessToken',
      'tokenHash',
      'DATABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
    ],
    censor: '[redacted]',
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service,env' },
        },
      }),
})

export type Logger = typeof logger
