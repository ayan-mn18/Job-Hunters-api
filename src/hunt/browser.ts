import { chromium, type Browser } from 'playwright-core'
import { env } from '../config/env.js'
import { serviceUnavailable } from '../lib/errors.js'

export async function launchAutomationBrowser(): Promise<Browser> {
  if (!env.PORTAL_AUTOMATION_ENABLED) {
    throw serviceUnavailable('Portal automation is disabled. Set PORTAL_AUTOMATION_ENABLED=true.')
  }
  const executablePath = env.CHROMIUM_EXECUTABLE_PATH
    ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined)
  if (!executablePath) {
    throw serviceUnavailable('CHROMIUM_EXECUTABLE_PATH is required for portal automation.')
  }
  return chromium.launch({ executablePath, headless: true })
}
