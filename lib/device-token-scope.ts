/** Fail closed for a cloud credential: it may only register its pre-created
 * device, use that device's daemon routes, and report runs pinned to it. */
export async function cloudDeviceScopeAllows(request: Request, deviceId: string, runBelongs: (runId: string, deviceId: string) => Promise<boolean>): Promise<boolean> {
  let path = new URL(request.url).pathname
  if (path === '/mikka' || path.startsWith('/mikka/')) path = path.slice('/mikka'.length)
  if (path === '/v1/devices/register') {
    if (request.method !== 'POST') return false
    const data = await request.clone().json().catch(() => null)
    return typeof data === 'object' && data !== null && data.deviceId === deviceId
  }
  const device = /^\/v1\/devices\/([^/]+)\/(.+)$/.exec(path)
  if (device) {
    if (device[1] !== deviceId) return false
    const tail = device[2]
    if (/^(?:heartbeat|repos|runs|commands|commands\/ack|computer|fs\/requests(?:\/[^/]+)?)$/.test(tail)) return true
    const nestedRun = /^runs\/([^/]+)\/(?:claim|subscription)$/.exec(tail)
    return nestedRun ? await runBelongs(nestedRun[1], deviceId) : false
  }
  const run = /^\/v1\/runs\/([^/]+)(?:\/(?:events|complete|checkpoint|tool-approval))?$/.exec(path)
  return run ? await runBelongs(run[1], deviceId) : false
}
