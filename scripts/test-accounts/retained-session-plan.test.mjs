// Static assertions only. This source has not been run and is not runtime proof.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('candidate revocation retains rows and scopes update to the tracked lease session', () => {
  const source = readFileSync(new URL('./retained-session-plan.mjs', import.meta.url), 'utf8')
  assert.match(source, /UPDATE public\.session AS s/)
  assert.match(source, /SET token = \$4/)
  assert.match(source, /"expiresAt" = clock_timestamp\(\) - interval '1 second'/)
  assert.match(source, /s\.id = \$1 AND s\."userId" = \$2/)
  assert.match(source, /r\.lease_id = \$3 AND r\.type = 'session' AND r\.id = s\.id/)
  assert.match(source, /r\.owner_id = s\."userId" AND r\.state = 'created'/)
  assert.match(source, /l\.generation = \$5 AND p\.active_lease_id = l\.id/)
  assert.match(source, /p\.state = 'leased' AND p\.generation = l\.generation/)
  assert.match(source, /bytes\.fill\(0\)/)
  assert.match(source, /result\?\.rowCount !== 1/)
  assert.doesNotMatch(source, /\b(?:DELETE|DROP|TRUNCATE)\b/i)
})
