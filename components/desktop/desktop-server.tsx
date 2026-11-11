'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'
import { ServerIcon } from 'lucide-react'
import type { BundledBridge, BundledServer, BundledServerProbe, BundledServerState } from '@mikka/protocol/bridge'
import { bridgeFromWindow, type MikkaWindow } from '@/lib/platform/detect'
import { useDesktopCapability } from '@/lib/platform/use-platform'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'

type ServerApi = NonNullable<BundledBridge['server']>

/** The desktop's server bridge (#1557); null on the web and on older desktops. */
export function desktopServers(): ServerApi | null {
  if (typeof window === 'undefined') return null
  return bridgeFromWindow(window as MikkaWindow)?.bundled?.server ?? null
}

/** Main's view of servers, read after mount (the server render is the web's). */
export function useDesktopServers(): { state: BundledServerState | null; setState: (state: BundledServerState) => void } {
  const supported = useDesktopCapability('server.select')
  const [state, setState] = useState<BundledServerState | null>(null)
  useEffect(() => {
    if (!supported) return
    let live = true
    void desktopServers()?.state().then(value => { if (live) setState(value) }).catch(() => {})
    return () => { live = false }
  }, [supported])
  return { state, setState }
}

export function useServerLabel(): (server: BundledServer) => string {
  const t = useTranslations('DesktopServer')
  return server => server.cloud ? t('cloud') : server.name ?? new URL(server.url).host
}

/** The server's name with its icon (R-74) and, for a self-hosted one, its address. */
export function ServerName({ server }: { server: BundledServer }) {
  const label = useServerLabel()
  return <span className="inline-flex min-w-0 items-center gap-1.5">
    <ServerIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    <span className="truncate">{label(server)}</span>
    {!server.cloud && <span className="truncate text-muted-foreground">{new URL(server.url).host}</span>}
  </span>
}

type SavedChoice = { id: string; label: string }

function probeError(t: (key: string, values?: Record<string, string>) => string, probe: BundledServerProbe): string | null {
  switch (probe.status) {
    case 'ok': return null
    case 'server_update_required': return probe.version ? t('errors.serverUpdate', { version: probe.version }) : t('errors.serverUpdateUnknown')
    case 'app_update_required': return probe.minimum ? t('errors.appUpdate', { version: probe.minimum }) : t('errors.appUpdateUnknown')
    case 'invalid_address': return t('errors.invalidAddress')
    case 'https_required': return t('errors.httpsRequired')
    case 'unreachable': return t('errors.unreachable')
    case 'not_mikka': return t('errors.notMikka')
  }
}

/**
 * Mikka Cloud or a self-hosted address. A self-hosted address is read once
 * (#1556's discovery) before it can be chosen: the dialog shows the server's
 * name and version, or why it cannot be used.
 */
export function ServerDialog({ open, onOpenChange, current, onSelected }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  current: BundledServer | null
  onSelected: (state: BundledServerState) => void
}) {
  const api = desktopServers()
  if (!api) return null
  return <ServerChooser open={open} onOpenChange={onOpenChange} current={current}
    probeServer={address => api.probe(address)} select={async url => onSelected(await api.select(url))} />
}

export function ServerChooser({ open, onOpenChange, current, saved = [], activeChoice, probeServer, select, errorText }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  current: Pick<BundledServer, 'cloud' | 'url'> | null
  saved?: SavedChoice[]
  activeChoice?: string
  probeServer: (address: string) => Promise<BundledServerProbe>
  select: (url: string | null, savedChoice?: string) => Promise<void>
  errorText?: (error: unknown) => string
}) {
  const t = useTranslations('DesktopServer')
  const [choice, setChoice] = useState(activeChoice ?? (current && !current.cloud ? 'self' : 'cloud'))
  const [address, setAddress] = useState(current && !current.cloud ? current.url : '')
  const [probe, setProbe] = useState<BundledServerProbe | null>(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState('')
  const found = choice === 'self' && probe?.status === 'ok' ? probe.server : null
  const error = choice === 'self' && probe ? probeError(t as (key: string, values?: Record<string, string>) => string, probe) : null

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true); setFailure('')
    try {
      if (choice === 'cloud') await select(null)
      else if (choice !== 'self') await select(null, choice)
      else if (found) await select(found.url)
      else setProbe(await probeServer(address))
    } catch (error) { setFailure(errorText?.(error) ?? t('errors.failed')) }
    finally { setPending(false) }
  }

  return <Dialog open={open} onOpenChange={next => { if (!pending) onOpenChange(next) }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader><DialogTitle>{t('title')}</DialogTitle></DialogHeader>
      <form onSubmit={event => { void submit(event) }}>
        <FieldGroup>
          <Field>
            <RadioGroup aria-label={t('title')} value={choice} disabled={pending} onValueChange={next => { setChoice(next); setFailure('') }}
              className="w-full min-w-0 gap-0 overflow-hidden rounded-xl border">
              {[{ id: 'cloud', label: t('cloud') }, ...saved, { id: 'self', label: t('selfHosted') }].map(option => <Label key={option.id} className="flex w-full min-w-0 items-center gap-3 px-3 py-2 font-normal hover:bg-muted has-data-checked:bg-muted">
                <RadioGroupItem value={option.id} />
                <span>{option.label}</span>
              </Label>)}
            </RadioGroup>
          </Field>
          {choice === 'self' && <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="desktop-server-address">{t('address')}</FieldLabel>
            <Input id="desktop-server-address" disabled={pending} value={address} autoFocus inputMode="url" autoComplete="url" spellCheck={false} maxLength={2048} placeholder="https://mikka.example.com"
              aria-invalid={error ? true : undefined} onChange={event => { setAddress(event.target.value); setProbe(null); setFailure('') }} />
            {error && <FieldError>{error}</FieldError>}
          </Field>}
          {found && <Item variant="muted" size="sm" role="status">
            <ItemMedia variant="icon"><ServerIcon aria-hidden="true" /></ItemMedia>
            <ItemContent>
              <ItemTitle>{found.name}</ItemTitle>
              <ItemDescription>{t('version', { version: found.version ?? '' })}</ItemDescription>
            </ItemContent>
          </Item>}
          {failure && <FieldError>{failure}</FieldError>}
        </FieldGroup>
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>{t('cancel')}</Button>
          <Button type="submit" disabled={pending || (choice === 'self' && !found && !address.trim())}>
            {pending ? t('connecting') : choice === 'self' && !found ? t('connect') : t('continue')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
