import type { LiveRuntime } from '@/lib/live/channel'
import { LIVE_ID } from '@/lib/live/events'
import { PreparedLiveChannels } from '@/lib/live/preparation'
import type { DesktopBootstrap } from './bootstrap'

/** This is the exact route set rendered by InstalledWorkspace, after locale
 * removal. A device redirect, public page, or sign-in does not prepare live. */
export const isInstalledWorkspacePath = (path: string) => ['/', '/dashboard', '/settings', '/settings/teams', '/settings/members'].includes(path)

const routeId = (value: unknown): value is string => typeof value === 'string' && LIVE_ID.test(value)
  && value !== '00000000-0000-0000-0000-000000000000'

type Bootstrap = Pick<DesktopBootstrap, 'user' | 'session' | 'cacheWorkspace' | 'liveHomeWorkspaceId'>
type Selection = { enabled: boolean; selector: string | null; server: string }

/** Owned by one SessionApplication. It does nothing until a parsed, current
 * bootstrap is explicitly reconciled on the actual workspace route. */
export class WorkspaceLiveController {
  private prepared: { key: string; value: PreparedLiveChannels } | null = null
  constructor(private runtime: (workspaceId: string | null) => LiveRuntime) {}

  reconcile(value: Bootstrap, selection: Selection): PreparedLiveChannels | undefined {
    const { user, session, cacheWorkspace } = value
    if (!selection.enabled || !user?.id || !session?.id || !selection.server
      || !cacheWorkspace || !routeId(cacheWorkspace.workspaceId)
      || !['admin', 'member'].includes(cacheWorkspace.role)
      || selection.selector && selection.selector !== cacheWorkspace.workspaceId) {
      this.retire()
      return
    }
    const homeWorkspaceId = routeId(value.liveHomeWorkspaceId) ? value.liveHomeWorkspaceId : null
    const key = JSON.stringify([user.id, session.id, selection.server, selection.selector,
      cacheWorkspace.workspaceId, cacheWorkspace.role, homeWorkspaceId])
    if (this.prepared?.key === key && !this.prepared.value.isRetired) return this.prepared.value
    this.retire()
    const preparation = new PreparedLiveChannels(this.runtime, { workspaceId: cacheWorkspace.workspaceId, homeWorkspaceId })
    this.prepared = { key, value: preparation }
    return preparation
  }

  retire() {
    this.prepared?.value.retire()
    this.prepared = null
  }
}
