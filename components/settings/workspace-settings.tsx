'use client'

import { useWorkspace } from '@/hooks/use-workspace'
import { Input } from '@/components/ui/input'
import { Field, FieldLabel, FieldGroup } from '@/components/ui/field'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

export function WorkspaceSettings({ userKey, workspaceId }: { userKey: string; workspaceId?: string }) {
  const { data, error, mutate } = useWorkspace(userKey, workspaceId)
  if (!data && error) return <div role="alert" className="flex flex-col items-start gap-3"><p>工作区信息加载失败。</p><Button variant="outline" onClick={() => void mutate()}>重试</Button></div>
  if (!data) return <Skeleton className="h-40 w-full" />
  return <section className="flex flex-col gap-4" aria-label="工作区基本信息">
    <FieldGroup className="gap-0 rounded-xl border bg-muted/30 px-5">
      <Field orientation="responsive" className="justify-between gap-3 py-5"><FieldLabel htmlFor="workspace-name">名称</FieldLabel><Input id="workspace-name" value={data.workspace.name} readOnly /></Field>
      <Field orientation="responsive" className="justify-between gap-3 py-5"><FieldLabel htmlFor="workspace-id">工作区 ID</FieldLabel><Input id="workspace-id" value={data.workspace.id} readOnly /></Field>
    </FieldGroup>
    <p className="text-sm text-muted-foreground">当前工作区信息为只读。切换或新建工作区，请返回应用后点击左上角的工作区名称。</p>
  </section>
}
