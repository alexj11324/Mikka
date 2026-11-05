'use client'

import { WorkspaceApp } from '@/components/workspace-app'
import type { AuthorizedCacheWorkspace } from '@/lib/swr/cache-scope'

export function MembersPageView({ user, cacheWorkspace, googleEnabled }: { user: { id: string; name: string; email: string; image?: string | null }; cacheWorkspace?: AuthorizedCacheWorkspace | null; workspaceId?: string; inviteInitially: boolean; googleEnabled: boolean }) {
  return <WorkspaceApp user={user} cacheWorkspace={cacheWorkspace} googleEnabled={googleEnabled} />
}
