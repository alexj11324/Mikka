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
