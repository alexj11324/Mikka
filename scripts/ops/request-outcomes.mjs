export const WINDOW_MS = 15 * 60_000

export const emptyOutcomeMetric = () => ({ count: 0, completed: 0, empty: 0, work: 0, ignored: 0, unknown: 0, emptyRatio: null, coverage: null, unwindowed: 0 })

/** Business outcomes are explicit; errors, incomplete pairs and legacy logs cannot prove empty work. */
export function requestOutcomes(lines, now = Date.now()) {
  const routes = {}, starts = new Map(), ends = new Map()
  const metricFor = route => routes[route] ??= emptyOutcomeMetric()
  for (const line of lines) {
    let entry
    try { entry = typeof line === 'string' ? JSON.parse(line) : line } catch { continue }
    if (!entry || !['api_request_started', 'api_request'].includes(entry.msg) || typeof entry.route !== 'string') continue
    const metric = metricFor(entry.route), at = Date.parse(entry.timestamp)
    if (!Number.isFinite(at) || typeof entry.invocationId !== 'string') { metric.unwindowed++; continue }
    if (entry.msg === 'api_request_started') starts.set(entry.invocationId, entry)
    else ends.set(entry.invocationId, entry)
  }
  for (const id of new Set([...starts.keys(), ...ends.keys()])) {
    const start = starts.get(id), end = ends.get(id), entry = start ?? end, at = Date.parse(entry.timestamp)
    if (at < now - WINDOW_MS || at > now) continue
    const metric = metricFor(entry.route)
    metric.count++
    const paired = start && end && start.route === end.route && Date.parse(end.timestamp) >= at && Date.parse(end.timestamp) <= now
    if (paired) metric.completed++
    if (paired && end.status >= 200 && end.status < 400 && !end.error && ['empty', 'work', 'ignored'].includes(end.outcome)) metric[end.outcome]++
    else metric.unknown++
  }
  for (const metric of Object.values(routes)) {
    const classified = metric.empty + metric.work + metric.ignored
    metric.emptyRatio = classified ? metric.empty / classified : null
    metric.coverage = metric.count ? classified / metric.count : null
  }
  return routes
}
