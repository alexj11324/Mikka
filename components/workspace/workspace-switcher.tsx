'use client'

import { useState } from 'react'
import { Check, ChevronDown, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useWorkspace } from '@/hooks/use-workspace'
import { createWorkspace, switchWorkspace } from '@/app/actions/workspace'
import { SidebarMenuButton, useSidebar } from '@/components/ui/sidebar'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

export function WorkspaceSwitcher({ userKey, canLeave }: { userKey: string; canLeave: () => Promise<boolean> }) {
  const { data, error: loadError, mutate } = useWorkspace(userKey)
  const { setOpenMobile } = useSidebar()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function select(id: string) {
    if (busy || id === data?.workspace.id || !await canLeave()) return
    setBusy(true)
    try {
      const result = await switchWorkspace(id)
      if (!result.ok) throw new Error(result.error)
      await mutate()
      setOpenMobile(false)
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : '切换失败，请重试。') }
    finally { setBusy(false) }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !name.trim() || !await canLeave()) return
    setBusy(true); setError('')
    try {
      const result = await createWorkspace(name)
      if (!result.ok) throw new Error(result.error)
      await mutate()
      setCreating(false); setName(''); setOpenMobile(false)
      toast.success('工作区已创建，已自动进入。')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '创建失败，请重试。') }
    finally { setBusy(false) }
  }

  return <>
    <DropdownMenu>
      <DropdownMenuTrigger disabled={busy} render={<SidebarMenuButton aria-label="工作区菜单" className="min-h-11" />}>
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground">{data?.workspace.name.slice(0, 1).toUpperCase() || 'O'}</span>
        <span className="min-w-0 flex-1 truncate font-semibold">{busy ? '正在切换…' : data?.workspace.name || (loadError ? '工作区加载失败' : '正在加载工作区…')}</span><ChevronDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-2rem)]">
        <DropdownMenuGroup>
          <DropdownMenuLabel>切换工作区</DropdownMenuLabel>
          {data?.choices.map(workspace => <DropdownMenuItem className="min-h-11" key={workspace.id} onClick={() => void select(workspace.id)} aria-current={workspace.id === data.workspace.id ? 'true' : undefined}>
            <span className="min-w-0 flex-1 truncate">{workspace.name}</span>{workspace.id === data.workspace.id && <Check />}
          </DropdownMenuItem>)}
          {loadError && <DropdownMenuItem className="min-h-11" onClick={() => void mutate()}>重新加载工作区</DropdownMenuItem>}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup><DropdownMenuItem className="min-h-11" onClick={() => { setError(''); setCreating(true) }}><Plus />新建工作区</DropdownMenuItem></DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={creating} onOpenChange={open => { if (!busy) setCreating(open) }}>
      <DialogContent><DialogHeader><DialogTitle>新建工作区</DialogTitle><DialogDescription>创建后自动进入，你将成为工作区管理员。</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <FieldGroup><Field data-invalid={!!error || undefined}><FieldLabel htmlFor="new-workspace-name">工作区名称</FieldLabel><Input id="new-workspace-name" autoFocus required maxLength={120} placeholder="例如：产品团队" value={name} disabled={busy} aria-invalid={!!error} onChange={event => setName(event.target.value)} /></Field></FieldGroup>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setCreating(false)}>取消</Button><Button type="submit" disabled={busy || !name.trim()}>{busy ? '正在创建…' : '创建工作区'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </>
}
