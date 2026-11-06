import { describe, expect, it } from 'vitest'
import { appVersion, mobileTraceFetch, mobileTraceHeaders, newTraceparent, validTraceparent, sanitizeTraceContext, runTraceHeaders, traceContextFromHeaders } from './trace-context'

describe('durable run trace context', () => {
  it('round trips only a bounded W3C carrier and safe opaque identifiers', () => {
    const traceparent = newTraceparent()
    const input = { traceparent, runId: 'run_1512', taskId: 'task_1512', threadId: 'thread_1512', posthogDistinctId: 'opaque_user', sessionId: 'session_1512', prompt: 'private', authorization: 'Bearer private' }
    const clean = sanitizeTraceContext(input)!
    expect(clean).toEqual({ traceparent, runId: 'run_1512', taskId: 'task_1512', threadId: 'thread_1512', posthogDistinctId: 'opaque_user', sessionId: 'session_1512' })
    const headers = new Headers(runTraceHeaders(clean))
    expect(traceContextFromHeaders(name => headers.get(name))).toEqual(clean)
    expect(JSON.stringify(clean)).not.toContain('private')
  })

  it('ignores malformed telemetry without invalidating the run envelope', () => {
    expect(sanitizeTraceContext({ traceparent: 'invalid', runId: 'valid_id' })).toBeUndefined()
    const traceparent = newTraceparent()
    expect(sanitizeTraceContext({ traceparent, runId: 'sk-private', taskId: 'private@example.com', sessionId: 'x'.repeat(129) })).toEqual({ traceparent })
  })
})

describe('mobile trace context', () => {
  it('creates valid, fresh W3C IDs without marking an unrecorded client span sampled', () => {
    const first = newTraceparent(), second = newTraceparent()
    expect(validTraceparent(first)).toBe(true)
    expect(first).not.toBe(second)
    expect(first.endsWith('-00')).toBe(true)
    expect(validTraceparent(newTraceparent(() => 0))).toBe(true)
  })

  it('keeps an existing valid context and replaces invalid or zero IDs', () => {
    const parent = newTraceparent()
    expect(mobileTraceHeaders('1.0.0', parent).traceparent).toBe(parent)
    for (const invalid of ['', '00-' + '0'.repeat(32) + '-1234567890abcdef-01', '00-1234567890abcdef1234567890abcdef-' + '0'.repeat(16) + '-00', parent + '-secret']) {
      expect(validTraceparent(invalid)).toBe(false)
      expect(validTraceparent(mobileTraceHeaders('1.0.0', invalid).traceparent)).toBe(true)
    }
  })

  it('only exports a bounded numeric app version', () => {
    expect(appVersion('1.23.456')).toBe('1.23.456')
    for (const value of ['alice@example.com', '/Users/alex/private', '1.0.0-token', '10000.0.0', null, 123]) {
      expect(appVersion(value)).toBeUndefined()
      expect(mobileTraceHeaders(value)['x-mikka-app-version']).toBeUndefined()
    }
  })

  it('preserves authentication, body, cancellation and traceparent on Mikka API requests only', async () => {
    const seen: { input: RequestInfo | URL; init?: RequestInit }[] = []
    const result = new Response('{}')
    const fetcher = mobileTraceFetch('https://mikka.test/mikka', '1.0.0', async (input, init) => { seen.push({ input, init }); return result })
    const parent = newTraceparent()
    const headers = new Headers({ cookie: 'session=private-cookie', traceparent: parent })
    const abort = new AbortController()
    const init = { method: 'POST', headers, body: '{"private":"prompt"}', signal: abort.signal, credentials: 'include' as const }
    expect(await fetcher('https://mikka.test/mikka/api/auth/sign-in/email', init)).toBe(result)
    const traced = new Headers(seen[0].init?.headers)
    expect(traced.get('traceparent')).toBe(parent)
    expect(traced.get('x-mikka-client-kind')).toBe('mobile')
    expect(traced.get('x-mikka-app-version')).toBe('1.0.0')
    expect(traced.get('cookie')).toBe('session=private-cookie')
    expect(seen[0].init?.body).toBe(init.body)
    expect(seen[0].init?.signal).toBe(abort.signal)
    expect(headers.has('x-mikka-client-kind')).toBe(false)
    for (const url of ['https://upload.test/file?token=private', 'https://mikka.test/other/api/file']) {
      await fetcher(url, init)
      expect(seen.at(-1)?.init).toBe(init)
    }
  })

  it('each independent request gets a different trace; existing Request headers survive', async () => {
    const seen: Headers[] = []
    const fetcher = mobileTraceFetch('https://mikka.test', '1.0.0', async (_input, init) => { seen.push(new Headers(init?.headers)); return new Response('{}') })
    await fetcher(new Request('https://mikka.test/api/issues', { headers: { authorization: 'Bearer private' } }))
    await fetcher('https://mikka.test/api/issues')
    expect(seen[0].get('authorization')).toBe('Bearer private')
    expect(seen[0].get('traceparent')).not.toBe(seen[1].get('traceparent'))
  })
})
