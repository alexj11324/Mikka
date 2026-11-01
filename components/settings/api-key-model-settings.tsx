'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { addApiKeyModel, listApiKeyModels, removeApiKeyModel } from '@/app/actions/workspace-secrets'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel, FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useActionError } from '@/lib/use-action-error'

/**
 * A workspace API-key model (an OpenAI-compatible endpoint + key). Once added it
 * appears in every bot's model menu, the Coordinator included, and runs on this
 * key. The key is write-only: only the last four digits are ever shown.
 */
export function ApiKeyModelSettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.secrets.apiKeyModels')
  const actionError = useActionError()
  const { data, mutate } = useSWR(['settings:api-key-models', workspaceId], () => listApiKeyModels(workspaceId))
  const [baseURL, setBaseURL] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const list = data && !data.error ? data.models : []

  async function add() {
    setPending(true)
    setError(null)
    try {
      const result = await addApiKeyModel(
        { baseURL: baseURL.trim(), apiKey: apiKey.trim(), models: models.split(',').map(value => value.trim()).filter(Boolean) },
        workspaceId,
      )
      if (result.error) { setError(actionError(result.error)); return }
      setBaseURL(''); setApiKey(''); setModels('')
      await mutate()
    } catch { setError(actionError()) } finally { setPending(false) }
  }

  async function remove(connectionId: string) {
    await removeApiKeyModel({ connectionId }, workspaceId)
    await mutate()
  }

  const ready = Boolean(baseURL.trim() && apiKey.trim() && models.trim())
  return <section className="flex flex-col gap-3">
    <h3 className="text-sm font-medium">{t('heading')}</h3>
    {list.map(model => <div key={model.connectionId} className="flex items-center justify-between gap-3 text-sm">
      <span className="truncate text-muted-foreground">{model.baseURL} · {model.models.join(', ')}{model.last4 ? ` · ····${model.last4}` : ''}</span>
      <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => void remove(model.connectionId)}>{t('remove')}</Button>
    </div>)}
    <form onSubmit={event => { event.preventDefault(); if (ready && !pending) void add() }}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="api-key-base-url">{t('baseURL')}</FieldLabel>
          <Input id="api-key-base-url" value={baseURL} placeholder="https://api.deepseek.com/v1" onChange={event => setBaseURL(event.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="api-key-value">{t('key')}</FieldLabel>
          <Input id="api-key-value" type="password" autoComplete="off" value={apiKey} onChange={event => setApiKey(event.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="api-key-models">{t('models')}</FieldLabel>
          <Input id="api-key-models" value={models} placeholder="deepseek-chat" onChange={event => setModels(event.target.value)} />
        </Field>
        {error && <FieldError>{error}</FieldError>}
      </FieldGroup>
      <Button type="submit" className="mt-3" disabled={pending || !ready}>{pending ? t('adding') : t('add')}</Button>
    </form>
  </section>
}
