import assert from 'node:assert/strict'
import test from 'node:test'
import { ActionFailureError, runAction } from './action-error'
import { ACTION_ERROR_CODES, type ActionErrorCode } from './action-result'
import type { createIssueForTeam, promoteIssueToTeam } from '../app/actions/issues'

const teamCodes = [
  'teamIssueInvalid', 'teamIssueAccessDenied', 'teamIssueRequestConflict',
  'teamIssueChanged', 'teamIssueRetry', 'teamIssueOutcomeUnknown',
] as const satisfies readonly ActionErrorCode[]

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T
type TeamCodes = typeof teamCodes[number] | 'authRequired'
type CreateFailure = Extract<Awaited<ReturnType<typeof createIssueForTeam>>, { error: string }>
type PromoteFailure = Extract<Awaited<ReturnType<typeof promoteIssueToTeam>>, { error: string }>
// Check the real exported actions, not a separately declared frontend model.
export type CreateCodesPreserved = Expect<Equal<Exclude<TeamCodes, CreateFailure['error']>, never>>
export type PromoteCodesPreserved = Expect<Equal<Exclude<TeamCodes, PromoteFailure['error']>, never>>
export type CreateRequestPreserved = Expect<Equal<CreateFailure['requestId'], string | undefined>>
export type PromoteRequestPreserved = Expect<Equal<PromoteFailure['requestId'], string | undefined>>

test('team errors and optional request IDs survive the action boundary', async () => {
  for (const error of teamCodes) {
    assert.ok(ACTION_ERROR_CODES.includes(error))
    for (const payload of [{ error }, { error, requestId: 'synthetic-operation-id' }]) {
      const result = await runAction(async () => payload)
      if (result.error) {
        const requestId: string | undefined = result.requestId
        assert.equal(requestId, 'requestId' in payload ? payload.requestId : undefined)
      }
      assert.deepEqual(result, payload)
    }
  }
})

test('expected authentication errors serialize and unknown failures keep propagating', async () => {
  assert.deepEqual(await runAction(async () => { throw new ActionFailureError('authRequired') }), { error: 'authRequired', params: undefined })
  const unexpected = new Error('synthetic internal detail')
  await assert.rejects(runAction(async () => { throw unexpected }), error => error === unexpected)
  const lookalike = { code: 'teamIssueRetry', requestId: 'synthetic-operation-id', detail: 'synthetic internal detail' }
  await assert.rejects(runAction(async () => { throw lookalike }), error => error === lookalike)
})
