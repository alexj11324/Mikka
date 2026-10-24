'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import useSWR from 'swr'
import { Check, Circle, CircleX, HardDrive, Terminal } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { IconTile } from '@/components/reui/icon-tile'
import { listLocalSshHosts } from '@/app/actions/agents'
import { listKnownHosts, setUpHost } from '@/lib/computer/client'
import { SETUP_STEPS, type KnownHost, type SetupStep, type SetupStepState } from '@/lib/computer/types'
import { cn } from '@/lib/utils'

type Steps = Record<SetupStep, { state: SetupStepState; detail?: string }>
const IDLE: Steps = Object.fromEntries(SETUP_STEPS.map(step => [step, { state: 'idle' }])) as Steps

/** Hosts this server's own ~/.ssh/config lists, for self-hosted setups without GET /api/devices/hosts. */
async function serverSshHosts(): Promise<KnownHost[]> {
  const hosts = await listLocalSshHosts()
  return hosts.map(host => ({ alias: host.alias, hostName: host.hostName ?? undefined, user: host.user ?? undefined, source: 'ssh', configured: false }))
}

function StepMark({ state }: { state: SetupStepState }) {
  if (state === 'done') return <span className="flex size-5 items-center justify-center rounded-full bg-success/15 text-success"><Check aria-hidden="true" className="size-3" /></span>
  if (state === 'active') return <Spinner aria-hidden="true" className="size-5 text-sidebar-primary" />
  if (state === 'failed') return <CircleX aria-hidden="true" className="size-5 text-destructive" />
  return <Circle aria-hidden="true" className="size-5 text-muted-foreground/40" />
}

function HostRow({ host, selected, onPick }: { host: KnownHost; selected: boolean; onPick: () => void }) {
  const t = useTranslations('Devices.add')
  const Icon = host.source === 'tailnet' ? HardDrive : Terminal
  return <li>
    <Button variant="ghost" aria-pressed={selected} className={cn('h-9 w-full justify-start gap-3 rounded-lg px-2.5 font-normal', selected && 'bg-muted')} onClick={onPick}>
      <Icon data-icon="inline-start" className="text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-left font-mono">{host.alias}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{host.configured ? t('configured') : t(host.source === 'tailnet' ? 'tailnetNew' : 'sshNew')}</span>
    </Button>
  </li>
}

/**
 * 添加设备, Tern style (Figma 121:1172, 123:1326): a host and user, the hosts
 * from the user's Tailnet and ~/.ssh/config, then 设置 turns the same dialog
 * into the five setup steps. It keeps its width and gets shorter.
 */
export function AddDeviceDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (open: boolean) => void; onAdded: () => void }) {
  const t = useTranslations('Devices.add')
  const tSteps = useTranslations('Devices.connect.steps')
  const locale = useLocale()
  const [host, setHost] = useState('')
  const [user, setUser] = useState('')
  const [settingUp, setSettingUp] = useState<string | null>(null)
  const [steps, setSteps] = useState<Steps>(IDLE)
  const [error, setError] = useState('')
  const abort = useRef<AbortController | null>(null)
  const { data: hosts = [] } = useSWR(open ? 'known-hosts' : null, () => listKnownHosts(serverSshHosts), { revalidateOnFocus: false })
  const tailnet = hosts.filter(item => item.source === 'tailnet')
  const ssh = hosts.filter(item => item.source === 'ssh')
  const done = steps.connect.state === 'done'
  const failed = SETUP_STEPS.some(step => steps[step].state === 'failed')

  useEffect(() => () => abort.current?.abort(), [])

  function close() {
    abort.current?.abort()
    onOpenChange(false)
    setHost(''); setUser(''); setSettingUp(null); setSteps(IDLE); setError('')
  }

  async function setUp(event?: FormEvent) {
    event?.preventDefault()
    const target = host.trim()
    if (!target || settingUp) return
    setSettingUp(target); setSteps(IDLE); setError('')
    const controller = new AbortController()
    abort.current = controller
    try {
      await setUpHost({ host: target, user: user.trim(), locale }, (step, state, detail) => setSteps(current => ({ ...current, [step]: { state, detail } })), controller.signal)
      onAdded()
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(t('interrupted'))
    }
  }

  function pick(item: KnownHost) { setHost(item.alias); setUser(item.user ?? '') }

  return <Dialog open={open} onOpenChange={next => { if (!next) close() }}>
    <DialogContent showCloseButton={false} className="gap-0 overflow-hidden p-0 sm:max-w-lg">
      <div className="flex items-start gap-3 px-5 pt-5 pb-4">
        <IconTile variant="outline" aria-hidden="true"><Terminal /></IconTile>
        <div className="flex min-w-0 flex-col gap-0.5">
          <DialogTitle className="text-base font-semibold">{settingUp ? t('settingUp', { host: settingUp }) : t('title')}</DialogTitle>
          <DialogDescription>{settingUp ? t('settingUpDescription') : t('description')}</DialogDescription>
        </div>
      </div>
      {settingUp ? <ol aria-label={t('progress')} className="flex flex-col gap-4 px-5 pt-1 pb-5">
        {SETUP_STEPS.map(step => <li key={step} className="flex items-start gap-3">
          <StepMark state={steps[step].state} />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className={cn('text-sm', steps[step].state === 'idle' && 'text-muted-foreground')}>{tSteps(step)}</span>
            {steps[step].state === 'failed' && steps[step].detail && <span className="text-xs text-destructive">{steps[step].detail}</span>}
          </span>
        </li>)}
        {error && <li role="alert" className="text-sm text-destructive">{error}</li>}
      </ol> : <form id="add-device" onSubmit={setUp} className="flex flex-col gap-5 px-5 pb-5">
        <FieldGroup className="gap-3">
          <Field orientation="horizontal">
            <FieldLabel htmlFor="add-device-host" className="w-16 flex-none!">{t('host')}</FieldLabel>
            <Input id="add-device-host" autoFocus autoComplete="off" spellCheck={false} className="h-9 font-mono" placeholder={t('hostPlaceholder')} value={host} onChange={event => setHost(event.target.value)} />
          </Field>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="add-device-user" className="w-16 flex-none!">{t('user')}</FieldLabel>
            <Input id="add-device-user" autoComplete="off" spellCheck={false} className="h-9 font-mono" placeholder={t('userPlaceholder')} value={user} onChange={event => setUser(event.target.value)} />
          </Field>
        </FieldGroup>
        {tailnet.length > 0 && <section aria-label={t('tailnet')} className="flex flex-col gap-1">
          <h3 className="text-xs text-muted-foreground">{t('tailnet')}</h3>
          <ul className="flex flex-col">{tailnet.map(item => <HostRow key={item.alias} host={item} selected={host === item.alias} onPick={() => pick(item)} />)}</ul>
        </section>}
        {ssh.length > 0 && <section aria-label={t('sshConfig')} className="flex flex-col gap-1">
          <h3 className="text-xs text-muted-foreground">{t('sshConfig')}</h3>
          <ul className="flex flex-col">{ssh.map(item => <HostRow key={item.alias} host={item} selected={host === item.alias} onPick={() => pick(item)} />)}</ul>
        </section>}
      </form>}
      <DialogFooter className="m-0 flex-row items-center gap-2 rounded-none px-5 py-3 sm:justify-start">
        {!settingUp && <KbdGroup aria-label={t('shortcut')}><Kbd>⌘</Kbd><Kbd>N</Kbd></KbdGroup>}
        {!done && <Button variant="ghost" size="sm" className="ml-auto gap-2 font-normal text-muted-foreground" onClick={close}>{t('cancel')}<Kbd>esc</Kbd></Button>}
        {!settingUp && <Button type="submit" form="add-device" variant="outline" size="sm" className="gap-2" disabled={!host.trim()}>{t('setUp')}<Kbd>↵</Kbd></Button>}
        {settingUp && failed && <Button variant="outline" size="sm" onClick={() => { setSettingUp(null) }}>{t('back')}</Button>}
        {settingUp && done && <Button variant="outline" size="sm" className="ml-auto gap-2" autoFocus onClick={close}>{t('done')}<Kbd>↵</Kbd></Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
