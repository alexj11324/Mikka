'use client'

import { WorkspaceSettings } from '@/components/settings/workspace-settings'
import { ArchivedBotsSettings } from '@/components/settings/archived-bots-settings'
import type { SettingsGeneralProps } from '@/components/slots/settings-general-contract'

/** 常规: the workspace's icon, name, address and danger zone, then a team's archived bots. */
export function WorkspaceGeneral({ workspaceId, userKey, showArchived }: SettingsGeneralProps) {
  return <>
    <WorkspaceSettings userKey={userKey} workspaceId={workspaceId} />
    {showArchived && workspaceId && <ArchivedBotsSettings key={`archived-${workspaceId}`} workspaceId={workspaceId} />}
  </>
}
