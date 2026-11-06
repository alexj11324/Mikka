/** Bounded, credential-free timings for the installed startup path. A mark is
 * recorded once per process/document; account changes and retries add no log. */
export type StartupMark =
  | 'main.ready' | 'main.restore.start' | 'main.restore.end' | 'main.window.start' | 'main.window.created'
  | 'main.backend.preconnect' | 'main.bootstrap.network.start' | 'main.bootstrap.headers'
  | 'main.bootstrap.cache.end' | 'main.bootstrap.response.end'
  | 'renderer.entry' | 'renderer.bootstrap.start' | 'renderer.bootstrap.end'
  | 'renderer.workspace.import.start' | 'renderer.workspace.import.end' | 'renderer.workspace.mounted'

export function markStartup(name: StartupMark): void {
  const key = `mikka.startup.${name}`
  if (performance.getEntriesByName(key, 'mark').length === 0) performance.mark(key)
}
