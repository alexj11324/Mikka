// Actual credential browser client against the isolated local gateway fixture.
import assert from 'node:assert/strict'
import { Cdp } from '../../lib/credentials/browser.ts'

const [endpoint, target, origin] = process.argv.slice(2)
const cdp = await Cdp.connect(endpoint)
try {
  await cdp.attach(target)
  await cdp.fill(origin, 'synthetic-user', 'synthetic-password')
  await cdp.fillOtp(origin, '123456')
  assert.equal(await cdp.safeToResume(`${origin}/login`), false)
  process.stdout.write('PASS: actual broker client login and OTP templates reached isolated Chromium; populated inputs stayed guarded')
} finally { cdp.close() }
