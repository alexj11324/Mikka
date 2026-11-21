import 'server-only'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { TerminalError, terminalInputSchema, terminalResizeSchema, TERMINAL_INPUT_BYTES } from '@mikka/protocol/coding-terminal'
import { logCodedError } from '@mikka/protocol/coded-error'
import { taskReviewAuthority, withTaskReviewAuthority, ReviewAuthorityError, type TaskReviewAuthority, type ReviewAuthorityExpectation } from '../review-authority'
import { beginReviewSession, readReviewSession, closeReviewSession, revokeReviewSession } from '../review-sessions'
import { resumeReviewMachine } from '../review-machine'
import { prepareTerminal, existingTerminal, terminalRequest } from './runtime'
import { terminalGrant, type TerminalLease, type TerminalPrepared } from './wire'

const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }
type Dependencies = {
  authority: typeof taskReviewAuthority
  authorized: <T>(request: Request, taskId: string, work: (scope: TaskReviewAuthority, client: PoolClient) => Promise<T>, expected?: ReviewAuthorityExpectation) => Promise<T>
  begin: typeof beginReviewSession; read: typeof readReviewSession; close: typeof closeReviewSession; revoke: typeof revokeReviewSession
  resume: typeof resumeReviewMachine; prepare: typeof prepareTerminal; existing: typeof existingTerminal
  request: typeof terminalRequest; grant: typeof terminalGrant
}
const runtime: Dependencies = { authority: taskReviewAuthority, authorized: withTaskReviewAuthority,
  begin: beginReviewSession, read: readReviewSession, close: closeReviewSession, revoke: revokeReviewSession, resume: resumeReviewMachine,
  prepare: prepareTerminal, existing: existingTerminal, request: terminalRequest, grant: terminalGrant }

function origin(request: Request, stream = false) {
  const value = request.headers.get('origin')
  if (value && value !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site'
    || stream && (request.headers.get('sec-fetch-mode') === 'navigate' || !request.headers.get('accept')?.includes('text/event-stream')))
    throw new ReviewAuthorityError('review_scope_denied')
}

async function body(request: Request): Promise<unknown> {
  const reader = request.body?.getReader()
  if (!reader) throw new TerminalError('terminal_invalid_request')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const value = await reader.read()
      if (value.done) break
      size += value.value.byteLength
      if (size > 100_000) throw new TerminalError('terminal_input_too_large')
      chunks.push(value.value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch (cause) { throw new TerminalError('terminal_invalid_request', { cause }) }
  } finally { await reader.cancel(); reader.releaseLock() }
}

function failure(error: unknown) {
  if (error instanceof ReviewAuthorityError || error instanceof TerminalError) {
    return Response.json({ error: error.code, ...(error.detail ? { detail: error.detail } : {}) }, { status: error.status, headers: HEADERS })
  }
  const coded = new TerminalError('terminal_unavailable', { detail: 'runtime', cause: error })
  logCodedError(coded)
  return Response.json({ error: coded.code }, { status: coded.status, headers: HEADERS })
}

function expected(scope: TaskReviewAuthority) { return { runId: scope.runId, bindingId: scope.bindingId } }

/** Stream bytes pass through unchanged. Only an authenticated gateway's
 * ended frame closes the durable lease; a network failure keeps its bounded
 * lease, so the VM cannot park while uncertain PTY work is still alive. */
export function relayTerminal(response: Response, onEnded: () => Promise<void>, abort: AbortController) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = '', ended = false, cancelled = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const value = await reader.read()
        if (value.done) {
          if (ended) await onEnded()
          if (!cancelled) controller.close()
          reader.releaseLock()
          return
        }
        buffer = (buffer + decoder.decode(value.value, { stream: true })).slice(-2048)
        // Literal newlines in arbitrary shell output are JSON-escaped. They
        // cannot forge a protocol frame in this trusted private stream.
        if (/(?:^|\n)event: ended\r?\n/.test(buffer)) ended = true
        controller.enqueue(value.value)
      } catch {
        if (!cancelled) controller.close()
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    },
    async cancel() { cancelled = true; abort.abort(); await reader.cancel().catch(() => undefined); reader.releaseLock() },
  })
}

/** No polling, public host, sandbox selector, shell command logger or transcript. */
export function reviewTerminalHandlers(deps: Dependencies = runtime) {
  const stream = async (request: Request, taskId: string) => {
    let opened: { scope: TaskReviewAuthority; lease: TerminalLease } | undefined
    try {
      origin(request, true)
      const initial = await deps.authority(request, taskId)
      if (initial.machineKind !== 'cloud') throw new TerminalError('terminal_unsupported', { detail: 'local_device' })
      if (!initial.nativeExitedProof) throw new TerminalError('terminal_already_controlled')
      opened = await deps.authorized(request, taskId, async (scope, client) => ({ scope,
        lease: await deps.begin(scope, { kind: 'terminal' }, client) }), expected(initial))
      await deps.resume(opened.scope, opened.lease, request.signal)
      const resumed = await deps.authority(request, taskId, expected(initial))
      const prepared = await deps.prepare(resumed, request.signal, opened.lease)
      const admitted = await deps.authorized(request, taskId, async (scope, client) => {
        const lease = await deps.read(scope, { kind: 'terminal', id: opened!.lease.id }, client)
        if (!lease) throw new TerminalError('terminal_ended')
        return { scope, lease, ticket: deps.grant(prepared, scope, lease, 'stream') }
      }, expected(initial))
      const abort = new AbortController()
      const signal = AbortSignal.any([request.signal, abort.signal])
      const upstream = await deps.request(prepared, 'stream', admitted.ticket, '', signal)
      const stream = relayTerminal(upstream, () => deps.close(admitted.scope, { kind: 'terminal', id: admitted.lease.id }), abort)
      return new Response(stream, { headers: { ...HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8',
        'X-Accel-Buffering': 'no', 'X-Terminal-Session-Id': admitted.lease.id } })
    } catch (error) {
      // A concurrent reconnect can reuse this lease. Persist its fence before
      // cleanup even when this request did not issue a ticket; only a remote
      // close ACK can delete it. Unknown results remain pending and bounded.
      if (opened) await deps.revoke(opened.scope, { kind: 'terminal', id: opened.lease.id }).catch(() => undefined)
      return failure(error)
    }
  }

  const control = async (request: Request, taskId: string, operation: 'input' | 'resize') => {
    try {
      origin(request)
      let value: unknown = {}
      let requestId: string | undefined
      {
        value = await body(request)
        if (operation === 'input') {
          if (value && typeof value === 'object' && 'data' in value && typeof value.data === 'string'
            && Buffer.byteLength(value.data) > TERMINAL_INPUT_BYTES) throw new TerminalError('terminal_input_too_large')
          const parsed = terminalInputSchema.safeParse(value)
          if (!parsed.success) throw new TerminalError('terminal_invalid_request')
          requestId = parsed.data.requestId ?? randomUUID()
          value = { ...parsed.data, requestId }
        } else {
          const parsed = terminalResizeSchema.safeParse(value)
          if (!parsed.success) throw new TerminalError('terminal_invalid_request')
          value = parsed.data
        }
      }
      const scope = await deps.authority(request, taskId)
      const existing = scope.sponsoredPlacement ? await deps.read(scope,{kind:'terminal'}) : undefined
      if (scope.sponsoredPlacement && !existing) throw new TerminalError('terminal_ended')
      const prepared: TerminalPrepared = await deps.existing(scope,request.signal,existing)
      const payload = JSON.stringify(value)
      const admitted = await deps.authorized(request, taskId, async (current, client) => {
        const lease = await deps.read(current, { kind: 'terminal' }, client)
        if (!lease) throw new TerminalError('terminal_ended')
        return { scope: current, lease, ticket: deps.grant(prepared, current, lease, operation, payload) }
      }, expected(scope))
      const response = await deps.request(prepared, operation, admitted.ticket, payload, request.signal)
      await response.body?.cancel()
      return new Response(null, { status: 204, headers: { ...HEADERS, ...(requestId ? { 'X-Terminal-Request-Id': requestId } : {}) } })
    } catch (error) { return failure(error) }
  }
  const close = async (request: Request, taskId: string) => {
    try {
      origin(request)
      const current = await deps.authorized(request, taskId, async (scope, client) => ({ scope,
        lease: await deps.read(scope, { kind: 'terminal' }, client) }))
      if (current.lease) {
        const result = await deps.revoke(current.scope, { kind: 'terminal', id: current.lease.id })
        if (result.pending) throw new TerminalError('terminal_unavailable', { detail: 'runtime' })
      }
      return new Response(null, { status: 204, headers: HEADERS })
    } catch (error) { return failure(error) }
  }
  return { stream, input: (request: Request, taskId: string) => control(request, taskId, 'input'),
    resize: (request: Request, taskId: string) => control(request, taskId, 'resize'),
    close }
}

export const reviewTerminal = reviewTerminalHandlers()
