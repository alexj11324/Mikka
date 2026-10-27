import { createConnection } from 'node:net'

const path = '/home/user/.mikka/shared-cookies/manager.sock'
async function exchange(baseline, current) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path), timer = setTimeout(() => { socket.destroy(); reject(new Error('Cookie exchange unavailable')) }, 10_000)
    let buffer = ''
    socket.on('connect', () => socket.write(JSON.stringify({ baseline, current }) + '\n'))
    socket.on('data', chunk => {
      buffer += chunk.toString()
      if (buffer.length > 8 * 1024 * 1024) { socket.destroy(); return }
      const end = buffer.indexOf('\n'); if (end < 0) return
      try { const value = JSON.parse(buffer.slice(0, end)); if (!Array.isArray(value.cookies)) throw new Error('Cookie exchange unavailable'); clearTimeout(timer); socket.end(); resolve(value.cookies) }
      catch { clearTimeout(timer); socket.destroy(); reject(new Error('Cookie exchange unavailable')) }
    })
    socket.on('error', () => { clearTimeout(timer); reject(new Error('Cookie exchange unavailable')) })
  })
}

/** `call` is a private CDP-pipe transport, never exposed to the model. */
export function cookieSynchronizer(call) {
  let baseline = []
  return async () => {
    const { cookies } = await call('Storage.getCookies', {}, null)
    const shared = await exchange(baseline, cookies)
    if (JSON.stringify(cookies) !== JSON.stringify(shared)) {
      await call('Storage.clearCookies', {}, null)
      if (shared.length) await call('Storage.setCookies', { cookies: shared }, null)
    }
    baseline = shared
  }
}
