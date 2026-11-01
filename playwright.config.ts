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
    // A container's own Chromium when Playwright's bundled one is not installed (scripts/dev/bootstrap-local.sh).
    ...(process.env.MIKKA_CHROMIUM_EXECUTABLE_PATH ? { launchOptions: { executablePath: process.env.MIKKA_CHROMIUM_EXECUTABLE_PATH } } : {}),
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3100',
    locale: 'zh-CN',
    // Authenticated traces include cookies/form network bodies. The evidence
    // scanner intentionally forbids them; keep screenshots and error contexts.
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
    actionTimeout: 15000,
    navigationTimeout: 45000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'pnpm exec next start --port 3100',
    url: 'http://localhost:3100/mikka/sign-in',
    reuseExistingServer: false,
    // Opt-in harness for the credential login card (mocked API, no vault), and
    // loopback custom model providers for 「API 与订阅」 (lib/model-api-keys.ts).
    env: { MIKKA_CREDENTIAL_HARNESS: '1', MIKKA_MODEL_KEY_LOOPBACK: '1' },
    timeout: 60000,
  },
})
