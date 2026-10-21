'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group'
import { Field, FieldLabel, FieldGroup } from '@/components/ui/field'
import { WORKSPACE_NAME, WORKSPACE_SLUG } from '@/components/workspace/issue-properties'

export function WorkspaceSettings() {
  const t = useTranslations('Settings.workspaceForm')
  const [name, setName] = useState(WORKSPACE_NAME)
  const [slug, setSlug] = useState(WORKSPACE_SLUG)
  const [host, setHost] = useState('')
  useEffect(() => { setHost(window.location.host) }, [])
  const invalidSlug = !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 48
  return <section className="flex flex-col gap-4" aria-label={t('label')}>
    <FieldGroup className="gap-0 rounded-xl border bg-card px-5">
      <Field orientation="responsive" className="justify-between gap-3 py-5">
        <FieldLabel htmlFor="workspace-name" className="@md/field-group:flex-none">{t('name')}</FieldLabel>
        <div className="min-w-0 @md/field-group:flex-[0_1_28rem]">
          <Input id="workspace-name" value={name} maxLength={100} onChange={event => setName(event.target.value)} />
        </div>
      </Field>
      <Field orientation="responsive" data-invalid={invalidSlug || undefined} className="justify-between gap-3 py-5">
        <FieldLabel htmlFor="workspace-url" className="@md/field-group:flex-none">URL</FieldLabel>
        <div className="flex min-w-0 flex-col gap-2 @md/field-group:flex-[0_1_28rem]">
          <InputGroup>
            <InputGroupInput id="workspace-url" className="min-w-24" aria-describedby="workspace-url-help" aria-invalid={invalidSlug} value={slug} maxLength={48} autoCapitalize="none" spellCheck={false} onChange={event => setSlug(event.target.value)} />
            <InputGroupAddon className="min-w-0 max-w-[calc(100%-6rem)] shrink-0"><InputGroupText className="block truncate" title={`${host}/`}>{host}/</InputGroupText></InputGroupAddon>
          </InputGroup>
          {invalidSlug && <p role="alert" className="text-xs text-destructive">{t('invalidSlug')}</p>}
        </div>
      </Field>
    </FieldGroup>
    <p id="workspace-url-help" className="text-xs text-muted-foreground">{t('urlHelp')}</p>
    <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p role="status" className="text-xs text-muted-foreground">{t('previewNote')}</p>
      <span className="text-xs text-muted-foreground">{t('previewLabel')}</span>
    </div>
  </section>
}
