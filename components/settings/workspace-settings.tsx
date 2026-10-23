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
    <FieldGroup data-settings-card className="gap-0 divide-y overflow-hidden rounded-2xl border bg-card">
      <Field orientation="responsive" className="justify-between gap-3 px-5 py-5"><FieldLabel htmlFor="workspace-name" className="@md/field-group:flex-none">{t('name')}</FieldLabel><div className="min-w-0 @md/field-group:flex-[0_1_28rem]"><Input id="workspace-name" value={data.workspace.name} readOnly /></div></Field>
      <Field orientation="responsive" className="justify-between gap-3 px-5 py-5"><FieldLabel htmlFor="workspace-id" className="@md/field-group:flex-none">{t('id')}</FieldLabel><div className="min-w-0 @md/field-group:flex-[0_1_28rem]"><Input id="workspace-id" value={data.workspace.id} readOnly /></div></Field>
    </FieldGroup>
    <p className="text-sm text-muted-foreground">{t('readOnlyNote')}</p>
  </section>
}
