import { BASE_PATH } from '@/lib/base-path'
import { markStartup } from '../startup'
import { rendererHost } from './host'

let loading: Promise<typeof import('./workspace')> | undefined
let preloading: Promise<void> | undefined
let loaded: typeof import('./workspace') | undefined

/** Both React.lazy and the optional warm-up join the same local module load. */
export function loadWorkspace() {
  if (!loading) {
    markStartup('renderer.workspace.import.start')
    loading = import('./workspace').then(module => {
      loaded = module
      markStartup('renderer.workspace.import.end')
      return module
    })
  }
  return loading
}

/** A completed preload can render synchronously after normal authorization. */
export function readLoadedWorkspace() {
  return loaded?.default
}

/** A retained main-process identity is only a hint to load installed code.
 * It grants no render/cache authority: Routes still waits for the ordinary
 * server bootstrap. Sign-in and public pages retain their smaller lazy graph.
 * The early desktop runtime and later React effect share one hint and import. */
export function preloadWorkspace(): Promise<void> {
  const { protocol, host, pathname } = window.location
  if (protocol !== 'mikka:' || host !== 'app') return Promise.resolve()
  if (BASE_PATH && pathname !== BASE_PATH && !pathname.startsWith(`${BASE_PATH}/`)) return Promise.resolve()
  const path = (pathname.slice(BASE_PATH.length).replace(/^\/(?:en|zh-CN)(?=\/|$)/, '') || '/')
  if (!['/', '/dashboard', '/settings', '/settings/teams', '/settings/members'].includes(path)) return Promise.resolve()
  preloading ??= (async () => {
    if (await rendererHost().session()) await loadWorkspace()
  })()
  return preloading
}
