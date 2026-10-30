import { describe, expect, it } from 'vitest'
import { hostedCiResumePermitted, matchesNativeContinuation, type NativeSessionScope } from '../src/subscription-continuation'

const origin = '00000000-0000-4000-8000-000000000001'
const child = '00000000-0000-4000-8000-000000000002'
const scope: NativeSessionScope = { runId: child, bindingId: 'binding', ownerId: 'owner', workspaceId: 'workspace', consumerId: 'agent', route: 'codex_cli', revision: 4, accountId: 'account', modelId: 'model' }
const prior = { scope: { ...scope, runId: origin }, sessionId: 'original-session' }
const continuation = { runId: origin, sessionId: 'original-session' }
describe('hosted original-session ledger', () => {
  it('does not allow Factory question continuations through the CI-only hosted path', () => {
    expect(hostedCiResumePermitted({ requireSessionResume: true })).toBe(false)
    expect(hostedCiResumePermitted({ requireSessionResume: true, ciSessionResume: true })).toBe(true)
  })
  it('accepts only the original recorded session for the same account binding', () => {
    expect(matchesNativeContinuation(prior, scope, continuation)).toBe(true)
    for (const key of ['bindingId','ownerId','workspaceId','consumerId','route','revision','accountId','modelId'] as const) {
      expect(matchesNativeContinuation({ ...prior, scope: { ...prior.scope, [key]: 'different' } }, scope, continuation)).toBe(false)
    }
    for (const invalid of [null, {}, { ...prior, sessionId: 'different' }, { ...prior, scope: { ...prior.scope, runId: child } }]) expect(matchesNativeContinuation(invalid, scope, continuation)).toBe(false)
    expect(matchesNativeContinuation(prior, scope, { ...continuation, runId: '../outside' })).toBe(false)
  })
})
