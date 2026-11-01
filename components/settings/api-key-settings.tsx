'use client'

import { useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { KeyRound } from 'lucide-react'
import { createApiKey, deleteApiKey, getApiKeys, updateApiKeyAfterQuota, updateApiKeyShare } from '@/app/actions/model-api-keys'
import { SettingRow, SettingsSaveError, SettingsSection, settingsSectionAction } from '@/components/settings/primitives'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Claude } from '@/components/ui/svgs/claude'
import { OpenAI } from '@/components/ui/svgs/openai'
import { API_KEY_PRESETS, type ApiKeyProtocol, type ApiKeyProvider, type ApiKeyView } from '@/lib/model-api-key-providers'
import { useActionError } from '@/lib/use-action-error'

type Key = ApiKeyView & { shared: boolean }
const providers = [...API_KEY_PRESETS, 'custom'] as const

export const apiKeysKey = (workspaceId: string) => ['settings:api-keys', workspaceId] as const

function ProviderIcon({ provider }: { provider: ApiKeyProvider }) {
  if (provider === 'anthropic') return <Claude className="size-5 shrink-0 text-brand-claude" />
  if (provider === 'openai') return <OpenAI className="size-5 shrink-0 text-foreground" />
  return <KeyRound aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
}

/**
 * 「API 与订阅」's API keys and custom providers (orchestration.md § 1, C22):
 * rows that sit in the same list as the subscriptions, the 添加 API Key
 * action for that list, and the account's 订阅额度用完后，自动改用 API Key
 * switch. Keys are write-only: a row shows the last four characters only.
 */
export function useApiKeyList(workspaceId: string) {
  const t = useTranslations('Settings.apiKeys')
  const shareT = useTranslations('Settings.subscriptionShare')
  const commonT = useTranslations('Common')
  const actionError = useActionError()
  const keys = useSWR(apiKeysKey(workspaceId), () => getApiKeys(workspaceId))
  const [adding, setAdding] = useState(false)
  const [sharing, setSharing] = useState<Key | null>(null)
  const [removing, setRemoving] = useState<Key | null>(null)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState<{ message: string; retry: () => void } | null>(null)
  const data = keys.data && !keys.data.error ? keys.data : null
  const title = (key: Pick<ApiKeyView, 'provider' | 'name'>) => key.provider === 'custom' ? key.name ?? t('provider.custom') : t(`provider.${key.provider}`)

  async function share(key: Key, shared: boolean) {
    setPending(true); setFailed(null)
    try {
      const result = await updateApiKeyShare({ id: key.id, shared }, workspaceId)
      if (result.error) { setFailed({ message: actionError(result.error), retry: () => void share(key, shared) }); return }
      await keys.mutate(result, { revalidate: false })
    } catch { setFailed({ message: actionError(), retry: () => void share(key, shared) }) } finally { setPending(false); setSharing(null) }
  }
  async function remove(key: Key) {
    setPending(true); setFailed(null)
    try {
      const result = await deleteApiKey(key.id, workspaceId)
      if (result.error) { setFailed({ message: actionError(result.error), retry: () => void remove(key) }); return }
      await keys.mutate()
    } catch { setFailed({ message: actionError(), retry: () => void remove(key) }) } finally { setPending(false); setRemoving(null) }
  }

  const rows: ReactNode[] = (data?.keys ?? []).map(key => <SettingRow key={key.id} icon={<ProviderIcon provider={key.provider} />} title={title(key)}
    description={`${key.baseUrl ? new URL(key.baseUrl).host : t('apiKey')} · ••••${key.last4}`}>
    <span className="flex items-center gap-4">
      {data?.canShare && <Label className="flex items-center gap-2 font-normal text-muted-foreground">
        {shareT('others')}
        <Switch aria-label={t('shareLabel', { name: title(key) })} checked={key.shared} disabled={pending}
          onCheckedChange={checked => { if (checked) setSharing(key); else void share(key, false) }} />
      </Label>}
      <Button type="button" variant="ghost" size="sm" disabled={pending} aria-label={t('removeLabel', { name: title(key) })} onClick={() => setRemoving(key)}>{commonT('delete')}</Button>
    </span>
  </SettingRow>)
  if (keys.data?.error) rows.push(<div key="error" className="px-5 py-4"><FieldError>{actionError(keys.data.error)}</FieldError></div>)

  const action = <Button type="button" {...settingsSectionAction} disabled={!data} onClick={() => setAdding(true)}>{t('add')}</Button>
  const dialogs = <>
    {failed && <SettingsSaveError message={failed.message} retryLabel={commonT('retry')} onRetry={failed.retry} />}
    {adding && <AddApiKeyDialog workspaceId={workspaceId} onClose={async added => { setAdding(false); if (added) await keys.mutate() }} />}
    <AlertDialog open={sharing !== null} onOpenChange={open => { if (!open && !pending) setSharing(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{shareT('othersTitle', { name: sharing ? title(sharing) : '' })}</AlertDialogTitle>
          <AlertDialogDescription render={<div />}>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-left">
              <li>{t('othersUsage')}</li>
              <li>{shareT('othersRuntime')}</li>
              <li>{shareT('othersTrust')}</li>
            </ul>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{shareT('cancel')}</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={() => { if (sharing) void share(sharing, true) }}>{shareT('othersConfirm')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={removing !== null} onOpenChange={open => { if (!open && !pending) setRemoving(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{t('removeTitle', { name: removing ? title(removing) : '' })}</AlertDialogTitle></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{commonT('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={() => { if (removing) void remove(removing) }}>{commonT('delete')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
  return { rows, action, dialogs }
}

/** 订阅额度用完后，自动改用 API Key: on by default (orchestration.md § 2). */
export function ApiKeyFallbackSetting({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.apiKeys')
  const commonT = useTranslations('Common')
  const actionError = useActionError()
  const keys = useSWR(apiKeysKey(workspaceId), () => getApiKeys(workspaceId))
  const [failed, setFailed] = useState<{ on: boolean; message: string } | null>(null)
  const data = keys.data && !keys.data.error ? keys.data : null
  async function save(on: boolean) {
    setFailed(null)
    try {
      const result = await updateApiKeyAfterQuota(on, workspaceId)
      if (result.error) { setFailed({ on, message: actionError(result.error) }); return }
      await keys.mutate(result, { revalidate: false })
    } catch { setFailed({ on, message: actionError() }) }
  }
  if (!data) return null
  return <>
    <SettingsSection>
      <SettingRow title={t('afterQuota')} description={t('afterQuotaBilling')}>
        <Switch aria-label={t('afterQuota')} checked={data.apiKeyAfterQuota} onCheckedChange={on => void save(on)} />
      </SettingRow>
    </SettingsSection>
    {failed && <SettingsSaveError message={failed.message} retryLabel={commonT('retry')} onRetry={() => void save(failed.on)} />}
  </>
}

function AddApiKeyDialog({ workspaceId, onClose }: { workspaceId: string; onClose: (added: boolean) => void }) {
  const t = useTranslations('Settings.apiKeys')
  const commonT = useTranslations('Common')
  const actionError = useActionError()
  const [provider, setProvider] = useState<ApiKeyProvider>('anthropic')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [protocol, setProtocol] = useState<ApiKeyProtocol>('openai')
  const [models, setModels] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const custom = provider === 'custom'
  const ready = apiKey.trim() && (!custom || (name.trim() && baseUrl.trim()))
  const providerItems = providers.map(value => ({ value, label: t(`provider.${value}`) }))
  const protocolItems = (['openai', 'anthropic'] as const).map(value => ({ value, label: t(`protocol.${value}`) }))

  async function save() {
    setPending(true); setError(null)
    const list = models.split(/[\s,，]+/).map(item => item.trim()).filter(Boolean)
    try {
      const result = await createApiKey(custom
        ? { provider, name: name.trim(), baseUrl: baseUrl.trim(), protocol, apiKey: apiKey.trim(), ...(list.length ? { models: list } : {}) }
        : { provider, apiKey: apiKey.trim() }, workspaceId)
      if (result.error) { setError(actionError(result.error)); return }
      onClose(true)
    } catch { setError(actionError()) } finally { setPending(false) }
  }

  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose(false) }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{t('add')}</DialogTitle></DialogHeader>
      <form onSubmit={event => { event.preventDefault(); if (ready && !pending) void save() }}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="api-key-provider">{t('providerLabel')}</FieldLabel>
            <Select value={provider} items={providerItems} onValueChange={next => { if (providers.includes(next as never)) setProvider(next as ApiKeyProvider) }}>
              <SelectTrigger id="api-key-provider" aria-label={t('providerLabel')} className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{providerItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </Field>
          {custom && <>
            <Field>
              <FieldLabel htmlFor="api-key-name">{t('name')}</FieldLabel>
              <Input id="api-key-name" value={name} maxLength={60} autoComplete="off" onChange={event => setName(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="api-key-base-url">Base URL</FieldLabel>
              <Input id="api-key-base-url" value={baseUrl} maxLength={500} autoComplete="off" spellCheck={false} placeholder="https://api.example.com/v1" onChange={event => setBaseUrl(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="api-key-protocol">{t('protocolLabel')}</FieldLabel>
              <Select value={protocol} items={protocolItems} onValueChange={next => { if (next === 'openai' || next === 'anthropic') setProtocol(next) }}>
                <SelectTrigger id="api-key-protocol" aria-label={t('protocolLabel')} className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>{protocolItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="api-key-models">{t('models')}</FieldLabel>
              <Input id="api-key-models" value={models} autoComplete="off" spellCheck={false} placeholder="model-a, model-b" onChange={event => setModels(event.target.value)} />
            </Field>
          </>}
          <Field>
            <FieldLabel htmlFor="api-key-value">API Key</FieldLabel>
            <Input id="api-key-value" type="password" value={apiKey} autoComplete="new-password" spellCheck={false} onChange={event => setApiKey(event.target.value)} />
          </Field>
          {error && <FieldError>{error}</FieldError>}
        </FieldGroup>
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" disabled={pending} onClick={() => onClose(false)}>{commonT('cancel')}</Button>
          <Button type="submit" disabled={pending || !ready}>{pending ? t('verifying') : t('addConfirm')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
