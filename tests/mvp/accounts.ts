import { test as pooledTest, expect } from '../e2e/test-account-fixtures'
import { retainMvpAccountLease } from './account-retention.mjs'

// Reuse the registered account pool, real sign-up/sign-in, lease heartbeat,
// origin fence and runtime assertions. No credentials or sessions are seeded.
export const test = pooledTest.extend<{ retainedAccountLease: void }>({
  retainedAccountLease: [async ({ testAccounts }, use, testInfo) => {
    try { await use() }
    finally {
      const retained = await retainMvpAccountLease(testAccounts)
      await testInfo.attach('mvp-account-retention', { body: JSON.stringify(retained), contentType: 'application/json' })
    }
  }, { auto: true }],
})

export { expect }
