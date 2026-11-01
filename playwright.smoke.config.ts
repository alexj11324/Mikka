import { defineConfig, devices } from '@playwright/test'

// Production smoke (docs/production-smoke.md): signs in a tagged smoke account on a
// deployed origin and reads; it starts no server and writes nothing.
export default defineConfig({
  testDir: './tests/smoke',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 1,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 20000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-smoke' }]],
  use: {
    // A container's own Chromium when Playwright's bundled one is not installed (scripts/dev/bootstrap-local.sh).
    ...(process.env.MIKKA_CHROMIUM_EXECUTABLE_PATH ? { launchOptions: { executablePath: process.env.MIKKA_CHROMIUM_EXECUTABLE_PATH } } : {}),
    baseURL: process.env.SMOKE_BASE_URL ?? 'https://app.aspectlylabs.com',
    locale: 'en-US',
    // Traces would carry the session cookie; screenshots of the smoke account are enough.
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
    actionTimeout: 15000,
    navigationTimeout: 45000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
