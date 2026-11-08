import { createHash } from 'node:crypto'
import sharp from 'sharp'

const check = (value, code) => { if (!value) throw new Error(code) }

// The ordinary owner API issues this capability. The probe never reads the
// gateway signing key or creates a runtime/broker capability of its own.
export function ownerViewerUrl(capability, binding, now = Date.now()) {
  const url = new URL(capability.url)
  check(url.protocol === 'wss:' && !url.username && !url.password && !url.hash
    && url.pathname === `/agents/${binding.subagentId}/viewer`
    && [...url.searchParams.keys()].join() === 'token', 'VIEWER_CAPABILITY')
  const parts = url.searchParams.get('token').split('.')
  check(parts.length === 2 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part)), 'VIEWER_CAPABILITY')
  const claim = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
  check(['ownerId', 'workspaceId', 'botId', 'subagentId'].every(key => claim[key] === binding[key])
    && claim.role === 'view' && claim.exp * 1000 > now + 15_000
    && claim.exp * 1000 <= now + 125_000
    && Math.floor(Date.parse(capability.expiresAt) / 1000) === claim.exp, 'VIEWER_BINDING')
  return url.toString()
}

export function observeOwnerViewer(url, Socket = WebSocket) {
  const initial = Promise.withResolvers(), guarded = Promise.withResolvers(), recovered = Promise.withResolvers()
  const failed = Promise.withResolvers(), sockets = [], decoding = new Set()
  // Event handlers can detect a leak before the next awaited phase begins.
  void failed.promise.catch(() => {})
  let phase = 'initial', initialDigest, firstClosed = false, guardedFrames = 0, closing = false
  let decodingInitial = false, decodingRecovery = false
  const fail = code => failed.reject(new Error(code))
  const within = async (promise, code, milliseconds = 5_000) => {
    let deadline
    try { return await Promise.race([promise, failed.promise,
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(code)), milliseconds) })]) }
    finally { clearTimeout(deadline) }
  }
  const imageDigest = async frame => {
    try {
      const { data, info } = await sharp(frame, { limitInputPixels: 1280 * 800, failOn: 'warning' })
        .removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
      try {
        check(info.width > 0 && info.width <= 1280 && info.height > 0 && info.height <= 800
          && info.channels === 3 && data.length === info.width * info.height * info.channels, 'VIEWER_FRAME_FORMAT')
        return createHash('sha256').update(`${info.width}x${info.height}:`).update(data).digest('hex')
      } finally { data.fill(0) }
    } finally { frame.fill(0) }
  }
  const connect = primary => {
    const socket = new Socket(url), closed = Promise.withResolvers()
    sockets.push({ socket, closed: closed.promise })
    socket.addEventListener('open', () => { if (!primary) guarded.resolve() })
    socket.addEventListener('error', () => { if (!closing) fail('VIEWER_TRANSPORT') })
    socket.addEventListener('message', event => {
      if (closing) return
      let message
      try { message = JSON.parse(event.data) } catch { fail('VIEWER_FRAME_FORMAT'); return }
      // WebSocket ping/pong control frames are handled by the client. An
      // application-level non-image message is neither a positive image nor a
      // leaked image; it cannot satisfy either positive control.
      if (message?.type !== 'frame') return
      if (typeof message.data !== 'string'
        || message.data.length > 8 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(message.data)) {
        fail('VIEWER_FRAME_FORMAT'); return
      }
      const frame = Buffer.from(message.data, 'base64')
      if (frame.length < 128 || frame.readUInt16BE(0) !== 0xffd8 || frame.readUInt16BE(frame.length - 2) !== 0xffd9) {
        fail('VIEWER_FRAME_FORMAT'); return
      }
      if (!primary && phase === 'guarded') { frame.fill(0); guardedFrames++; fail('VIEWER_GUARD_LEAK'); return }
      const initialFrame = primary && phase === 'initial' && !decodingInitial
      const recoveryFrame = !primary && phase === 'resuming' && !decodingRecovery
      if (!initialFrame && !recoveryFrame) { frame.fill(0); return }
      if (initialFrame) decodingInitial = true
      if (recoveryFrame) decodingRecovery = true
      // Decode the two positive controls with the repository's existing image
      // decoder. JPEG markers or an arbitrary message alone cannot pass. No
      // frame bytes, capability URLs, pixels or hashes enter the report.
      const pending = imageDigest(frame).then(digest => {
        if (closing) return
        if (initialFrame) { initialDigest = digest; initial.resolve() }
        else if (digest === initialDigest) fail('VIEWER_RECOVERY_STALE')
        else recovered.resolve()
      }, () => { if (!closing) fail('VIEWER_FRAME_FORMAT') })
      decoding.add(pending)
      void pending.finally(() => decoding.delete(pending))
    })
    socket.addEventListener('close', event => {
      closed.resolve()
      if (closing) return
      if (primary && phase === 'armed' && event.wasClean && event.code === 1000) {
        firstClosed = true; phase = 'guarded'
        // Reuse only this owner's unexpired view capability. Reconnecting as
        // soon as begin closes the original viewer avoids new grant I/O during
        // the product's bounded credential-submission continuation.
        try { connect(false) } catch { fail('VIEWER_RECONNECT'); return }
      } else fail('VIEWER_CLOSED_UNEXPECTEDLY')
    })
  }
  connect(true)
  return {
    async beforeLogin() { await within(initial.promise, 'VIEWER_INITIAL_TIMEOUT'); phase = 'armed' },
    async whileFormHeld(receivedAt) {
      await within(guarded.promise, 'VIEWER_GUARDED_TIMEOUT', 500)
      check(firstClosed && phase === 'guarded' && sockets[1].socket.readyState === 1, 'VIEWER_GUARD_STATE')
      const started = performance.now()
      check(Number.isFinite(receivedAt) && receivedAt >= 0 && receivedAt <= started, 'VIEWER_POST_NOT_RECEIVED')
      let timer
      try { await within(new Promise(resolve => { timer = setTimeout(resolve, 750) }), 'VIEWER_GUARD_TIMEOUT', 1_000) }
      finally { clearTimeout(timer) }
      check(guardedFrames === 0 && sockets[1].socket.readyState === 1, 'VIEWER_GUARD_STATE')
      const observedForMs = Math.floor(performance.now() - started)
      check(observedForMs >= 700, 'VIEWER_GUARD_WINDOW_SHORT')
      return { observedForMs, postToObservationMs: Math.floor(started - receivedAt), frames: guardedFrames }
    },
    allowSafeNavigation() { check(phase === 'guarded', 'VIEWER_GUARD_STATE'); phase = 'resuming' },
    async afterSafeNavigation() {
      await within(recovered.promise, 'VIEWER_RECOVERY_TIMEOUT')
      phase = 'done'
      return { ownerViewerBeforeLogin: true, guardedViewerClosed: firstClosed,
        filledFormEmittedNoFrames: guardedFrames === 0, ownerViewerAfterSafeNavigation: true }
    },
    async close() {
      closing = true
      await Promise.all(sockets.map(async ({ socket, closed }) => {
        if (socket.readyState === 3) return
        let deadline
        try {
          socket.close(1000)
          await Promise.race([closed, new Promise((_, reject) => {
            deadline = setTimeout(() => reject(new Error('VIEWER_CLOSE_UNCONFIRMED')), 3_000)
          })])
          check(socket.readyState === 3, 'VIEWER_CLOSE_UNCONFIRMED')
        } finally { clearTimeout(deadline) }
      }))
      let deadline
      try {
        await Promise.race([Promise.all(decoding), new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('VIEWER_FRAME_CLOSE_UNCONFIRMED')), 3_000)
        })])
      } finally { clearTimeout(deadline) }
    },
  }
}
