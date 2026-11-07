// Cache acceptance uses the real durable-stream decoder. That source is byte-identical
// at acceptance base 4f9e5d4 and production c594; no React/browser runtime is needed.
import { readCoordinatorStream } from '../../../lib/coordinator-stream-client.ts'
import { openLiveObserver } from '../issue-1504-1506/coordinator-baseline.mjs'

export const CACHE_PROTOCOL_SOURCE_SHA = 'c594da2b81aac8ff466a94e5050839513a002b0e'
const fail = code => { throw new Error(code) }
const revision = (chat, botId) => chat.live?.revisions?.['bot_chat:' + botId.toLowerCase()]
const validRevision = value => Number.isSafeInteger(value) && value >= 0

// Tap the existing authenticated socket, not a second connection. The legacy
// baseline helper stays unchanged: editing its directory would trigger its old
// production workflow. This adapter adds only a latched matching-key listener.
export async function openCacheLive(session, chat, { WebSocketClass = WebSocket, ...options } = {}) {
  let socket
  const base = await openLiveObserver(session, chat, { ...options, WebSocketClass: class {
    constructor(...args) { socket = new WebSocketClass(...args); return socket }
  } })
  if (!base.summary.revisionCapable || !validRevision(revision(chat, chat.botId))) {
    await base.close(); fail('live_not_supported')
  }
  let latest = revision(chat, chat.botId), started = null, lost = false
  const listeners = new Set()
  const receive = event => {
    if (started === null || typeof event.data !== 'string' || event.data.length > 8192) return
    let packet
    try { packet = JSON.parse(event.data) } catch { return }
    const batch = Array.isArray(packet)
    if (batch && (packet.length < 1 || packet.length > 16)) return
    for (const data of batch ? packet : [packet]) {
      if (!data || data.kind !== 'bot_chat' || typeof data.id !== 'string' ||
        data.id.toLowerCase() !== chat.botId.toLowerCase() || Object.keys(data).length !== 3 ||
        !Number.isSafeInteger(data.rev) || data.rev <= 0) continue
      // The legacy observer already counts single frames, but not batches.
      if (batch) {
        base.summary.matchingPushes++; base.summary.versionedPushes++
        base.summary.firstPushMs ??= Math.round((performance.now() - started) * 10) / 10
        base.summary.maxRevision = Math.max(base.summary.maxRevision ?? 0, data.rev)
        if (data.rev > (base.summary.baselineRevision ?? 0)) base.summary.newerPushes++
      }
      if (data.rev <= latest) continue
      latest = data.rev
      for (const listener of listeners) listener.change()
    }
  }
  const disconnected = () => { lost = true; for (const listener of listeners) listener.error(new Error('live_connection_failed')) }
  socket.addEventListener('message', receive)
  socket.addEventListener('error', disconnected)
  socket.addEventListener('close', disconnected)
  return {
    summary: base.summary,
    get revision() { return latest },
    begin(at) { started = at; base.begin(at) },
    subscribe(change, error) {
      if (lost || socket.readyState !== 1) fail('live_connection_failed')
      const listener = { change, error }; listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async close() {
      socket.removeEventListener('message', receive); socket.removeEventListener('error', disconnected)
      socket.removeEventListener('close', disconnected); listeners.clear()
      return base.close()
    },
  }
}

/** A committed round is durable, not EOF. Refresh on committed and actual newer
 * keys only; a key received during a read remains dirty until a fresh read covers
 * it. No timer, retry, fixed delay, or extra model call advances this state. */
export async function observeCacheCompletion({ body, runId, botId, initialChat, live, signal,
  readChat, onEvent = () => {}, onRead = () => {}, onClosed = () => {} }) {
  if (!Number.isSafeInteger(initialChat.cursor) || initialChat.cursor < 0 ||
    !Array.isArray(initialChat.persistedStreamIds) ||
    !validRevision(revision(initialChat, botId)) || typeof live.subscribe !== 'function' ||
    !validRevision(live.revision)) fail('chat_invalid')
  const local = new AbortController(), combined = AbortSignal.any([signal, local.signal])
  let failure, wake, closed = false, eof = false, sequence = 0, epoch = 0, commits = 0
  let readCommits = -1, covered = revision(initialChat, botId), current = null
  const rounds = [], allRounds = [], replayedRounds = []
  const prefixIds = [...new Set(initialChat.persistedStreamIds.filter(id => typeof id === 'string' && id.startsWith(runId + ':')))]
    .sort((a, b) => Number(a.slice(runId.length + 1)) - Number(b.slice(runId.length + 1)))
  if (prefixIds.some((id, index) => id !== `${runId}:${index}`)) fail('stream_replay_unproven')
  const prefix = new Set(prefixIds)
  const notify = () => { const resolve = wake; wake = null; resolve?.() }
  const reject = error => { failure ??= error; local.abort(); notify() }
  const unsubscribe = live.subscribe(notify, reject)
  signal.addEventListener('abort', notify)
  const stream = readCoordinatorStream(body, (event, nextSequence) => {
    if (event.type === 'error') fail('stream_error')
    if (nextSequence !== sequence + 1) fail('stream_sequence_invalid')
    sequence = nextSequence
    if (event.type === 'start') {
      if (current && current.through === undefined || event.id !== `${runId}:${allRounds.length}`) fail('stream_turn_mismatch')
      current = { id: event.id, replyCharacters: 0 }; allRounds.push(current)
      if (!prefix.has(event.id)) rounds.push(current)
      epoch++
    } else if (!current || event.id !== current.id || current.through !== undefined) fail('stream_turn_mismatch')
    const replayed = prefix.has(current.id)
    if (event.type === 'tool' && !replayed) fail('unexpected_tool')
    if (event.type === 'text') current.replyCharacters += Array.from(event.delta).length
    if (event.type === 'reset') current.replyCharacters = Array.from(event.text).length
    if (event.type === 'committed') {
      if (event.through <= (allRounds.at(-2)?.through ?? -1)) fail('committed_invalid')
      if (replayed) {
        if (event.through > initialChat.cursor) fail('stream_replay_unproven')
        replayedRounds.push({ id: event.id, through: event.through })
      } else {
        if (event.quiet || event.through <= initialChat.cursor) fail('committed_invalid')
        commits++
      }
      current.through = event.through; current.quiet = event.quiet; epoch++
    }
    // Old durable frames validate the replay prefix but never contribute this
    // send's first text, committed boundary, response size, or completion reads.
    if (!replayed) onEvent(event, rounds)
    notify()
  }, combined).then(() => {
    if (!combined.aborted) {
      eof = true
      if (!rounds.length || rounds.some(round => round.through === undefined)) reject(new Error('stream_incomplete'))
    }
    notify()
  }).catch(reject)
  try {
    while (true) {
      if (failure) throw failure
      if (signal.aborted) fail('stream_deadline')
      // This is an event wait, not polling. Every read consumes a new committed
      // boundary or a real revision that the previous read did not cover.
      if (commits && current.through !== undefined && (commits !== readCommits || live.revision > covered)) {
        const readingEpoch = epoch, requiredRevision = Math.max(covered, live.revision)
        const trigger = commits !== readCommits ? 'committed' : 'live_revision'
        readCommits = commits
        const chat = await readChat(combined)
        if (failure) throw failure
        if (signal.aborted) fail('stream_deadline')
        const returnedRevision = revision(chat, botId)
        if (chat.botId !== botId || !chat.enabled || !Number.isSafeInteger(chat.cursor) || typeof chat.working !== 'boolean' || !Array.isArray(chat.items) ||
          chat.live?.ownerId !== initialChat.live?.ownerId || chat.live?.workspaceId !== initialChat.live?.workspaceId ||
          !Array.isArray(chat.persistedStreamIds) || !validRevision(returnedRevision)) fail('chat_invalid')
        if (chat.error !== null) fail('chat_completion_error')
        if (chat.streamRunId && chat.streamRunId !== runId) fail('stream_turn_mismatch')
        if (chat.items.some(item => item.position > initialChat.cursor && (item.failure || item.stopped))) fail('reply_failed_or_stopped')
        onRead({ trigger, requiredRevision, returnedRevision, cursor: chat.cursor,
          working: chat.working, activeStream: Boolean(chat.streamRunId), observedRounds: rounds.length })
        if (returnedRevision < requiredRevision) fail('chat_revision_stale')
        covered = returnedRevision
        if (readingEpoch !== epoch || live.revision > covered || current.through === undefined) continue
        if (chat.working || chat.streamRunId) continue
        const persisted = chat.persistedStreamIds.filter(id => typeof id === 'string' && id.startsWith(runId + ':') && !prefix.has(id))
        // A database snapshot may see round N before its stream frames arrive.
        // Wait for those real frames; an earlier committed cannot complete it.
        if (persisted.some(id => !rounds.some(round => round.id === id))) { await new Promise(resolve => { wake = resolve }); continue }
        if (chat.cursor < current.through || rounds.some(round => !persisted.includes(round.id) ||
          !chat.items.some(item => item.streamId === round.id && item.from === 'coordinator' &&
            !item.pending && !item.failure && !item.stopped && typeof item.text === 'string' && item.text.length > 0 &&
            Number.isSafeInteger(item.position) && item.position > initialChat.cursor && item.position <= round.through))) fail('reply_not_persisted')
        if (rounds.some(round => !round.replyCharacters)) fail('reply_missing')
        if (rounds.some(round => round.replyCharacters > 30)) fail('reply_too_long')
        const termination = eof ? 'eof' : 'client_cancel_after_committed_idle'
        local.abort('committed_idle'); await stream
        // The decoder's finally also awaits reader.cancel. An error already in
        // that cleanup must not disappear because our idle result arrived first.
        if (failure) throw failure
        return { chat, termination, rounds, replayedRounds, committed: { id: current.id, through: current.through, quiet: current.quiet },
          replyCharacters: rounds.reduce((total, round) => total + round.replyCharacters, 0) }
      }
      await new Promise(resolve => { wake = resolve })
    }
  } catch (error) {
    // A socket/stream failure can abort an in-flight normal read. Preserve that
    // failure instead of replacing it with the read's consequent AbortError.
    if (failure) throw failure
    throw error
  } finally {
    closed = true; unsubscribe(); signal.removeEventListener('abort', notify)
    local.abort(); await stream
    onClosed({ eof, readerReleased: closed })
  }
}
