import nodemailer, { type Transporter } from 'nodemailer'
import { env, hasMailer } from '../config/env.js'
import { logger } from './logger.js'

/**
 * Sending mail.
 *
 * The product reads the user's Gmail; it does not send from it, and it should
 * not — `gmail.send` is a second restricted scope and a second consent screen,
 * bought for the sake of one confirmation message. This sends *to* the address
 * they connected instead, over ordinary SMTP, which works with a Gmail app
 * password, SES, Postmark or anything else.
 *
 * Without SMTP configured this logs and reports failure rather than throwing.
 * A confirmation that could not be sent must not undo an application that was:
 * the application is the thing that mattered, and it already happened.
 */

let transport: Transporter | undefined

function transporter(): Transporter {
  transport ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // 465 is implicit TLS; everything else starts plaintext and upgrades.
    secure: env.SMTP_PORT === 465,
    ...(env.SMTP_USER
      ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } }
      : {}),
  })
  return transport
}

export interface Mail {
  to: string
  subject: string
  text: string
  html?: string
}

export async function sendMail(mail: Mail): Promise<{ sent: boolean; error?: string }> {
  if (!hasMailer) {
    logger.info({ to: mail.to, subject: mail.subject }, 'mail not sent — SMTP is not configured')
    return { sent: false, error: 'SMTP is not configured.' }
  }

  try {
    await transporter().sendMail({
      from: env.MAIL_FROM,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
    })
    logger.info({ to: mail.to, subject: mail.subject }, 'mail sent')
    return { sent: true }
  } catch (error) {
    logger.error({ err: error, to: mail.to }, 'could not send mail')
    return { sent: false, error: error instanceof Error ? error.message : String(error) }
  }
}
