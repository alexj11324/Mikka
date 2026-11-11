'use client'

import { useState, type FormEvent } from 'react'
import useSWR, { type SWRResponse } from 'swr'
import { useTranslations } from 'next-intl'
import { Plus, Trash2, UserRound } from 'lucide-react'
import { withBasePath } from '@/lib/base-path'
import { settingsKeys } from '@/lib/swr/keys'
import { ReadResponseError } from '@/lib/swr/retry'
import type { McpWorkspacePage, McpWorkspaceServerView } from '@/lib/plugins/contracts'
import { AppTile } from '@/components/plugins/connected-apps'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection, settingsSectionAction } from '@/components/settings/primitives'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { mcpServerInput, type McpCreateInput, type McpServerDraft } from './mcp-server-draft'

export const mcpConnectionsKey = settingsKeys.mcpConnections

async function pageFrom(response: Response, workspaceId: string): Promise<McpWorkspacePage> {
  if (!response.ok) throw new ReadResponseError(response.status)
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
  const [adding, setAdding] = useState(false)
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

  async function create(input: McpCreateInput) {
    if (blocked) return
    setPending(true)
    setAdding(false)
    try {
      const response = await fetch(withBasePath('/api/integrations/mcp'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify(input),
      })
      if (!response.ok) throw new ReadResponseError(response.status)
      const current = await readMcpConnections(workspaceId)
      await read.mutate(current, { revalidate: false })
      setUnconfirmed(null)
    } catch { setUnconfirmed('create') }
    finally { setPending(false) }
  }

  if (!page && !read.error) return <SettingsLoading label={t('loading')} rows={1} />
  return <div className="flex flex-col gap-3">
    {(read.error || unconfirmed) && <SettingsSaveError message={t(unconfirmed ? 'shareUnconfirmed' : 'loadFailed')}
      retryLabel={t('checkAgain')} onRetry={() => { if (!pending) void check() }} />}
    {page && <SettingsSection id="custom-mcp-heading" title={t('title')}
      action={<Button {...settingsSectionAction} disabled={blocked} onClick={() => setAdding(true)}><Plus data-icon="inline-start" aria-hidden="true" />{t('add')}</Button>}>
      {page.servers.length === 0 && <SettingRow title={t('empty')} />}
      {page.servers.map(server => <div key={server.id} data-mcp-server-id={server.id}>
        <SettingRow icon={<AppTile app="mcp" dim={!server.enabled} />} title={server.name}
          description={!server.mine ? <span className="inline-flex items-center gap-1.5"><UserRound aria-hidden="true" className="size-3.5 shrink-0" />{t('sharedBy', { name: server.ownerName ?? t('member') })}</span> : undefined}>
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="secondary">{server.transport.toUpperCase()}</Badge>
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
    <Dialog open={adding} onOpenChange={open => { if (!pending) setAdding(open) }}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{t('add')}</DialogTitle></DialogHeader>
        {adding && <McpServerForm pending={pending} onCancel={() => setAdding(false)} onCreate={input => { void create(input) }} />}
      </DialogContent>
    </Dialog>
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

function McpServerForm({ pending, onCancel, onCreate }: { pending: boolean; onCancel(): void; onCreate(input: McpCreateInput): void }) {
  const t = useTranslations('Settings.mcpConnections')
  const common = useTranslations('Common')
  const [draft, setDraft] = useState<McpServerDraft>({ name: '', transport: 'http', url: '', command: '', arguments: '', cwd: '', values: [] })
  const [error, setError] = useState(false)
  const stdio = draft.transport === 'stdio'
  const change = <K extends keyof McpServerDraft>(key: K, value: McpServerDraft[K]) => { setDraft(current => ({ ...current, [key]: value })); setError(false) }
  const changeValue = (index: number, key: 'name' | 'value', value: string) => change('values', draft.values.map((row, i) => i === index ? { ...row, [key]: value } : row))

  function submit(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    try {
      const input = mcpServerInput(draft)
      // The submitted values leave the page immediately, including when a response is lost.
      change('values', [])
      onCreate(input)
    } catch { setError(true) }
  }

  return <form className="flex min-h-0 flex-col gap-4" autoComplete="off" onSubmit={submit}>
    <FieldGroup className="min-h-0 overflow-y-auto px-0.5 pb-1">
      <Field>
        <FieldLabel htmlFor="mcp-name">{t('name')}</FieldLabel>
        <Input id="mcp-name" maxLength={80} required disabled={pending} value={draft.name} onChange={event => change('name', event.target.value)} />
      </Field>
      <Field>
        <FieldLabel htmlFor="mcp-transport">{t('transport')}</FieldLabel>
        <NativeSelect id="mcp-transport" value={draft.transport} disabled={pending} onChange={event => { change('transport', event.target.value as McpServerDraft['transport']); change('values', []) }}>
          <NativeSelectOption value="http">Streamable HTTP</NativeSelectOption>
          <NativeSelectOption value="sse">SSE</NativeSelectOption>
          <NativeSelectOption value="stdio">STDIO</NativeSelectOption>
        </NativeSelect>
      </Field>
      {stdio ? <>
        <Field>
          <FieldLabel htmlFor="mcp-command">{t('command')}</FieldLabel>
          <Input id="mcp-command" autoCapitalize="off" spellCheck={false} maxLength={4096} required disabled={pending} value={draft.command} onChange={event => change('command', event.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="mcp-args">{t('arguments')}</FieldLabel>
          <Textarea id="mcp-args" autoCapitalize="off" spellCheck={false} maxLength={32768} disabled={pending} value={draft.arguments} onChange={event => change('arguments', event.target.value)} />
          <FieldDescription>{t('oneArgumentPerLine')}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="mcp-cwd">{t('cwd')}</FieldLabel>
          <Input id="mcp-cwd" autoCapitalize="off" spellCheck={false} maxLength={4096} disabled={pending} value={draft.cwd} onChange={event => change('cwd', event.target.value)} />
        </Field>
      </> : <Field>
        <FieldLabel htmlFor="mcp-url">{t('url')}</FieldLabel>
        <Input id="mcp-url" type="url" required autoCapitalize="off" spellCheck={false} maxLength={4096} disabled={pending} value={draft.url} onChange={event => change('url', event.target.value)} />
      </Field>}
      <Field>
        <FieldLabel>{t(stdio ? 'variables' : 'headers')}</FieldLabel>
        {draft.values.map((row, index) => <div className="flex items-center gap-2" key={index}>
          <Input aria-label={t('variableName', { index: index + 1 })} maxLength={128} required autoCapitalize="off" spellCheck={false} disabled={pending} value={row.name} onChange={event => changeValue(index, 'name', event.target.value)} />
          <Input aria-label={t('variableValue', { index: index + 1 })} type="password" autoComplete="new-password" maxLength={4096} required disabled={pending} value={row.value} onChange={event => changeValue(index, 'value', event.target.value)} />
          <Button type="button" size="icon-sm" variant="ghost" disabled={pending} aria-label={t('removeVariable', { index: index + 1 })} onClick={() => change('values', draft.values.filter((_, i) => i !== index))}><Trash2 aria-hidden="true" /></Button>
        </div>)}
        <Button type="button" size="sm" variant="secondary" className="self-start" disabled={pending || draft.values.length >= 32} onClick={() => change('values', [...draft.values, { name: '', value: '' }])}><Plus data-icon="inline-start" aria-hidden="true" />{t(stdio ? 'addVariable' : 'addHeader')}</Button>
        <FieldDescription>{t('taskReadable')}</FieldDescription>
      </Field>
      {error && <FieldError role="alert">{t('invalidConfiguration')}</FieldError>}
    </FieldGroup>
    <DialogFooter>
      <Button type="button" variant="secondary" disabled={pending} onClick={onCancel}>{common('cancel')}</Button>
      <Button type="submit" disabled={pending}>{t('add')}</Button>
    </DialogFooter>
  </form>
}
