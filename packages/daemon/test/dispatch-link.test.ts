import { expect, it, vi } from 'vitest'
import { HttpServerLink } from '../src/server-link-http'
import { ServerUnreachableError } from '../src/errors'
import { MAILBOX_NOTICE_HEADER } from '@mikka/protocol/device'

it('reports queued runs alongside commands and preserves skipped run ids', async () => {
  const queued = vi.fn()
  const link = new HttpServerLink('http://server.test', (async (url) => {
    expect(new URL(String(url)).searchParams.get('skip')).toBe('run-old')
    return Response.json({ commands: [], queuedRuns: ['run-new'] })
  }) as typeof fetch)
  expect(await link.fetchCommands('device-1', 25, { skipRuns: ['run-old'], onQueuedRuns: queued })).toEqual([])
  expect(queued).toHaveBeenCalledWith(['run-new'])
})

it('accepts command responses from older servers without queued runs', async () => {
  const queued = vi.fn()
  const link = new HttpServerLink('http://server.test', (async () => Response.json({ commands: [] })) as typeof fetch)
  expect(await link.fetchCommands('device-1', 25, { onQueuedRuns: queued })).toEqual([])
  expect(queued).not.toHaveBeenCalled()
})

it('advertises mailbox notices and accepts their address-only command', async () => {
  const command = { kind: 'mailbox_notice', runId: 'run-1', messageIds: ['10000000-0000-4000-8000-000000000001'] }
  const link = new HttpServerLink('http://server.test', (async (_url, init) => {
    expect(new Headers(init?.headers).get(MAILBOX_NOTICE_HEADER)).toBe('1')
    return Response.json({ commands: [command] })
  }) as typeof fetch)
  expect(await link.fetchCommands('device-1', 25)).toEqual([command])
})

it('cancels the claim transport when the daemon stops', async () => {
  const controller = new AbortController()
  let observed: AbortSignal | undefined
  const link = new HttpServerLink('http://server.test', (async (_url, init) => {
    observed = init?.signal ?? undefined
    return await new Promise<Response>((_resolve, reject) => {
      observed?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }) as typeof fetch)
  const claim = link.claimRun('device-1', 'run-1', controller.signal)
  const rejected = expect(claim).rejects.toBeInstanceOf(ServerUnreachableError)
  controller.abort()
  await rejected
  expect(observed?.aborted).toBe(true)
})
