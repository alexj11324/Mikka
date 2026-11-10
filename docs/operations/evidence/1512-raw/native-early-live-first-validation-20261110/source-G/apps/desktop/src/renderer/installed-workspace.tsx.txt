import { lazy, Suspense, useState } from 'react'
import { WorkspaceLoading } from '@/components/workspace/workspace-loading'
import type { DesktopBootstrap } from './bootstrap'
import type { DesktopSession } from './host'
import type { PreparedLiveChannels } from '@/lib/live/preparation'
import { loadWorkspace, readLoadedWorkspace } from './workspace-loader'

/** Routes mounts this boundary only after its ordinary authenticated bootstrap.
 * React.lazy suspends on its first read even when its promise already settled.
 * Reuse the successfully loaded component without that avoidable fallback.
 */
export function InstalledWorkspace(props: { user: DesktopSession['user']; bootstrap: DesktopBootstrap; livePreparation?: PreparedLiveChannels }) {
  // Keep the first component type for this entire mount. Switching from Lazy to
  // the loaded component later would remount the workspace and lose its state.
  const [Component] = useState(() => readLoadedWorkspace() ?? lazy(loadWorkspace))
  return <Suspense fallback={<WorkspaceLoading />}><Component {...props} /></Suspense>
}
