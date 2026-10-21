'use client'

import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { acceptWorkspaceInvitation, createWorkspace } from '@/app/actions/workspace'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export function WorkspaceAccessDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>, mode: 'create' | 'join') {
    event.preventDefault()
    if (pending) return
    const form = new FormData(event.currentTarget)
    setPending(true)
    setError('')
    try {
      const value = String(form.get(mode === 'create' ? 'name' : 'invitation')).trim()
      let token = value
      if (mode === 'join' && !/^[a-f0-9]{64}$/.test(token)) {
        const url = new URL(value, window.location.origin)
        if (url.origin !== window.location.origin || !/^\/invite\/[a-f0-9]{64}$/.test(url.pathname)) throw new Error('请粘贴本站的有效工作区邀请链接。')
        token = url.pathname.split('/').pop()!
      }
      const result = mode === 'create' ? await createWorkspace(value) : await acceptWorkspaceInvitation(token)
      if (!result.ok) { setError(result.error); return }
      toast.success(mode === 'create' ? '工作区已创建' : '已加入工作区')
      window.location.assign('/')
    } catch (cause) {
      setError(cause instanceof TypeError ? '请粘贴有效的工作区邀请链接。' : cause instanceof Error ? cause.message : '操作失败，请重试。')
    } finally { setPending(false) }
  }
  return <Dialog open={open} onOpenChange={value => { if (!pending) { onOpenChange(value); setError('') } }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>创建或加入工作区</DialogTitle>
        <DialogDescription>创建新的工作空间，或使用受邀邮箱加入已有工作区。</DialogDescription>
      </DialogHeader>
      <Tabs defaultValue="create" onValueChange={() => setError('')}>
        <TabsList className="w-full"><TabsTrigger value="create" disabled={pending}>创建工作区</TabsTrigger><TabsTrigger value="join" disabled={pending}>加入工作区</TabsTrigger></TabsList>
        <TabsContent value="create">
          <form className="flex flex-col gap-5 pt-4" onSubmit={event => void submit(event, 'create')} aria-busy={pending}>
            <FieldGroup><Field><FieldLabel htmlFor="new-workspace-name">工作区名称</FieldLabel><Input id="new-workspace-name" name="name" required maxLength={120} placeholder="例如：产品研发" disabled={pending} /></Field></FieldGroup>
            <Button type="submit" disabled={pending}>{pending ? '正在创建…' : '创建工作区'}</Button>
          </form>
        </TabsContent>
        <TabsContent value="join">
          <form className="flex flex-col gap-5 pt-4" onSubmit={event => void submit(event, 'join')} aria-busy={pending}>
            <FieldGroup><Field><FieldLabel htmlFor="workspace-invitation">邀请链接</FieldLabel><Input id="workspace-invitation" name="invitation" required maxLength={2048} placeholder="粘贴管理员分享的邀请链接" disabled={pending} /><p className="text-xs text-muted-foreground">邀请邮箱必须与当前登录邮箱一致；工作区不会公开列出。</p></Field></FieldGroup>
            <Button type="submit" disabled={pending}>{pending ? '正在加入…' : '加入工作区'}</Button>
          </form>
        </TabsContent>
      </Tabs>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </DialogContent>
  </Dialog>
}
