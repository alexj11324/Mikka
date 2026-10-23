'use client'

import { WorkspaceApp } from '@/components/workspace-app'

export function MembersPageView({ user, googleEnabled }: { user: { id: string; name: string; email: string; image?: string | null }; workspaceId?: string; inviteInitially: boolean; googleEnabled: boolean }) {
  return <WorkspaceApp user={user} googleEnabled={googleEnabled} />
}
