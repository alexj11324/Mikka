'use client'

import { useRef, useState } from 'react'
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
  function close() { if (!busy.current && ((name === (team?.name ?? '') && identifier === (team?.identifier ?? '') && description === (team?.description ?? '')) || window.confirm('放弃尚未保存的团队修改？'))) onClose() }
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
  return <Dialog open onOpenChange={value => { if (!value) close() }}><DialogContent><DialogHeader><DialogTitle>{team ? '编辑团队' : '创建公开团队'}</DialogTitle><DialogDescription>公开范围仅限此工作区的启用成员，不会公开到互联网。</DialogDescription></DialogHeader><form className="flex flex-col gap-6" onSubmit={event => { event.preventDefault(); void submit() }}><FieldGroup>
    <Field><FieldLabel htmlFor="team-name">团队名称</FieldLabel><Input id="team-name" autoFocus required maxLength={100} value={name} onChange={event => setName(event.target.value)} disabled={pending} placeholder="例如：产品设计" /></Field>
    <Field><FieldLabel htmlFor="team-identifier">团队标识</FieldLabel><Input id="team-identifier" required maxLength={12} pattern="[A-Z][A-Z0-9]{1,11}" value={identifier} onChange={event => setIdentifier(event.target.value.toUpperCase())} disabled={pending} placeholder="例如：DESIGN" /><FieldDescription>2–12 位大写字母或数字，以字母开头，在工作区内唯一。</FieldDescription></Field>
    <Field><FieldLabel htmlFor="team-description">团队简介</FieldLabel><Textarea id="team-description" maxLength={500} rows={3} value={description} onChange={event => setDescription(event.target.value)} disabled={pending} placeholder="这个团队负责什么？" /></Field>
  </FieldGroup>{error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}<DialogFooter><Button type="button" variant="outline" onClick={close} disabled={pending}>取消</Button><Button type="submit" disabled={pending || !name.trim() || !identifier.trim()}>{pending && <Spinner data-icon="inline-start" />}{team ? '保存团队' : '创建团队'}</Button></DialogFooter></form></DialogContent></Dialog>
}
