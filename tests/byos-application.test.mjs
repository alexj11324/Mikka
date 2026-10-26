// REQUIRE_DB: original runtime/native/browser disposal assertions remain in the shared harness.
import { registerByosApplication } from './byos-application-harness.mjs'
export function registerPendingByosApplication() { registerByosApplication('disposal') }
throw new Error('Pending scoped approval: BYOS runtime SQL cleanup, native PID files and browser disposal')
