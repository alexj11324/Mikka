'use client'

import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group'
import { Field, FieldLabel, FieldGroup } from '@/components/ui/field'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { WORKSPACE_NAME, WORKSPACE_SLUG } from '@/components/workspace/issue-properties'

export function WorkspaceSettings() {
  const [name, setName] = useState(WORKSPACE_NAME)
  const [slug, setSlug] = useState(WORKSPACE_SLUG)
  const [host, setHost] = useState('')
  useEffect(() => { setHost(window.location.host) }, [])
  const invalidSlug = !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 48
  return <section className="flex flex-col gap-4" aria-label="工作区基本信息">
    <FieldGroup className="gap-0 rounded-xl border bg-muted/30 px-5">
      <Field orientation="responsive" className="justify-between gap-3 py-5">
        <FieldLabel htmlFor="workspace-name" className="@md/field-group:flex-none">名称</FieldLabel>
        <div className="min-w-0 @md/field-group:flex-[0_1_28rem]">
          <Input id="workspace-name" value={name} maxLength={100} onChange={event => setName(event.target.value)} />
        </div>
      </Field>
      <Separator />
      <Field orientation="responsive" data-invalid={invalidSlug || undefined} className="justify-between gap-3 py-5">
        <FieldLabel htmlFor="workspace-url" className="@md/field-group:flex-none">URL</FieldLabel>
        <div className="flex min-w-0 flex-col gap-2 @md/field-group:flex-[0_1_28rem]">
          <InputGroup>
            <InputGroupInput id="workspace-url" className="min-w-24" aria-describedby="workspace-url-help" aria-invalid={invalidSlug} value={slug} maxLength={48} autoCapitalize="none" spellCheck={false} onChange={event => setSlug(event.target.value)} />
            <InputGroupAddon className="min-w-0 max-w-[calc(100%-6rem)] shrink-0"><InputGroupText className="block truncate" title={`${host}/`}>{host}/</InputGroupText></InputGroupAddon>
          </InputGroup>
          {invalidSlug && <p role="alert" className="text-xs text-destructive">使用小写字母、数字和单个连字符，不能以连字符开头或结尾。</p>}
        </div>
      </Field>
    </FieldGroup>
    <p id="workspace-url-help" className="text-xs text-muted-foreground">URL 中的标识用于访问工作区。修改地址会影响现有链接。</p>
    <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p role="status" className="text-xs text-muted-foreground">表单预览：尚未连接工作区存储，修改不会保存。</p>
      <Button disabled>保存更改</Button>
    </div>
  </section>
}
