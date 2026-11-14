import { DesktopIntegration } from '@/components/desktop/desktop-integration'
import { IssueWorkspace } from '@/components/workspace/issue-workspace'
import { sectionFromQuery } from '@/components/workspace/workspace-navigation'
import { LiveProvider } from '@/hooks/use-live-key'
import type { PreparedLiveChannels } from '@/lib/live/preparation'
import { useWorkspace } from '@/hooks/use-workspace'
import { publicAppOrigin } from '@/lib/platform/public-origin'
import { APP_BUILD } from '@/lib/app-build'
import { platform } from 'mikka:platform'
import type { DesktopBootstrap } from './bootstrap'
import type { DesktopSession } from './host'
import { useLocation } from './location'
import { useEffect } from 'react'
import { markStartup } from '../startup'

export default function Workspace({ user, bootstrap, livePreparation }: { user: DesktopSession['user']; bootstrap: DesktopBootstrap; livePreparation?: PreparedLiveChannels }) {
  useEffect(() => { markStartup('renderer.workspace.mounted') }, [])
  // The installed UI and validated backend origin version this namespace. The
  // shared cache retains its exact hydration, field allowlist and invalidation.
  return <AuthenticatedReadCache ownerId={user.id} workspace={bootstrap.cacheWorkspace} build={platform === 'desktop' ? `desktop:${rendererBuild}:${publicAppOrigin()}` : APP_BUILD}>
    <WorkspaceScope user={user} bootstrap={bootstrap} livePreparation={livePreparation} />
  </AuthenticatedReadCache>
}

function WorkspaceScope({ user, bootstrap, livePreparation }: { user: DesktopSession['user']; bootstrap: DesktopBootstrap; livePreparation?: PreparedLiveChannels }) {
  const params = useLocation().searchParams
  // This key is already read by IssueWorkspace. SWR shares the same request and
  // revision; adding native notifications does not add a workspace read.
  const { data } = useWorkspace(user.email)
  const selected = params.get('issue')
  return <LiveProvider ownerId={user.id} workspaceId={data?.currentUserId === user.id ? data.workspace.id : undefined} preparation={livePreparation}>
    <DesktopIntegration userId={user.id} />
    <IssueWorkspace withinLiveProvider user={user} onboarding={bootstrap.onboarding} googleEnabled={bootstrap.googleEnabled} initialSelected={selected && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(selected) ? selected : null} initialSection={sectionFromQuery(params.get('section') ?? undefined)} initialSettingsSection={params.get('settings') === 'account' || (params.get('settings') === 'integrations' && params.has('google')) ? 'account' : params.get('settings') === 'integrations' ? 'integrations' : undefined} />
  </LiveProvider>
}
import { rendererBuild } from 'mikka:renderer-build'
import { AuthenticatedReadCache } from '@/components/authenticated-read-cache'
