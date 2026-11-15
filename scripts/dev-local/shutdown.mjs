import { on } from 'node:events'

/** Wait only for the owned API child and retain its exit reason if it never became ready. */
export async function waitForApiReady(child, origin, signal) {
  try {
    for await (const [message] of on(child, 'message', { signal, close: ['exit'] })) {
      if (message?.type !== 'api-ready') continue
      if (message.origin !== origin) throw new Error('API_DEV_ORIGIN_MISMATCH')
      return
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason
    throw error
  }
  throw new Error('API child exited before readiness: ' + (child.signalCode ?? child.exitCode))
}

/** Stop only child processes and resource handles owned by this local stack. */
export async function stopOwnedServices(children, closers, graceMs = 4000) {
  const live = child => child.pid && child.exitCode === null && child.signalCode === null
  const exits = children.filter(live).map(child => new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve) }))
  for (const child of children.filter(live)) child.kill('SIGTERM')
  let timer
  try {
    await Promise.race([
      Promise.allSettled([...exits, ...closers.map(close => Promise.resolve().then(close))]),
      new Promise(resolve => { timer = setTimeout(resolve, graceMs) }),
    ])
  } finally {
    clearTimeout(timer)
    for (const child of children.filter(live)) child.kill('SIGKILL')
  }
}
