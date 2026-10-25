// Isolated acceptance process only; production application never imports this.
if (process.env.QUOTA_TEST_COMPILER_PRELOAD) await import(process.env.QUOTA_TEST_COMPILER_PRELOAD)
await import('./quota-network-guard.mjs')
