import { isTerminalWorkflowRunStatus } from '@workflow/world'
import { encodeRecord } from './records.mjs'

const tag = runId => 'terminal:' + runId
export const cbor = data => new Response(encodeRecord(data), { headers: { 'content-type': 'application/cbor', 'cache-control': 'no-store' } })

export function subscribeToRun(ctx, request, run) {
  if (request.headers.get('upgrade') !== 'websocket') return new Response(null, { status: 404 })
  if (!run) return cbor(null)
  if (isTerminalWorkflowRunStatus(run.status)) return cbor(run)
  const [peer, retained] = Object.values(new WebSocketPair())
  ctx.acceptWebSocket(retained, [tag(run.runId)])
  return new Response(null, { status: 101, webSocket: peer })
}

export function signalTerminal(ctx, run) {
  if (!run || !isTerminalWorkflowRunStatus(run.status)) return
  for (const socket of ctx.getWebSockets(tag(run.runId))) {
    try { socket.send('terminal') } catch { /* disconnected subscriber */ }
  }
}

export async function waitForTerminal(stub, request) {
  const url = new URL(request.url)
  const runId = url.searchParams.get('runId')
  const timeout = Number(url.searchParams.get('timeoutMs'))
  if (!runId || !Number.isFinite(timeout) || timeout < 0) return new Response(null, { status: 400 })
  if (timeout === 0) return cbor(await stub.run(runId))
  const reply = await stub.fetch(new Request(url, { headers: { upgrade: 'websocket' } }))
  const peer = reply.webSocket
  if (!peer) return reply
  // Each caller gets a one-shot provider socket. A terminal commit wakes all
  // subscribers. Timeout or abort releases the peer; no storage polling.
  let timer
  let resolve
  const wake = new Promise(done => { resolve = done })
  for (const name of ['message', 'error', 'close']) peer.addEventListener(name, resolve, { once: true })
  request.signal.addEventListener('abort', resolve, { once: true })
  try {
    peer.accept()
    timer = setTimeout(resolve, Math.min(timeout, 60_000))
    if (!request.signal.aborted) await wake
    return cbor(await stub.run(runId))
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener('abort', resolve)
    peer.close(1000, 'Run snapshot read')
  }
}
