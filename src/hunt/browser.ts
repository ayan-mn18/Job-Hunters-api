import { chromium, type Browser, type BrowserContext } from 'playwright-core'
import { env } from '../config/env.js'
import { serviceUnavailable } from '../lib/errors.js'
import { logger } from '../lib/logger.js'

/**
 * Browser launch.
 *
 * `playwright-core` ships no browser of its own, so something has to say where
 * Chromium is. This used to default to `/Applications/Google Chrome.app` —
 * correct on one Mac and wrong everywhere else, including in a container.
 *
 * In the runner image `CHROMIUM_EXECUTABLE_PATH` is set explicitly and the
 * driver and browser versions are pinned together. Locally, the macOS Chrome
 * path is still accepted as a fallback so a laptop keeps working, but it is a
 * fallback that announces itself rather than a silent default.
 */

const MACOS_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/**
 * Flags that make Chromium survive a container. `--no-sandbox` is required
 * because the process runs unprivileged with no user namespaces; `--dev-shm-usage`
 * because the default 64 MB /dev/shm makes Chromium crash on heavy pages.
 */
const CONTAINER_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']

let warnedAboutFallback = false

/**
 * Where Chromium is, or `undefined` to let Playwright resolve it.
 *
 * Undefined is the right answer inside the runner image: the base image
 * installs a matching Chromium under `PLAYWRIGHT_BROWSERS_PATH` and
 * playwright-core finds it. Hardcoding that path would pin a build number that
 * changes with every Playwright bump, and fail with an unhelpful protocol
 * error when it drifts.
 */
export function automationExecutablePath(options: { requireAutomation?: boolean } = {}): string | undefined {
  if (options.requireAutomation !== false && !env.PORTAL_AUTOMATION_ENABLED) {
    throw serviceUnavailable('Portal automation is disabled. Set PORTAL_AUTOMATION_ENABLED=true.')
  }
  if (env.CHROMIUM_EXECUTABLE_PATH) return env.CHROMIUM_EXECUTABLE_PATH
  if (env.BROWSER_IN_CONTAINER) return undefined

  if (process.platform === 'darwin') {
    if (!warnedAboutFallback) {
      warnedAboutFallback = true
      logger.warn(
        { path: MACOS_CHROME },
        'CHROMIUM_EXECUTABLE_PATH is not set — falling back to the local Chrome install. Set it explicitly outside development.',
      )
    }
    return MACOS_CHROME
  }

  throw serviceUnavailable(
    'CHROMIUM_EXECUTABLE_PATH is required for portal automation outside the runner image.',
  )
}

function launchArgs(): string[] {
  // A local Chrome on a developer's Mac neither needs nor wants the container
  // flags — --no-sandbox in particular is a real weakening, and there is no
  // reason to pay for it outside the container it exists for.
  return env.BROWSER_IN_CONTAINER ? CONTAINER_ARGS : []
}

/**
 * A browser the agent tier can also drive.
 *
 * Stagehand attaches over CDP rather than sharing Playwright's connection, so
 * the port has to be opened at launch. Passing one keeps a single browser for
 * both tiers, which is what lets the live view and takeover keep working while
 * an agent is the thing filling the form — a second, Stagehand-owned browser
 * would be invisible to both.
 */
async function launchHeadlessBrowser(options: { cdpPort?: number; requireAutomation: boolean }): Promise<Browser> {
  const executablePath = automationExecutablePath({ requireAutomation: options.requireAutomation })
  const debugArgs = options?.cdpPort
    ? [`--remote-debugging-port=${options.cdpPort}`, '--remote-allow-origins=*']
    : []
  return chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: [...launchArgs(), ...debugArgs],
  })
}

export function launchAutomationBrowser(options?: { cdpPort?: number }): Promise<Browser> {
  return launchHeadlessBrowser({ ...options, requireAutomation: true })
}

/** Renders local artifacts with the bundled browser without requiring portal automation. */
export function launchHeadlessArtifactBrowser(): Promise<Browser> {
  return launchHeadlessBrowser({ requireAutomation: false })
}

/** An ephemeral free port, so two concurrent applies never collide on CDP. */
export async function freePort(): Promise<number> {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

/**
 * A context the user is expected to interact with — signing in to LinkedIn,
 * clearing a challenge.
 *
 * `headless` is now configurable rather than hardcoded to `false`. A visible
 * window is right on a laptop and impossible on a server, and this was the
 * single hardest blocker to deploying the product: the LinkedIn connect flow
 * literally required a monitor attached to the machine running the API.
 *
 * Headless is the default. Until the live-view work lands, connecting an
 * account in a deployed environment needs `AUTOMATION_HEADFUL=true` on a host
 * with a display; locally that is what you already have.
 */
export async function launchInteractiveAutomationContext(
  userDataDir: string,
): Promise<BrowserContext> {
  const executablePath = automationExecutablePath()
  return chromium.launchPersistentContext(userDataDir, {
    ...(executablePath ? { executablePath } : {}),
    headless: !env.AUTOMATION_HEADFUL,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', ...launchArgs()],
  })
}
