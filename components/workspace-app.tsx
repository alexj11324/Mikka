'use client'
import { useTranslations } from 'next-intl'

import { useEffect, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { SWRConfig, unstable_serialize } from 'swr'
import type { listIssues } from '@/app/actions/issues'
import type { loadTeamDirectory } from '@/app/actions/teams'
import type { WorkspaceSettings } from '@/lib/workspace-access'
import { IssueWorkspace } from '@/components/workspace/issue-workspace'
import { SettingsShell } from '@/components/settings/settings-shell'
import { SettingsDataPreloader } from '@/components/settings/settings-data-preloader'
import { memberSettingsKey, teamDirectoryKey } from '@/lib/settings-data'

export function WorkspaceApp({ user, initialIssues, initialTeams, initialMembers, initialSelected }: {
  user: { id: string; name: string; email: string; image?: string | null }
  initialSelected?: string | null
  initialIssues?: Awaited<ReturnType<typeof listIssues>>
  initialTeams?: Awaited<ReturnType<typeof loadTeamDirectory>>
  initialMembers?: WorkspaceSettings
}) {
  const i18nText = useTranslations();
  const pathname = usePathname()
  const params = useSearchParams()
  const initialWorkspaceId = initialTeams?.workspace.id ?? initialMembers?.workspace.id
  useEffect(() => {
    document.title = pathname === '/' ? i18nText("FeatureCopy.c_8b955749") : pathname === '/settings/teams' ? i18nText("FeatureCopy.c_b770743d") : pathname === '/settings/members' ? i18nText("FeatureCopy.c_53748f61") : i18nText("FeatureCopy.c_7ca3a071")
  }, [pathname])
  const [workspaceId, setWorkspaceId] = useState(initialTeams?.workspace.id ?? initialMembers?.workspace.id)
  const [cacheConfig] = useState(() => {
    const fallback: Record<string, unknown> = {}
    if (initialTeams) fallback[unstable_serialize(teamDirectoryKey(initialTeams.workspace.id))] = initialTeams
    if (initialMembers) fallback[memberSettingsKey(initialMembers.workspace.id)] = initialMembers
    return { provider: () => new Map(), fallback }
  })
  return <SWRConfig value={cacheConfig}>
    <SettingsDataPreloader workspaceId={params.get('workspace') ?? initialWorkspaceId} onWorkspaceResolved={setWorkspaceId} />
    {pathname.startsWith('/settings')
      ? <SettingsShell user={user} defaultWorkspaceId={workspaceId} />
      : <IssueWorkspace user={user} initialIssues={initialIssues} initialSelected={initialSelected} />}
  </SWRConfig>
}
