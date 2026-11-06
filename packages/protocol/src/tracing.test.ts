import { describe, expect, it } from 'vitest'
import { CodedError } from './coded-error'
import { safeErrorAttributes } from './tracing'

describe('safeErrorAttributes', () => {
  it('names the code and detail from the cause chain, never the message', () => {
    const cause = Object.assign(new Error('token sk-private at /Users/alex/x'), { code: 'ECONNREFUSED' })
    const error = new CodedError('subscription_local_runtime_unavailable', { detail: 'cli_missing', cause })
    expect(safeErrorAttributes(error)).toEqual({
      'error.type': 'CodedError',
      'mikka.error.code': 'subscription_local_runtime_unavailable',
      'mikka.error.detail': 'cli_missing',
      'mikka.error.causes': 'CodedError:subscription_local_runtime_unavailable:cli_missing > Error:ECONNREFUSED',
    })
    expect(JSON.stringify(safeErrorAttributes(cause))).not.toContain('private')
  })

  it('drops codes that are not identifiers', () => {
    expect(safeErrorAttributes(Object.assign(new TypeError('x'), { code: 'alice@example.com' }))).toEqual({ 'error.type': 'TypeError' })
    expect(safeErrorAttributes('plain string')).toEqual({ 'error.type': 'string' })
    expect(safeErrorAttributes(undefined)).toEqual({ 'error.type': 'unknown' })
  })
})
