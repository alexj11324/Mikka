'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, SquareUserRound } from 'lucide-react'
import { saveTeam } from '@/app/actions/teams'
import { Field, FieldContent, FieldGroup, FieldLabel, FieldDescription } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Spinner } from '@/components/ui/spinner'

type Team = { id: string; name: string; identifier: string; description: string }
export function TeamForm({ workspaceId, team, editable = true, onClose, onSaved }: { workspaceId: string; team?: Team; editable?: boolean; onClose: () => void; onSaved: (teamId: string) => void }) {
  const [name, setName] = useState(team?.name ?? '')
  const [identifier, setIdentifier] = useState(team?.identifier ?? '')
  const [description, setDescription] = useState(team?.description ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  const dirty = name !== (team?.name ?? '') || identifier !== (team?.identifier ?? '') || description !== (team?.description ?? '')
  useEffect(() => {
    if (!dirty && !pending) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault() }
    const beforeNavigate = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (!(link instanceof HTMLAnchorElement) || link.href === window.location.href || link.target === '_blank' || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      if (busy.current || !window.confirm('放弃尚未保存的团队修改？')) { event.preventDefault(); event.stopPropagation() }
    }
    window.addEventListener('beforeunload', beforeUnload)
    document.addEventListener('click', beforeNavigate, true)
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', beforeNavigate, true) }
  }, [dirty, pending])
  function close() { if (!busy.current && (!dirty || window.confirm('放弃尚未保存的团队修改？'))) onClose() }
  async function submit() {
    if (busy.current || !editable) return
    busy.current = true; setPending(true); setError('')
    try {
      const result = await saveTeam({ id: team?.id, workspaceId, name, identifier, description })
      if (!result.ok) { setError(result.error); return }
      onSaved(result.data.id)
    } catch { setError('保存失败，输入已保留，请重试。') }
    finally { busy.current = false; setPending(false) }
  }
  return <section className="flex flex-col gap-12" aria-labelledby="team-form-heading">
    <Button type="button" variant="ghost" size="sm" className="self-start" aria-label={team ? '团队设置' : '返回'} disabled={pending} onClick={close}><ChevronLeft data-icon="inline-start" /><span lang="en">{team ? 'Team settings' : 'Back'}</span></Button>
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-9 pb-12 sm:pt-1">
      <header className="flex flex-col gap-3 px-1 sm:px-4" lang="en"><h1 id="team-form-heading" className="text-2xl font-semibold tracking-tight">{team ? 'General' : 'Create a new team'}</h1><p className="text-sm leading-relaxed text-muted-foreground">{team ? `Manage the name, identifier, and description of ${team.name}.` : 'Create a new team to manage separate cycles, workflows and notifications'}</p></header>
      <form aria-label={team ? '团队常规设置' : '创建新团队'} className="flex flex-col gap-8" onSubmit={event => { event.preventDefault(); void submit() }} onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.requestSubmit() } }}>
        <FieldGroup className="gap-0 rounded-xl border bg-card px-5 py-1">
          <Field orientation="responsive" className="min-h-20 gap-5 py-5" data-disabled={pending}>
            <FieldContent><span className="text-sm text-muted-foreground" aria-hidden="true" lang="en">Icon &amp; Name</span><FieldLabel className="sr-only" htmlFor="team-name">团队名称</FieldLabel></FieldContent>
            <div className="flex items-center gap-2 @md/field-group:shrink-0"><span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground" aria-hidden="true"><SquareUserRound className="size-4" /></span><Input id="team-name" required maxLength={100} value={name} onChange={event => setName(event.target.value)} disabled={pending} readOnly={!editable} aria-label="团队名称" placeholder="e.g. Engineering" className="min-w-0 @md/field-group:w-48" /></div>
          </Field>
          <Field orientation="responsive" className="min-h-24 gap-5 py-5" data-disabled={pending}>
            <FieldContent><span className="text-sm text-muted-foreground" aria-hidden="true" lang="en">Identifier</span><FieldLabel htmlFor="team-identifier" className="sr-only">团队标识</FieldLabel><FieldDescription id="team-identifier-description"><span lang="en">Used to identify issues from this team<br /> (e.g. ENG-123)</span></FieldDescription></FieldContent>
            <Input id="team-identifier" required maxLength={12} pattern="[A-Z][A-Z0-9]{1,11}" value={identifier} onChange={event => setIdentifier(event.target.value.toUpperCase())} disabled={pending} readOnly={!editable} aria-label="团队标识" aria-describedby="team-identifier-description" title="2–12 位大写字母或数字，以字母开头" placeholder="e.g. ENG" className="min-w-0 @md/field-group:max-w-36 @md/field-group:self-center" />
          </Field>
          {team && <><Field orientation="responsive" className="gap-4 py-5" data-disabled={pending}><FieldContent><FieldLabel htmlFor="team-description">团队简介</FieldLabel><FieldDescription>介绍团队的职责与工作范围。</FieldDescription></FieldContent><Textarea id="team-description" maxLength={500} rows={3} value={description} onChange={event => setDescription(event.target.value)} disabled={pending} readOnly={!editable} placeholder="这个团队负责什么？" className="min-w-0 @md/field-group:w-64" /></Field></>}
        </FieldGroup>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="flex flex-wrap items-center justify-end gap-4">{team && <p className="mr-auto text-xs leading-relaxed text-muted-foreground">{editable ? '所有工作区启用成员均可访问，不公开到互联网。' : '仅团队负责人和工作区管理员可修改团队设置。'}</p>}{editable && <Button type="submit" className="rounded-full px-5" aria-label={team ? '保存更改' : '创建团队'} disabled={pending || !name.trim() || !identifier.trim() || (!!team && !dirty)}>{pending && <Spinner data-icon="inline-start" />}<span lang="en">{team ? 'Save changes' : 'Create team'}</span></Button>}</div>
      </form>
    </div>
  </section>
}
