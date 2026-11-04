'use client'

import { useState } from 'react'
import useSWR, { type SWRResponse } from 'swr'
import { useTranslations } from 'next-intl'
import { UserRound } from 'lucide-react'
import { withBasePath } from '@/lib/base-path'
import type { McpWorkspacePage, McpWorkspaceServerView } from '@/lib/plugins/contracts'
import { AppTile } from '@/components/plugins/connected-apps'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

export const mcpConnectionsKey = (workspaceId: string) => ['settings:mcp-connections', workspaceId] as const

async function pageFrom(response: Response, workspaceId: string): Promise<McpWorkspacePage> {
  if (!response.ok) throw new Error('MCP connection state unavailable')
  const page = await response.json() as McpWorkspacePage
  if (page.workspaceId !== workspaceId || !Array.isArray(page.servers)) throw new Error('MCP workspace response mismatch')
  return page
}

export async function readMcpConnections(workspaceId: string): Promise<McpWorkspacePage> {
  const query = new URLSearchParams({ workspaceId })
  return pageFrom(await fetch(withBasePath(`/api/integrations/mcp?${query}`), { cache: 'no-store', signal: AbortSignal.timeout(30_000) }), workspaceId)
}

export function useMcpConnections(workspaceId?: string) {
  return useSWR<McpWorkspacePage>(workspaceId ? mcpConnectionsKey(workspaceId) : null, () => readMcpConnections(workspaceId!))
}

/** The owner grants access only to the current workspace, as API-key sharing does. */
export function McpConnections({ workspaceId, workspaceName, read }: {
  workspaceId: string; workspaceName?: string; read: SWRResponse<McpWorkspacePage>;
}) {
  const t = useTranslations('Settings.mcpConnections')
  const commonT = useTranslations('Common')
  const [sharing, setSharing] = useState<McpWorkspaceServerView | null>(null)
  const [pending, setPending] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null)
  const page = read.data
  const blocked = pending || Boolean(read.error) || unconfirmed !== null

  async function check() {
    setPending(true)
    try {
      const current = await readMcpConnections(workspaceId)
      await read.mutate(current, { revalidate: false })
      setUnconfirmed(null)
    } catch { /* Keep the existing read/uncertain-state error until a real read succeeds. */ }
    finally { setPending(false) }
  }

  async function share(server: McpWorkspaceServerView, shared: boolean) {
    if (!server.mine || !page?.canShare || blocked) return
    setPending(true)
    try {
      const response = await fetch(withBasePath('/api/integrations/mcp/shares'), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ serverId: server.id, workspaceId, shared }),
      })
      const current = await pageFrom(response, workspaceId)
      await read.mutate(current, { revalidate: false })
      setUnconfirmed(null)
    } catch { setUnconfirmed(server.id) }
    finally { setPending(false); setSharing(null) }
  }

  if (!page && !read.error) return <SettingsLoading label={t('loading')} rows={1} />
  return <div className="flex flex-col gap-3">
    {(read.error || unconfirmed) && <SettingsSaveError message={t(unconfirmed ? 'shareUnconfirmed' : 'loadFailed')}
      retryLabel={t('checkAgain')} onRetry={() => { if (!pending) void check() }} />}
    {page && page.servers.length > 0 && <SettingsSection id="custom-mcp-heading" title={t('title')}>
      {page.servers.map(server => <div key={server.id} data-mcp-server-id={server.id}>
        <SettingRow icon={<AppTile app="mcp" dim={!server.enabled} />} title={server.name}
          description={!server.mine ? <span className="inline-flex items-center gap-1.5"><UserRound aria-hidden="true" className="size-3.5 shrink-0" />{t('sharedBy', { name: server.ownerName ?? t('member') })}</span> : undefined}>
          <div className="flex flex-wrap items-center gap-3">
            {!server.enabled && <Badge variant="secondary">{t('paused')}</Badge>}
            {unconfirmed === server.id ? <Badge variant="secondary">{t('unconfirmed')}</Badge> : server.mine && !page.canShare ? <span className="text-xs text-muted-foreground">{t(server.shared ? 'sharedReadOnly' : 'onlyYou')}</span> : null}
            {server.mine && page.canShare && <Label className="flex min-h-10 items-center gap-2 font-normal text-muted-foreground">
              {t('share')}
              <Switch aria-label={t('shareLabel', { name: server.name })} checked={server.shared} disabled={blocked}
                onCheckedChange={checked => { if (checked) setSharing(server); else void share(server, false) }} />
            </Label>}
          </div>
        </SettingRow>
      </div>)}
    </SettingsSection>}
    <AlertDialog open={sharing !== null} onOpenChange={open => { if (!open && !pending) setSharing(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('confirmTitle', { name: sharing?.name ?? '', workspace: workspaceName ?? t('currentWorkspace') })}</AlertDialogTitle>
          <AlertDialogDescription>{t('confirmAuthority')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{commonT('cancel')}</AlertDialogCancel>
          <AlertDialogAction disabled={pending || Boolean(read.error)} onClick={() => { if (sharing) void share(sharing, true) }}>{t('confirmShare')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}
