'use client'

import { useRef, useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { createWorkspace } from '@/app/actions/workspace'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group'

export function CreateWorkspaceForm() {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError('')
    try {
      const result = await createWorkspace({ name: name.trim(), slug: slug.trim() })
      if (!result.ok) { setError(result.error); return }
      toast.success('工作区已创建')
      window.location.assign('/')
    } catch {
      setError('创建未完成，请稍后重试。')
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }
  return <form onSubmit={submit} onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault() }} aria-busy={pending} className="flex flex-col gap-8">
    <FieldGroup className="gap-6">
      <Field>
        <FieldLabel htmlFor="workspace-name">工作区名称</FieldLabel>
        <Input id="workspace-name" name="name" autoFocus autoComplete="organization" required maxLength={120} value={name} placeholder="例如：产品研发" disabled={pending} onChange={event => { const value = event.target.value; setName(value); setError(''); if (!slugEdited) setSlug(value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '')) }} />
      </Field>
      <Field>
        <FieldLabel htmlFor="workspace-slug">工作区网址</FieldLabel>
        <InputGroup>
          <InputGroupInput id="workspace-slug" name="slug" value={slug} onChange={event => { setSlugEdited(true); setSlug(event.target.value.toLowerCase()); setError('') }} required minLength={3} maxLength={64} pattern="[a-z0-9]([a-z0-9\-]{1,62}[a-z0-9])" autoCapitalize="none" autoComplete="off" spellCheck={false} aria-describedby="workspace-slug-help" title="使用 3–64 位小写字母、数字或连字符，不能以连字符开头或结尾。" placeholder="design-team" disabled={pending} />
          <InputGroupAddon><InputGroupText>/w/</InputGroupText></InputGroupAddon>
        </InputGroup>
        <FieldDescription id="workspace-slug-help">3–64 位小写字母、数字或连字符。此网址仅供工作区成员访问。</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="workspace-region">工作区数据区域</FieldLabel>
        <Input id="workspace-region" value="美国（俄亥俄州）" readOnly aria-describedby="workspace-region-help" />
        <FieldDescription id="workspace-region-help">当前连接的数据库位于此区域，暂不支持选择其他区域。</FieldDescription>
      </Field>
    </FieldGroup>
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    <Button type="submit" size="lg" disabled={pending || !name.trim() || !slug.trim()}>{pending && <Loader2 className="animate-spin" data-icon="inline-start" />}{pending ? '正在创建…' : '创建工作区'}</Button>
    <p className="text-center text-xs text-muted-foreground">加入已有工作区需要管理员邀请，不能通过网址自行加入。</p>
  </form>
}
