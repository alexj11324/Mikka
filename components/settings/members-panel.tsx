'use client'

import { MembersSettings } from '@/components/workspace/members-settings'

export function MembersPanel({ workspaceId, inviteInitially = false }: { workspaceId?: string; inviteInitially?: boolean }) {
  return <MembersSettings workspaceId={workspaceId} inviteInitially={inviteInitially} embedded />
}
