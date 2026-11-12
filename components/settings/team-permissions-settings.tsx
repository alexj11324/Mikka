'use client'

import { TeamPermissionsPage } from '@ui-slot/settings-permissions'
import { useAppPolicy, useComputerPolicy, useSharePolicy } from '@/hooks/settings/use-team-permissions'

export function TeamPermissionsSettings({ workspaceId }: { workspaceId: string }) {
  const computer = useComputerPolicy(workspaceId)
  const share = useSharePolicy(workspaceId)
  const apps = useAppPolicy(workspaceId)
  return <TeamPermissionsPage workspaceId={workspaceId} computer={computer} share={share} apps={apps} />
}
