'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronRight, SquareUserRound, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { saveTeam } from '@/app/actions/teams'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel, FieldDescription } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Spinner } from '@/components/ui/spinner'

type Team = { id: string; name: string; identifier: string; description: string }
export function TeamForm({ workspaceId, team, onClose, onSaved }: { workspaceId: string; team?: Team; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(team?.name ?? '')
  const [identifier, setIdentifier] = useState(team?.identifier ?? '')
  const [description, setDescription] = useState(team?.description ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  const dirty = name !== (team?.name ?? '') || identifier !== (team?.identifier ?? '') || description !== (team?.description ?? '')
  useEffect(() => {
    if (!dirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty])
  function close() { if (!busy.current && (!dirty || window.confirm('放弃尚未保存的团队修改？'))) onClose() }
  async function submit() {
    if (busy.current) return
    busy.current = true; setPending(true); setError('')
    try {
      const result = await saveTeam({ id: team?.id, workspaceId, name, identifier, description })
      if (!result.ok) { setError(result.error); return }
      onSaved()
    } catch { setError('保存失败，输入已保留，请重试。') }
    finally { busy.current = false; setPending(false) }
  }
  return <Dialog open onOpenChange={value => { if (!value) close() }}><DialogContent showCloseButton={false} className="flex max-h-[88svh] max-w-[calc(100%-1.5rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-card p-0 shadow-2xl sm:max-w-2xl">
    <DialogHeader className="flex-row items-center justify-between gap-3 px-5 pt-5 sm:px-7"><div className="flex items-center gap-2"><Badge variant="outline" className="gap-1.5 rounded-full px-2 py-1 font-normal"><SquareUserRound className="text-info-foreground" />团队</Badge><ChevronRight className="size-3 text-muted-foreground" /><DialogTitle className="text-sm font-normal">{team ? '编辑团队' : '创建公开团队'}</DialogTitle></div><Button type="button" variant="ghost" size="icon-sm" aria-label="关闭团队编辑器" disabled={pending} onClick={close}><X data-icon="inline-start" /></Button><DialogDescription className="sr-only">填写团队名称、标识和简介。公开范围仅限当前工作区的启用成员，不公开到互联网。</DialogDescription></DialogHeader>
    <form className="flex min-h-0 flex-col" onSubmit={event => { event.preventDefault(); void submit() }} onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.requestSubmit() } }}>
      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 pt-6 pb-5 sm:px-7"><span className="flex size-10 items-center justify-center rounded-lg bg-info text-info-foreground"><SquareUserRound className="size-6" aria-hidden="true" /></span><FieldGroup><Field className="gap-0"><FieldLabel className="sr-only" htmlFor="team-name">团队名称</FieldLabel><Input id="team-name" autoFocus required maxLength={100} value={name} onChange={event => setName(event.target.value)} disabled={pending} placeholder="团队名称" className="h-10 rounded-none border-0 bg-transparent! px-0 text-2xl font-semibold shadow-none md:text-2xl focus-visible:ring-0" /></Field><Field><FieldLabel htmlFor="team-identifier">团队标识</FieldLabel><Input id="team-identifier" required maxLength={12} pattern="[A-Z][A-Z0-9]{1,11}" value={identifier} onChange={event => setIdentifier(event.target.value.toUpperCase())} disabled={pending} placeholder="例如：DESIGN" /><FieldDescription>2–12 位大写字母或数字，以字母开头，在工作区内唯一。</FieldDescription></Field><Field><FieldLabel htmlFor="team-description">团队简介</FieldLabel><Textarea id="team-description" maxLength={500} rows={3} value={description} onChange={event => setDescription(event.target.value)} disabled={pending} placeholder="这个团队负责什么？" /></Field></FieldGroup><p className="text-xs text-muted-foreground">公开团队 · 仅当前工作区成员可访问</p>{error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}</div>
      <DialogFooter className="items-center px-5 py-4 sm:px-7"><span className="mr-auto hidden text-xs text-muted-foreground sm:inline">⌘ / Ctrl + Enter {team ? '保存' : '创建'}</span><Button type="button" variant="ghost" className="rounded-full" onClick={close} disabled={pending}>取消</Button><Button type="submit" className="rounded-full bg-project-action px-4 text-project-action-foreground hover:bg-project-action/90" disabled={pending || !name.trim() || !identifier.trim()}>{pending && <Spinner data-icon="inline-start" />}{team ? '保存团队' : '创建团队'}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>
}
