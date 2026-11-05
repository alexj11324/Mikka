import assert from 'node:assert/strict'
import test from 'node:test'
import { auditCodedLiterals, auditDroppedCauses, auditErrorCopy, auditRepository, droppedCauseAllowlist, errorCauseMessage, findDroppedCauses, parseRegistry, readRegistry, staleAllowlistEntries } from './error-cause-policy.mjs'

const dropped = source => findDroppedCauses('lib/example.ts', source).map(d => d.line)

test('the repository passes: copy for every registered code, no new dropped cause', () => {
  assert.deepEqual(auditRepository().map(d => `${d.file}:${d.line} ${d.rule} ${d.message.slice(0, 80)}`), [])
})

test('the allowlist has no stale entries: a fixed drop leaves the list', () => {
  assert.deepEqual(staleAllowlistEntries(), [])
  for (const [file, hits] of Object.entries(droppedCauseAllowlist)) assert.ok(Number.isInteger(hits) && hits > 0, file)
})

test('the registry is read from its source, with each code\'s details', () => {
  const registry = readRegistry()
  assert.ok(registry.subscription_local_runtime_unavailable.includes('lease_refused'))
  assert.ok(registry.subscription_local_runtime_unavailable.includes('model_mismatch'))
  assert.ok(registry.subscription_hosted_runtime_unavailable.includes('runner_missing'))
  assert.deepEqual(parseRegistry('export const USER_ERROR_CODES = {\n  a_code: ["one", "two"],\n  other: [],\n} as const'), { a_code: ['one', 'two'], other: [] })
})

test('a registered code or detail without copy in either catalogue fails, and so does copy for nothing', () => {
  const registry = { run_failed: ['lease_refused'] }
  const full = { RunErrors: { run_failed: { default: '运行失败', lease_refused: '授权被拒绝' } } }
  assert.deepEqual(auditErrorCopy(registry, { 'zh.json': full, 'en.json': full }), [])
  const missing = auditErrorCopy(registry, { 'zh.json': full, 'en.json': { RunErrors: { run_failed: { default: 'Run failed' } } } })
  assert.equal(missing.length, 1)
  assert.match(missing[0].message, /RunErrors\.run_failed\.lease_refused/)
  assert.equal(missing[0].file, 'en.json')
  assert.equal(auditErrorCopy(registry, { 'zh.json': {}, 'en.json': full }).length, 2)
  const extra = auditErrorCopy(registry, { 'zh.json': { RunErrors: { ...full.RunErrors, run_failed: { ...full.RunErrors.run_failed, gone: 'x' }, unknown_code: { default: 'x' } } } })
  assert.equal(extra.length, 2)
})

test('a literal coded error names a registered detail', () => {
  const registry = { run_failed: ['lease_refused'] }
  assert.deepEqual(auditCodedLiterals('a.ts', 'throw new CodedError("run_failed", { detail: "lease_refused", cause })', registry), [])
  assert.equal(auditCodedLiterals('a.ts', 'throw new CodedError("run_failed", { detail: "lease_gone" })', registry).length, 1)
  // An internal code is not in the registry; its details are its own.
  assert.deepEqual(auditCodedLiterals('a.ts', "new CodedError('subscription_access_unavailable', { detail: 'fetch_failed' })", registry), [])
})

for (const [name, source, lines] of [
  ['a fixed error with no binding', 'try { x() } catch { throw new Error("subscription_local_runtime_unavailable") }', [1]],
  ['a fixed error that ignores the binding', 'try { x() } catch (error) {\n  throw new Error("failed")\n}', [2]],
  ['a coded error without a cause', 'try { x() } catch (e) { throw new CodedError("x", { detail: "y" }) }', [1]],
  ['a factory call without the error', 'try { x() } catch (error) { throw unavailable("lease_refused") }', [1]],
  ['a throw in a nested catch that ignores its own error', 'try { a() } catch (error) {\n  try { b() } catch (other) { throw wrap("x", error) }\n}', [2]],
]) test(`flags ${name}`, () => assert.deepEqual(dropped(source), lines))

for (const [name, source] of [
  ['{ cause: error }', 'try { x() } catch (error) { throw new Error("failed", { cause: error }) }'],
  ['a coded error with its cause', 'try { x() } catch (error) { throw new CodedError("x", { detail: "y", cause: error }) }'],
  ['the error passed to a helper', 'try { x() } catch (error) { throw unavailable("lease_refused", error) }'],
  ['a rethrow', 'try { x() } catch (error) { log(error); throw error }'],
  ['a multi-line call with the cause on a later line', 'try { x() } catch (error) {\n  throw new Error(\n    "failed",\n    { cause: error },\n  )\n}'],
  ['a nested catch that hands on its own error', 'try { a() } catch (error) {\n  try { b() } catch (cleanup) { throw unavailable("cleanup_failed", new AggregateError([cleanup])) }\n  throw error\n}'],
  ['a deliberate drop with its reason', 'try { x() } catch {\n  // error-cause: the parse error quotes a body that may hold a secret\n  throw refused("body_invalid")\n}'],
  ['a throw outside any catch', 'if (!ok) throw new Error("failed")'],
]) test(`accepts ${name}`, () => assert.deepEqual(dropped(source), []))

test('an empty reason does not opt out', () => {
  assert.deepEqual(dropped('try { x() } catch {\n  // error-cause:\n  throw new Error("x")\n}'), [3])
})

test('an allowlisted file may keep its drops but not add one', () => {
  const one = 'try { x() } catch { throw new Error("a") }'
  const allowlist = { 'lib/example.ts': 1 }
  assert.deepEqual(auditDroppedCauses('lib/example.ts', one, allowlist), [])
  assert.equal(auditDroppedCauses('lib/example.ts', `${one}\n${one}`, allowlist).length, 2)
  assert.equal(auditDroppedCauses('lib/other.ts', one, allowlist)[0].message, errorCauseMessage)
})

test('the message names the fix and the decision', () => {
  assert.match(errorCauseMessage, /cause: error/)
  assert.match(errorCauseMessage, /detail/)
  assert.match(errorCauseMessage, /messages\/\*\.json/)
  assert.match(errorCauseMessage, /2026-11-05-0330-error-causes\.md/)
})
