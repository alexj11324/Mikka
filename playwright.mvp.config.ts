import { defineConfig, devices } from '@playwright/test'
import { assertMvpEnvironment, MVP_ORIGIN } from './tests/mvp/isolated-env.mjs'
import { assertMvpRunAllowed } from './tests/mvp/retention.mjs'

assertMvpRunAllowed()
assertMvpEnvironment()
export default defineConfig({
  testDir: './tests/mvp', testMatch: '**/*.spec.ts', fullyParallel: false,
  forbidOnly: true, retries: 0, workers: 1, timeout: 180_000,
  expect: { timeout: 30_000 },
  outputDir: 'mvp-test-results',
  captureGitInfo: { commit: true, diff: false },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-mvp-report' }]],
  // The MVP signs in with real synthetic credentials. Raw traces can retain
  // cookies and request bodies, so keep them out of all failure artifacts.
  use: { baseURL: MVP_ORIGIN, locale: 'zh-CN', trace: 'off', video: 'off', screenshot: 'only-on-failure', actionTimeout: 15_000, navigationTimeout: 45_000 },
  projects: [{ name: 'chromium-mvp', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 960 } } }],
  webServer: { command: 'node scripts/start-mvp-e2e.mjs', url: `${MVP_ORIGIN}/mikka/sign-in`, reuseExistingServer: false, timeout: 60_000 },
})
