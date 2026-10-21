'use client'

import { useState, type FormEvent } from 'react'
import { Copy, Loader2, Mail, UserPlus } from 'lucide-react'
import { createWorkspaceInvitation } from '@/app/actions/workspace'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

export function InviteMembersDialog({ workspaceId, open, onOpenChange, onCreated }: { workspaceId: string; open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => Promise<unknown> }) {
  const [emails, setEmails] = useState('')
  const [role, setRole] = useState('member')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [links, setLinks] = useState<{ email: string; url: string }[]>([])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true); setError(''); setNotice('')
    try {
      const result = await createWorkspaceInvitation({ workspaceId, emails: emails.split(/[\s,，;；]+/).filter(Boolean), role })
      if (!result.ok) { setError(result.error); return }
      setLinks(result.data.map(link => ({ email: link.email, url: new URL(link.path, window.location.origin).href })))
      await onCreated()
    } catch { setError('邀请未完成，请稍后重试。') }
    finally { setPending(false) }
  }
  async function copy(url: string) {
    try { await navigator.clipboard.writeText(url); setNotice('邀请链接已复制。') }
    catch { setNotice('自动复制不可用，请选中链接后手动复制。') }
  }
  return <Dialog open={open} onOpenChange={value => { if (!pending) onOpenChange(value) }}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
      <DialogHeader><DialogTitle>邀请成员</DialogTitle><DialogDescription>通过邮箱邀请同事加入工作区，一次最多邀请 20 人。</DialogDescription></DialogHeader>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {links.length ? <div className="flex flex-col gap-4">
        <Alert><Mail /><AlertTitle>邀请已创建，尚未发送邮件</AlertTitle><AlertDescription>请复制链接，私下发送给对应邮箱的成员。链接 7 天内有效，仅允许该邮箱登录后接受。</AlertDescription></Alert>
        <FieldGroup>{links.map(link => <Field key={link.email}><FieldLabel>{link.email}</FieldLabel><div className="flex gap-2"><Input aria-label={`${link.email} 的邀请链接`} value={link.url} readOnly onFocus={event => event.currentTarget.select()} /><Button variant="outline" size="icon" aria-label={`复制 ${link.email} 的邀请链接`} onClick={() => void copy(link.url)}><Copy data-icon="inline-start" /></Button></div></Field>)}</FieldGroup>
        {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
        <DialogFooter><Button onClick={() => { setLinks([]); setEmails(''); onOpenChange(false) }}>完成</Button></DialogFooter>
      </div> : <form onSubmit={submit} className="flex flex-col gap-5">
        <FieldGroup>
          <Field data-invalid={Boolean(error)}><FieldLabel htmlFor="invite-emails">邮箱地址</FieldLabel><Textarea id="invite-emails" value={emails} onChange={event => setEmails(event.target.value)} placeholder="同事的邮箱，使用逗号或换行分隔" rows={4} required maxLength={5200} disabled={pending} aria-invalid={Boolean(error)} /><FieldDescription>邀请绑定邮箱；重新邀请会使该邮箱此前的邀请链接失效。</FieldDescription></Field>
          <Field><FieldLabel htmlFor="invite-role">工作区角色</FieldLabel><Select value={role} onValueChange={value => setRole(value ?? 'member')} disabled={pending} items={[{ value: 'member', label: '成员' }, { value: 'admin', label: '管理员' }]}><SelectTrigger id="invite-role" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="member">成员</SelectItem><SelectItem value="admin">管理员</SelectItem></SelectGroup></SelectContent></Select><FieldDescription>管理员可邀请成员、调整角色和停用成员；成员可查看成员目录。</FieldDescription></Field>
        </FieldGroup>
        <Alert><Mail /><AlertDescription>当前未接入邮件服务。创建后将提供真实邀请链接，不会自动发送邮件。</AlertDescription></Alert>
        <DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={pending || !emails.trim()}>{pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <UserPlus data-icon="inline-start" />}{pending ? '正在创建…' : '创建邀请链接'}</Button></DialogFooter>
      </form>}
    </DialogContent>
  </Dialog>
}
