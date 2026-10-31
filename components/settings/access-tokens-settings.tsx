'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useLocale, useTranslations } from 'next-intl'
import { Check, Copy } from 'lucide-react'
import { createAccessToken, listAccessTokens, revokeAccessToken } from '@/app/actions/tokens'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingRow, SettingsLoading, SettingsSection, settingsSectionAction } from '@/components/settings/primitives'
import type { PersonalAccessTokenView } from '@/lib/tokens/store'
import { relativeTime } from '@/lib/relative-time'
import { useActionError } from '@/lib/use-action-error'

const EXPIRY_DAYS = { '30': 30, '90': 90, '365': 365, never: null } as const
type Expiry = keyof typeof EXPIRY_DAYS

/** N3 个人访问令牌: the person's tokens in this workspace; the plaintext is shown once, right after 新建. */
export function AccessTokensSettings({ workspaceId }: { workspaceId?: string }) {
  const t = useTranslations('Settings.tokens')
  const locale = useLocale()
  const actionError = useActionError()
  const tokens = useSWR(['settings:tokens', workspaceId ?? ''], () => listAccessTokens(workspaceId))
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<PersonalAccessTokenView | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rows = tokens.data && !tokens.data.error ? tokens.data : null
  const date = new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' })

  function describe(token: PersonalAccessTokenView) {
    const used = token.lastUsedAt ? t('lastUsed', { when: relativeTime(token.lastUsedAt, locale) }) : t('neverUsed')
    const expiry = token.expired ? t('expired') : token.expiresAt ? t('expires', { date: date.format(new Date(token.expiresAt)) }) : t('noExpiry')
    return `mkp_…${token.hint} · ${used} · ${expiry}`
  }

  async function revoke(token: PersonalAccessTokenView) {
    setPending(true)
    setError(null)
    try {
      const result = await revokeAccessToken({ id: token.id }, workspaceId)
      if (result.error) setError(actionError(result.error))
      await tokens.mutate()
    } catch {
      setError(actionError())
    } finally {
      setPending(false)
      setRevoking(null)
    }
  }

  return <>
    <SettingsSection id="tokens-heading" action={<Button {...settingsSectionAction} onClick={() => setCreating(true)}>{t('create')}</Button>}>
      {!tokens.data && !tokens.error && <SettingsLoading label={t('loading')} rows={2} bare />}
      {(tokens.error || tokens.data?.error) && <p role="alert" className="px-5 py-4 text-sm text-destructive">{actionError(tokens.data?.error)}</p>}
      {rows?.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">{t('empty')}</p>}
      {rows?.map(token => <SettingRow key={token.id} title={token.name} description={describe(token)}>
        <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => setRevoking(token)}>{t('revoke')}</Button>
      </SettingRow>)}
    </SettingsSection>
    {error && <p role="alert" className="px-1 text-sm text-destructive">{error}</p>}
    {creating && <CreateTokenDialog workspaceId={workspaceId} onDone={() => { setCreating(false); void tokens.mutate() }} />}
    <AlertDialog open={revoking !== null} onOpenChange={open => { if (!open && !pending) setRevoking(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{t('revokeTitle', { name: revoking?.name ?? '' })}</AlertDialogTitle></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={() => { if (revoking) void revoke(revoking) }}>{t('revoke')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}

function CreateTokenDialog({ workspaceId, onDone }: { workspaceId?: string; onDone: () => void }) {
  const t = useTranslations('Settings.tokens')
  const actionError = useActionError()
  const [name, setName] = useState('')
  const [expiry, setExpiry] = useState<Expiry>('90')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const expiryItems = (Object.keys(EXPIRY_DAYS) as Expiry[]).map(value => ({ value, label: t(`expiry.${value}`) }))

  async function create() {
    setPending(true)
    setError(null)
    try {
      const days = EXPIRY_DAYS[expiry]
      const result = await createAccessToken({ name: name.trim(), expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null }, workspaceId)
      if (result.error) { setError(actionError(result.error)); return }
      setToken(result.token)
    } catch {
      setError(actionError())
    } finally {
      setPending(false)
    }
  }

  async function copy() {
    if (!token) return
    try { await navigator.clipboard.writeText(token); setCopied(true) } catch { setCopied(false) }
  }

  return <Dialog open onOpenChange={open => { if (!open && !pending) onDone() }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{token ? t('createdTitle', { name: name.trim() }) : t('createTitle')}</DialogTitle></DialogHeader>
      {token
        ? <div className="flex flex-col gap-2 text-sm">
          <InputGroup>
            <InputGroupInput aria-label={t('token')} readOnly value={token} className="font-mono" onFocus={event => event.currentTarget.select()} />
            <InputGroupAddon align="inline-end"><InputGroupButton aria-label={t('copy')} onClick={() => void copy()}>{copied ? <Check /> : <Copy />}</InputGroupButton></InputGroupAddon>
          </InputGroup>
          <p className="text-muted-foreground">{t('shownOnce')}</p>
        </div>
        : <div className="flex flex-col gap-3">
          <Label className="flex flex-col items-start gap-1.5">{t('name')}
            <Input value={name} maxLength={64} autoFocus onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && name.trim()) void create() }} />
          </Label>
          <Label className="flex flex-col items-start gap-1.5">{t('expiryLabel')}
            <Select value={expiry} items={expiryItems} onValueChange={value => { if (value) setExpiry(value as Expiry) }}>
              <SelectTrigger aria-label={t('expiryLabel')} className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{expiryItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </Label>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>}
      <DialogFooter>
        {token
          ? <Button type="button" onClick={onDone}>{t('done')}</Button>
          : <>
            <Button type="button" variant="outline" disabled={pending} onClick={onDone}>{t('cancel')}</Button>
            <Button type="button" disabled={pending || !name.trim()} onClick={() => void create()}>{pending ? t('creating') : t('create')}</Button>
          </>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
