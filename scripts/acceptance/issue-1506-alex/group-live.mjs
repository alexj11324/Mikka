// Same owner ticket / WebSocket protocol as openLiveObserver, for group_chat revisions.
// A newer push can cause a bounded read. There is no reconnect or polling timer.
import { readJson } from '../issue-1504-1506/coordinator-baseline.mjs'
import { ALEX_OWNER_ID } from '../issue-1506-readonly/alex-session.mjs'
import { UUID } from './workspace-setup.mjs'

export async function openGroupLive(session, workspaceId, groupId, baselineRevision = 0,
  { WebSocketClass = WebSocket, readyTimeoutMs = 15_000 } = {}) {
  if (session.identity?.userId !== ALEX_OWNER_ID || !UUID.test(workspaceId) || !UUID.test(groupId)) throw new Error('group_live_scope_invalid')
  const ticket = await readJson(session, '/api/live/ticket?workspace=' + workspaceId)
  let url
  try { url = new URL(ticket?.url) } catch { throw new Error('live_ticket_invalid') }
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash ||
    !/^\/v1\/live\/[a-f0-9]{64}\/socket$/.test(url.pathname) || typeof ticket.protocol !== 'string' || !ticket.protocol ||
    !Number.isFinite(ticket.expiresAt) || ticket.expiresAt <= Date.now()) throw new Error('live_ticket_invalid')
  url.searchParams.set('revisions', '1')
  const socket = new WebSocketClass(url.href, ticket.protocol)
  const summary = { ready: false, revisionCapable: false, matchingPushes: 0, maxRevision: Number.isSafeInteger(baselineRevision) ? baselineRevision : 0,
    readsTriggered: 0, closed: false, unexpectedDisconnect: false }
  let resolveReady, rejectReady, waiter = null, closing = false
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const readyTimer = setTimeout(() => rejectReady(new Error('live_ready_timeout')), readyTimeoutMs)
  const rejectWaiter = code => { if (waiter) { clearTimeout(waiter.timer); waiter.reject(new Error(code)); waiter = null } }
  socket.addEventListener('open', () => socket.send('ping'))
  socket.addEventListener('error', () => { rejectReady(new Error('live_connection_failed')); rejectWaiter('live_connection_failed') })
  socket.addEventListener('close', () => {
    if (!closing) summary.unexpectedDisconnect = true
    rejectReady(new Error('live_connection_failed')); rejectWaiter('live_connection_failed')
  })
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string' || event.data.length > 8192 || event.data === 'pong') return
    let packet
    try { packet = JSON.parse(event.data) } catch { return }
    if (packet?.type === 'live_ready') {
      if (packet.version !== 2 || !Array.isArray(packet.kinds) || !packet.kinds.includes('group_chat') ||
        !Array.isArray(packet.revisions) || !packet.revisions.includes('group_chat')) {
        rejectReady(new Error('live_not_supported')); return
      }
      summary.ready = true; summary.revisionCapable = true; resolveReady(); return
    }
    const events = Array.isArray(packet) && packet.length <= 16 ? packet : [packet]
    for (const data of events) {
      if (!summary.ready || !data || data.kind !== 'group_chat' || typeof data.id !== 'string' ||
        !UUID.test(data.id) || data.id.toLowerCase() !== groupId.toLowerCase() || Object.keys(data).length !== 3 ||
        !Number.isSafeInteger(data.rev) || data.rev <= 0) continue
      summary.matchingPushes++; summary.maxRevision = Math.max(summary.maxRevision, data.rev)
      if (waiter && summary.maxRevision > waiter.after) {
        const current = waiter; waiter = null; clearTimeout(current.timer); current.resolve(summary.maxRevision)
      }
    }
  })
  const next = (after, timeoutMs) => {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000 || waiter) throw new Error('group_live_wait_invalid')
    if (summary.maxRevision > after) return Promise.resolve(summary.maxRevision)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiter = null; reject(new Error('group_boundary_timeout')) }, timeoutMs)
      waiter = { after, resolve, reject, timer }
    })
  }
  const close = async () => {
    closing = true; clearTimeout(readyTimer); rejectWaiter('live_closed')
    if (socket.readyState === 3) { summary.closed = true; return true }
    const closed = new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 3_000)
      socket.addEventListener('close', () => { clearTimeout(timer); resolve(true) }, { once: true })
    })
    socket.close(1000); summary.closed = await closed; return summary.closed
  }
  try { await ready } catch (error) { await close(); throw error } finally { clearTimeout(readyTimer) }
  return { summary, next, close }
}
