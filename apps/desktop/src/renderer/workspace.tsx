import { DesktopIntegration } from '@/components/desktop/desktop-integration'
import { IssueWorkspace } from '@/components/workspace/issue-workspace'
import { sectionFromQuery } from '@/components/workspace/workspace-navigation'
import { LiveProvider } from '@/hooks/use-live-key'
import { useWorkspace } from '@/hooks/use-workspace'
import type { DesktopBootstrap } from './bootstrap'
import type { DesktopSession } from './host'
import { useLocation } from './location'

export default function Workspace({ user, bootstrap }: { user: DesktopSession['user']; bootstrap: DesktopBootstrap }) {
  const params = useLocation().searchParams
  // This key is already read by IssueWorkspace. SWR shares the same request and
  // revision; adding native notifications does not add a workspace read.
  const { data } = useWorkspace(user.email)
  const selected = params.get('issue')
  return <LiveProvider ownerId={user.id} workspaceId={data?.currentUserId === user.id ? data.workspace.id : undefined}>
    <DesktopIntegration userId={user.id} />
    <IssueWorkspace withinLiveProvider user={user} onboarding={bootstrap.onboarding} googleEnabled={bootstrap.googleEnabled} initialSelected={selected && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(selected) ? selected : null} initialSection={sectionFromQuery(params.get('section') ?? undefined)} initialSettingsSection={params.get('settings') === 'account' || (params.get('settings') === 'integrations' && params.has('google')) ? 'account' : params.get('settings') === 'integrations' ? 'integrations' : undefined} />
  </LiveProvider>
}
