// Compatibility entry: the core-loop item now uses the API/CLI owning harness.
process.env.LOCAL_LOOP_ITEMS ??= '1'
await import('./acceptance.mjs')
