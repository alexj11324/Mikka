import { test as pooledTest, expect } from '../e2e/test-account-fixtures'
import { retainMvpAccountLease } from './account-retention.mjs'
import { SYNTHETIC_PNG } from '../helpers/browser-image'

export const GITHUB_FAVICON = 'https://github.com/favicon.ico'

// Reuse the registered account pool, real sign-up/sign-in, lease heartbeat,
// origin fence and runtime assertions. No credentials or sessions are seeded.
export const test = pooledTest.extend<{ retainedAccountLease: void }>({
  // The actual origin fence fulfills this exact static image at both layers;
  // it never releases a request to GitHub, even if CDP intercepts first.
  localImageFixtures: [[{ url: GITHUB_FAVICON, body: SYNTHETIC_PNG }], { scope: 'test' }],
  retainedAccountLease: [async ({ testAccounts }, use, testInfo) => {
    try { await use() }
    finally {
      const retained = await retainMvpAccountLease(testAccounts)
      await testInfo.attach('mvp-account-retention', { body: JSON.stringify(retained), contentType: 'application/json' })
    }
  }, { auto: true }],
})

export { expect }
