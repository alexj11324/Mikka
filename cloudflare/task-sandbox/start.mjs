export class TaskStartError extends Error {
  constructor(terminal) {
    const code = typeof terminal?.message === 'string' && /image not found/i.test(terminal.message)
      ? 'task_image_unavailable'
      : 'task_start_failed'
    super(code)
    this.code = code
  }
}

// start() only validates its arguments synchronously. The provider's terminal
// event carries placement/image errors that the next RPC reports as "not started".
export async function startTaskImage(container, options, inactivityMs) {
  container.start(options)
  const terminal = container.monitor().then(() => null, error => error)
  try {
    await container.setInactivityTimeout(inactivityMs)
  } catch (error) {
    if (container.running) throw error
    let timer
    try {
      const end = await Promise.race([
        terminal,
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 1000) }),
      ])
      throw new TaskStartError(end)
    } finally {
      clearTimeout(timer)
    }
  }
}
