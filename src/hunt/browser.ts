import { chromium, type Browser, type BrowserContext } from 'playwright-core'
import { env } from '../config/env.js'
import { serviceUnavailable } from '../lib/errors.js'

function automationExecutablePath(): string {
  if (!env.PORTAL_AUTOMATION_ENABLED) {
    throw serviceUnavailable('Portal automation is disabled. Set PORTAL_AUTOMATION_ENABLED=true.')
  }
  const executablePath =
    env.CHROMIUM_EXECUTABLE_PATH ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined)
  if (!executablePath) {
    throw serviceUnavailable('CHROMIUM_EXECUTABLE_PATH is required for portal automation.')
  }
  return executablePath
}

export async function launchAutomationBrowser(): Promise<Browser> {
  return chromium.launch({ executablePath: automationExecutablePath(), headless: true })
}

export async function launchInteractiveAutomationContext(
  userDataDir: string,
): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, {
    executablePath: automationExecutablePath(),
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  })
}
