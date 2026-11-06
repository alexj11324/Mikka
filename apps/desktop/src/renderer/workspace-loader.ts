import { markStartup } from '../startup'
import { rendererHost } from './host'
import { withoutLocale } from './location'

let loading: Promise<typeof import('./workspace')> | undefined

/** Both React.lazy and the optional warm-up join the same local module load. */
export function loadWorkspace() {
  if (!loading) {
    markStartup('renderer.workspace.import.start')
    loading = import('./workspace').then(module => {
      markStartup('renderer.workspace.import.end')
      return module
    })
  }
  return loading
}

/** A retained main-process identity is only a hint to load installed code.
 * It grants no render/cache authority: Routes still waits for the ordinary
 * server bootstrap. Sign-in and public pages retain their smaller lazy graph. */
export async function preloadWorkspace(): Promise<void> {
  const path = withoutLocale(window.location.pathname)
  if (!['/', '/dashboard', '/settings', '/settings/teams', '/settings/members'].includes(path)) return
  if (await rendererHost().session()) await loadWorkspace()
}
