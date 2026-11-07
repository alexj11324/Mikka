'use client'

import { useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { KeyRound, TriangleAlert } from 'lucide-react'
import { SettingRow, SettingsSaveError, SettingsSection, settingsSectionAction } from '@/components/settings/primitives'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Claude } from '@/components/ui/svgs/claude'
import { OpenAI } from '@/components/ui/svgs/openai'
import { API_KEY_PRESETS, apiKeyProtocols, type ApiKeyProtocol, type ApiKeyProvider } from '@/lib/model-api-key-providers'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { apiKeysKey, readApiKeys, useApiKeyLabels, useApiKeys, type ApiKey as Key } from '@/hooks/settings/use-api-keys'

export { apiKeysKey, readApiKeys }
const providers = [...API_KEY_PRESETS, 'custom'] as const

/** 「Anthropic、OpenAI 协议 · 可用 Claude Code、Codex」: what a key speaks and which Agents can run it (Harness draft, Alex 2026-11-02). */

function ProviderIcon({ provider }: { provider: ApiKeyProvider }) {
  if (provider === 'anthropic') return <Claude className="size-5 shrink-0 text-brand-claude" />
  if (provider === 'openai') return <OpenAI className="size-5 shrink-0 text-foreground" />
  return <KeyRound aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
}

/**
 * 「API 与订阅」's API keys and custom providers (orchestration.md § 1, C22):
 * their own group after the subscriptions (decision 2026-11-02-1200), with
 * 添加 API Key, and the account's 订阅额度用完后，自动改用 API Key switch.
 * Keys are write-only: a row shows the last four characters only. A row
 * shows how many models the provider's /models gave, or why it gave none,
 * with 重新获取模型.
 */
export function useApiKeyList(workspaceId: string) {
  const t = useTranslations('Settings.apiKeys')
  const shareT = useTranslations('Settings.subscriptionShare')
  const commonT = useTranslations('Common')
  const { data, loadError, pending, failed, share: saveShare, refetch, remove: removeKey, add } = useApiKeys(workspaceId)
  const [adding, setAdding] = useState(false)
  const [sharing, setSharing] = useState<Key | null>(null)
  const [removing, setRemoving] = useState<Key | null>(null)
  const { title, agents: agentsLine } = useApiKeyLabels()
  const share = (key: Key, shared: boolean) => saveShare(key, shared).finally(() => setSharing(null))
  const remove = (key: Key) => removeKey(key).finally(() => setRemoving(null))

  const modelsLine = (key: Key) => {
    const refetchButton = <Button type="button" variant="secondary" size="xs" disabled={pending} aria-label={t('refetchLabel', { name: title(key) })} onClick={() => void refetch(key)}>{t('refetch')}</Button>
    if (key.modelsError) return <span role="status" className="flex flex-wrap items-center gap-2 text-xs text-warning-foreground">
      <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0 text-warning-foreground" />{t(key.modelsError === 'invalid' ? 'modelsInvalid' : 'modelsUnavailable')}{refetchButton}
    </span>
    return <span role="status" className="flex flex-wrap items-center gap-2 text-xs">{key.models.length ? t('modelCount', { count: key.models.length }) : t('noModels')}{refetchButton}</span>
  }
  // An OpenAI-protocol provider without the Responses API serves bot chats only (Codex runs on it).
  const rows: ReactNode[] = (data?.keys ?? []).map(key => <div key={key.id} id={`api-key-${key.id}`} className="scroll-mt-20"><SettingRow icon={<ProviderIcon provider={key.provider} />} title={title(key)}
    description={<><span className="block">{`${key.baseUrl ? new URL(key.baseUrl).host : t('apiKey')} · ••••${key.last4} · ${agentsLine(key)}`}</span>{modelsLine(key)}</>}>
    <span className="flex items-center gap-4">
      {data?.canShare && <Label className="flex items-center gap-2 font-normal text-muted-foreground">
        {shareT('others')}
        <Switch aria-label={t('shareLabel', { name: title(key) })} checked={key.shared} disabled={pending}
          onCheckedChange={checked => { if (checked) setSharing(key); else void share(key, false) }} />
      </Label>}
      <Button type="button" variant="ghost" size="sm" disabled={pending} aria-label={t('removeLabel', { name: title(key) })} onClick={() => setRemoving(key)}>{commonT('delete')}</Button>
    </span>
  </SettingRow></div>)
  if (loadError) rows.push(<div key="error" className="px-5 py-4"><FieldError>{loadError}</FieldError></div>)

  const action = <Button type="button" {...settingsSectionAction} disabled={!data} onClick={() => setAdding(true)}>{t('add')}</Button>
  const section = <SettingsSection id="api-keys-heading" title={t('sectionTitle')} action={action}>
    {rows.length ? rows : <p className="px-5 py-4 text-sm text-muted-foreground">{data ? t('none') : t('loading')}</p>}
  </SettingsSection>
  const dialogs = <>
    {failed && <SettingsSaveError message={failed.message} retryLabel={commonT('retry')} onRetry={failed.retry} />}
    {adding && <AddApiKeyDialog add={add} onClose={() => setAdding(false)} />}
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
  return { section, dialogs }
}

/** 订阅额度用完后，自动改用 API Key: on by default (orchestration.md § 2). */
export function ApiKeyFallbackSetting({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.apiKeys')
  const commonT = useTranslations('Common')
  const { data, setAfterQuota } = useApiKeys(workspaceId)
  const [failed, setFailed] = useState<{ on: boolean; message: string } | null>(null)
  async function save(on: boolean) {
    setFailed(null)
    const message = await setAfterQuota(on)
    if (message) setFailed({ on, message })
  }
  if (!data) return null
  return <>
    {/* Its own policy, apart from the order of 优先使用的模型 (decision 2026-11-02 R, item 1). */}
    <SettingsSection id="after-quota-heading" title={t('afterQuotaSection')}>
      <SettingRow title={t('afterQuota')} description={t('afterQuotaBilling')}>
        <Switch aria-label={t('afterQuota')} checked={data.apiKeyAfterQuota} onCheckedChange={on => void save(on)} />
      </SettingRow>
    </SettingsSection>
    {failed && <SettingsSaveError message={failed.message} retryLabel={commonT('retry')} onRetry={() => void save(failed.on)} />}
  </>
}

function AddApiKeyDialog({ add, onClose }: { add: ReturnType<typeof useApiKeys>['add']; onClose: () => void }) {
  const t = useTranslations('Settings.apiKeys')
  const { protocolAgents } = useApiKeyLabels()
  const commonT = useTranslations('Common')
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

  async function save() {
    setPending(true); setError(null)
    const list = models.split(/[\s,，]+/).map(item => item.trim()).filter(Boolean)
    const message = await add(provider === 'custom'
      ? { provider, name: name.trim(), baseUrl: baseUrl.trim(), protocol, apiKey: apiKey.trim(), ...(list.length ? { models: list } : {}) }
      : { provider, apiKey: apiKey.trim() })
    setPending(false)
    if (message) setError(message)
    else onClose()
  }

  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose() }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader><DialogTitle>{t('add')}</DialogTitle></DialogHeader>
      <form onSubmit={event => { event.preventDefault(); if (ready && !pending) void save() }}>
        <FieldGroup>
          {/* A preset only takes its key: it speaks its own protocols, so each row says which Agents it runs on. */}
          <Field>
            <FieldLabel id="api-key-provider-label">{t('providerLabel')}</FieldLabel>
            <RadioGroup aria-labelledby="api-key-provider-label" value={provider} onValueChange={next => { if (providers.includes(next as never)) setProvider(next as ApiKeyProvider) }}
              className="w-full min-w-0 gap-0 overflow-hidden rounded-xl border">
              {providers.map(value => <Label key={value} className="flex w-full min-w-0 items-center gap-3 px-3 py-2 font-normal hover:bg-muted has-data-checked:bg-muted">
                <RadioGroupItem value={value} />
                <span className="shrink-0">{t(`provider.${value}`)}</span>
                <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
                  {value === 'custom' ? t('customAgents') : protocolAgents(apiKeyProtocols({ provider: value, protocol: 'anthropic' }))}
                </span>
              </Label>)}
            </RadioGroup>
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
            {/* Only a custom provider picks its protocol; each option names the Agent it runs on. */}
            <Field>
              <FieldLabel id="api-key-protocol-label">{t('protocolLabel')}</FieldLabel>
              <ToggleGroup aria-labelledby="api-key-protocol-label" variant="segment" spacing={0.5} className="grid w-full grid-cols-2" value={[protocol]}
                onValueChange={values => { const next = values[0]; if (next === 'openai' || next === 'anthropic') setProtocol(next) }}>
                {(['openai', 'anthropic'] as const).map(value => <ToggleGroupItem key={value} value={value} className="min-w-0 text-xs">{protocolAgents([value])}</ToggleGroupItem>)}
              </ToggleGroup>
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
          <Button type="button" variant="outline" disabled={pending} onClick={() => onClose()}>{commonT('cancel')}</Button>
          <Button type="submit" disabled={pending || !ready}>{pending ? t('verifying') : t('addConfirm')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
