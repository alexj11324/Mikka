import { createHash, randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { WORKSPACE_REQUEST_HEADER, type WorkspaceReadReceipt } from '@mikka/protocol/coding-workspace'
import { ServerUnreachableError } from '../src/errors'
import { HttpServerLink, SessionRejectedError } from '../src/server-link-http'

const deviceId = randomUUID()
const requestId = randomUUID()
const contents = Buffer.from('fixture source\n')
const receipt: WorkspaceReadReceipt = {
  result: {
    ok: true, kind: 'file', path: 'src/main.ts',
    identity: { version: 1, runId: randomUUID(), repoId: randomUUID(), deviceId, workspaceId: randomUUID(),
      ownerId: 'fixture-owner', repositoryKey: 'github.com/mikka-fixtures/transport', bindingId: 'a'.repeat(64) },
    revision: { source: 'working', headSha: 'b'.repeat(40), baseSha: null, version: 'c'.repeat(64) },
    observedAt: new Date().toISOString(), availability: 'online', size: contents.length, language: 'ts',
    format: 'text', content: contents.toString('utf8'), contentSha256: createHash('sha256').update(contents).digest('hex'),
    startLine: 1, endLine: 2, totalLines: 2, truncated: false, editable: false,
  },
  files: [{ path: 'src/main.ts', base64: contents.toString('base64') }],
}

type Call = { method: string; path: string; headers: Headers; body: unknown; signal: AbortSignal | null | undefined }

/** Scripted HTTP transport only: no claim that this is an end-to-end server. */
async function transport(respond: (call: Call, attempt: number) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/register')) return Response.json({ deviceId, workspaceId: randomUUID() }, { status: 201 })
    const call: Call = {
      method: init?.method ?? 'GET', path: url.pathname + url.search, headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined, signal: init?.signal,
    }
    calls.push(call)
    return respond(call, calls.length)
  }) as typeof fetch
  const link = new HttpServerLink('https://workspace-transport.invalid', fetcher)
  await link.registerDevice('fixture-device-credential', {
    name: 'workspace-transport-fixture', platform: 'linux', arch: 'x64',
    daemonVersion: '1.0.0', protocolVersion: 1, harnesses: [],
  })
  return { link, calls }
}

const deadline = () => new Date(Date.now() + 15_000).toISOString()

afterEach(() => { vi.restoreAllMocks() })

describe('workspace receipt HTTP delivery', () => {
  it('recovers from one 503 with the same request, device credential and private receipt', async () => {
    const { link, calls } = await transport((_call, attempt) => new Response(null, { status: attempt === 1 ? 503 : 204 }))
    await expect(link.answerWorkspaceRead(deviceId, requestId, receipt, { expiresAt: deadline() })).resolves.toBeUndefined()
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call).toMatchObject({ method: 'POST', path: `/v1/devices/${deviceId}/workspace/requests/${requestId}`, body: receipt })
      expect(call.headers.get('authorization')).toBe('Bearer fixture-device-credential')
      expect(call.headers.get(WORKSPACE_REQUEST_HEADER)).toBe('1')
      expect(call.signal).toBeInstanceOf(AbortSignal)
    }
  })

  it('retries a transient network rejection without changing the receipt', async () => {
    const { link, calls } = await transport((_call, attempt) => {
      if (attempt === 1) throw new TypeError('synthetic transport interruption')
      return new Response(null, { status: 204 })
    })
    await link.answerWorkspaceRead(deviceId, requestId, receipt, { expiresAt: deadline() })
    expect(calls).toHaveLength(2)
    expect(calls.map(call => call.body)).toEqual([receipt, receipt])
  })

  it('stops after exactly three failed attempts', async () => {
    const { link, calls } = await transport(() => new Response(null, { status: 503 }))
    await expect(link.answerWorkspaceRead(deviceId, requestId, receipt, { expiresAt: deadline() }))
      .rejects.toBeInstanceOf(ServerUnreachableError)
    expect(calls).toHaveLength(3)
  })

  it('does not retry a 429 backpressure response', async () => {
    const { link, calls } = await transport(() => new Response(null, { status: 429 }))
    await expect(link.answerWorkspaceRead(deviceId, requestId, receipt, { expiresAt: deadline() }))
      .rejects.toMatchObject({ cause: 429 })
    expect(calls).toHaveLength(1)
  })

  it('does not retry a 409 stale or already-consumed receipt', async () => {
    const { link, calls } = await transport(() => new Response(null, { status: 409 }))
    await expect(link.answerWorkspaceRead(deviceId, requestId, receipt, { expiresAt: deadline() }))
      .rejects.toMatchObject({ code: 409 })
    expect(calls).toHaveLength(1)
  })

  it('does not retry the exact device-session rejection envelope', async () => {
    const { link, calls } = await transport(() => Response.json({ error: 'Unauthorized' }, { status: 401 }))
    await expect(link.answerWorkspaceRead(deviceId, requestId, receipt, { expiresAt: deadline() }))
      .rejects.toBeInstanceOf(SessionRejectedError)
    expect(calls).toHaveLength(1)
  })

  it('does not send an already-expired receipt', async () => {
    const { link, calls } = await transport(() => { throw new Error('Expired receipt must not reach fetch') })
    await expect(link.answerWorkspaceRead(deviceId, requestId, receipt, { expiresAt: new Date(Date.now() - 1).toISOString() }))
      .rejects.toBeInstanceOf(ServerUnreachableError)
    expect(calls).toHaveLength(0)
  })

  it('does not send after the caller has aborted', async () => {
    const { link, calls } = await transport(() => { throw new Error('Aborted receipt must not reach fetch') })
    const controller = new AbortController(), reason = new Error('synthetic daemon shutdown')
    controller.abort(reason)
    await expect(link.answerWorkspaceRead(deviceId, requestId, receipt, { expiresAt: deadline(), signal: controller.signal })).rejects.toBe(reason)
    expect(calls).toHaveLength(0)
  })

  it('rechecks expiry before a retry and never starts a second HTTP request after the deadline', async () => {
    const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const { link, calls } = await transport(() => {
      clock.mockReturnValue(now + 1001)
      return new Response(null, { status: 503 })
    })
    await expect(link.answerWorkspaceRead(deviceId, requestId, receipt, { expiresAt: new Date(now + 1000).toISOString() }))
      .rejects.toBeInstanceOf(ServerUnreachableError)
    expect(calls).toHaveLength(1)
  })

  it('rechecks abort before a retry', async () => {
    const controller = new AbortController(), reason = new Error('synthetic daemon shutdown during delivery')
    const { link, calls } = await transport(() => {
      controller.abort(reason)
      return new Response(null, { status: 503 })
    })
    await expect(link.answerWorkspaceRead(deviceId, requestId, receipt, { expiresAt: deadline(), signal: controller.signal })).rejects.toBe(reason)
    expect(calls).toHaveLength(1)
  })

  it('caps each attempt by the remaining deadline', async () => {
    const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const { link, calls } = await transport((_call, attempt) => {
      if (attempt === 1) clock.mockReturnValue(now + 800)
      return new Response(null, { status: attempt === 1 ? 503 : 204 })
    })
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    await link.answerWorkspaceRead(deviceId, requestId, receipt, { expiresAt: new Date(now + 1000).toISOString() })
    expect(calls).toHaveLength(2)
    expect(timeout.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([1000, 200])
  })
})
