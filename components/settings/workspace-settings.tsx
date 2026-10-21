'use client'

import { useTranslations } from 'next-intl'
import { useWorkspace } from '@/hooks/use-workspace'
import { Input } from '@/components/ui/input'
import { Field, FieldLabel, FieldGroup } from '@/components/ui/field'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

export function WorkspaceSettings({ userKey, workspaceId }: { userKey: string; workspaceId?: string }) {
  const t = useTranslations('Settings.workspaceForm')
  const commonT = useTranslations('Common')
  const membersT = useTranslations('Members')
  const { data, error, mutate } = useWorkspace(userKey, workspaceId)
  if (!data && error) return <div role="alert" className="flex flex-col items-start gap-3"><p>{membersT('refreshFailed')}</p><Button variant="outline" onClick={() => void mutate()}>{commonT('retry')}</Button></div>
  if (!data) return <Skeleton className="h-40 w-full" />
  return <section className="flex flex-col gap-4" aria-label={t('label')}>
    <FieldGroup className="gap-0 rounded-xl border bg-muted/30 px-5">
      <Field orientation="responsive" className="justify-between gap-3 py-5"><FieldLabel htmlFor="workspace-name">{t('name')}</FieldLabel><Input id="workspace-name" value={data.workspace.name} readOnly /></Field>
      <Field orientation="responsive" className="justify-between gap-3 py-5"><FieldLabel htmlFor="workspace-id">{t('id')}</FieldLabel><Input id="workspace-id" value={data.workspace.id} readOnly /></Field>
    </FieldGroup>
    <p className="text-sm text-muted-foreground">{t('readOnlyNote')}</p>
  </section>
}
