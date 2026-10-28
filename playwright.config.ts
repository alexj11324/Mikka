import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 15000 },
  // Keep commit provenance without copying fixture credentials from a PR diff
  // into the HTML report's embedded metadata.
  captureGitInfo: { commit: true, diff: false },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3100',
    locale: 'zh-CN',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15000,
    navigationTimeout: 45000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'pnpm exec next start --port 3100',
    url: 'http://localhost:3100/mikka/sign-in',
    reuseExistingServer: false,
    timeout: 60000,
  },
})
