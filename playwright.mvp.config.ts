import { defineConfig, devices } from '@playwright/test'
import { assertMvpEnvironment, MVP_ORIGIN } from './tests/mvp/isolated-env.mjs'

assertMvpEnvironment()
export default defineConfig({
  testDir: './tests/mvp', testMatch: '**/*.spec.ts', fullyParallel: false,
  forbidOnly: true, retries: 0, workers: 1, timeout: 180_000,
  expect: { timeout: 30_000 },
  outputDir: 'mvp-test-results',
  captureGitInfo: { commit: true, diff: false },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-mvp-report' }]],
  use: { baseURL: MVP_ORIGIN, locale: 'zh-CN', trace: 'retain-on-failure', screenshot: 'only-on-failure', actionTimeout: 15_000, navigationTimeout: 45_000 },
  projects: [{ name: 'chromium-mvp', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 960 } } }],
  webServer: { command: 'node scripts/start-mvp-e2e.mjs', url: `${MVP_ORIGIN}/mikka/sign-in`, reuseExistingServer: false, timeout: 60_000 },
})
