// REQUIRE_DB: pending physical assertions remain in the shared harness.
import { registerByosEnrollmentBinding } from './byos-enrollment-binding-harness.mjs'
if (process.env.BYOS_FULL_DISPOSAL_AUTHORIZED !== '1' || process.env.RETAIN_SYNTHETIC_RECORDS !== '1')
  throw new Error('Pending scoped approval: BYOS canonical cleanup and disconnect physical SQL deletion')
if (process.env.MIKKA_BYOS_BACKEND_ONLY === '1') throw new Error('Full BYOS disposal acceptance cannot omit browser assertions')
registerByosEnrollmentBinding('disposal')
