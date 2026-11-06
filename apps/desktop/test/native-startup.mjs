// Diagnostic timing only, sampled after the unchanged usable-chat stopwatch.
// Fixed mark names and numeric aggregates: no URL, identity, header or payload.
const mainNames = ['ready', 'restore.start', 'restore.end', 'window.start', 'window.created',
  'backend.preconnect', 'bootstrap.network.start', 'bootstrap.headers', 'bootstrap.cache.end', 'bootstrap.response.end']
const rendererNames = ['entry', 'bootstrap.start', 'bootstrap.end', 'workspace.import.start', 'workspace.import.end', 'workspace.mounted']

export async function readNativeStartup(app, page) {
  const main = await app.evaluate((_electron, names) => {
    const result = {}
    for (const name of names) {
      const value = performance.getEntriesByName(`mikka.startup.main.${name}`, 'mark')[0]?.startTime
      result[name] = Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : null
    }
    return result
  }, mainNames)
  const renderer = await page.evaluate(names => {
    const time = value => Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : null
    const marks = {}
    for (const name of names) marks[name] = time(performance.getEntriesByName(`mikka.startup.renderer.${name}`, 'mark')[0]?.startTime)
    const entry = performance.getEntriesByType('navigation')[0]
    const navigation = {}
    for (const key of ['responseStart', 'responseEnd', 'domInteractive', 'domContentLoadedEventEnd', 'loadEventEnd']) navigation[key] = time(entry?.[key])
    const completedResources = {}
    for (const item of performance.getEntriesByType('resource')) {
      let url
      try { url = new URL(item.name) } catch { continue }
      if (!['http:', 'https:', 'mikka:'].includes(url.protocol)) continue
      const category = url.pathname.startsWith('/mikka/api/') ? 'api'
        : /\.(?:m?js)$/.test(url.pathname) ? 'script'
        : /\.css$/.test(url.pathname) ? 'style'
        : /\.(?:woff2?|ttf)$/.test(url.pathname) ? 'font' : 'other'
      if (time(item.duration) === null || time(item.startTime) === null || time(item.responseEnd) === null) continue
      const bucket = completedResources[category] ??= { count: 0, totalDurationMs: 0, firstStartMs: item.startTime, lastEndMs: 0 }
      bucket.count++
      bucket.totalDurationMs += item.duration
      bucket.firstStartMs = Math.min(bucket.firstStartMs, item.startTime)
      bucket.lastEndMs = Math.max(bucket.lastEndMs, item.responseEnd)
    }
    for (const bucket of Object.values(completedResources)) {
      bucket.totalDurationMs = time(bucket.totalDurationMs)
      bucket.firstStartMs = time(bucket.firstStartMs)
      bucket.lastEndMs = time(bucket.lastEndMs)
    }
    return { marks, navigation, completedResources }
  }, rendererNames)
  const duration = (values, start, end) => values[start] !== null && values[end] !== null && values[end] >= values[start]
    ? Math.round((values[end] - values[start]) * 100) / 100 : null
  return {
    version: 1,
    clocks: { main: 'process performance time origin', renderer: 'document navigation time origin' },
    main,
    renderer,
    phasesMs: {
      restore: duration(main, 'restore.start', 'restore.end'),
      backendResponseHeaders: duration(main, 'bootstrap.network.start', 'bootstrap.headers'),
      backendCredentialPersistence: duration(main, 'bootstrap.headers', 'bootstrap.cache.end'),
      backendResponseProcessing: duration(main, 'bootstrap.cache.end', 'bootstrap.response.end'),
      backendBootstrap: duration(main, 'bootstrap.network.start', 'bootstrap.response.end'),
      windowCreation: duration(main, 'window.start', 'window.created'),
      bootstrap: duration(renderer.marks, 'bootstrap.start', 'bootstrap.end'),
      workspaceImport: duration(renderer.marks, 'workspace.import.start', 'workspace.import.end'),
    },
  }
}
