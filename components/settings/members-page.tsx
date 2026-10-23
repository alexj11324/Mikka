'use client'

import type { WorkspaceSettings } from '@/lib/workspace-access'
import { WorkspaceApp } from '@/components/workspace-app'

export function MembersPageView({ user, googleEnabled, initialMembers }: { user: { id: string; name: string; email: string; image?: string | null }; workspaceId?: string; inviteInitially: boolean; googleEnabled: boolean; initialMembers?: WorkspaceSettings }) {
  return <WorkspaceApp user={user} googleEnabled={googleEnabled} initialMembers={initialMembers} />
}
