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

  it.each(['name', 'code', 'detail', 'cause', 'constructor'])('contains a throwing %s getter without exposing its exception', field => {
    const error = Object.defineProperty(Object.create(null), field, {
      get() { throw new Error('PRIVATE_PROVIDER_OUTPUT sk-private') },
    })
    expect(safeErrorAttributes(error)).toEqual({ 'error.type': 'unknown' })
  })

  it('contains hostile nested and aggregate causes without exporting partial diagnostics', () => {
    const hostile = Object.defineProperty(new Error('PRIVATE_PROVIDER_OUTPUT'), 'name', {
      get() { throw new Error('PRIVATE_DIAGNOSTIC_ERROR') },
    })
    const aggregate = Object.defineProperty(new AggregateError([]), 'errors', {
      get() { throw new Error('PRIVATE_AGGREGATE_ERROR') },
    })
    for (const cause of [hostile, aggregate]) {
      expect(safeErrorAttributes(new CodedError('subscription_local_runtime_unavailable', { cause })))
        .toEqual({ 'error.type': 'unknown' })
    }
  })
})
