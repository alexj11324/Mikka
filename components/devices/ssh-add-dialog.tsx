'use client'

import { Fragment, useEffect, useRef, useState } from 'react'
import { Check, Circle, Loader2, TerminalSquare, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { SshInstallState } from '@mikka/protocol/bridge'
import type { DeviceView } from '@/app/actions/agents'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemGroup, ItemSeparator } from '@/components/ui/item'
import { bridgeFromWindow, type MikkaWindow } from '@/lib/platform/detect'
import { cn } from '@/lib/utils'
import { STEPS, addedHost, stepStates, type StepState } from '@/lib/device-ssh-view'
import { AgentMarks, installedAgents } from './agent-marks'

function StepIcon({ state }: { state: StepState }) {
  if (state === 'done') return <Check aria-hidden="true" className="size-4 text-success" />
  if (state === 'failed') return <X aria-hidden="true" className="size-4 text-destructive" />
  if (state === 'running') return <Loader2 aria-hidden="true" className="size-4 animate-spin text-muted-foreground" />
  return <Circle aria-hidden="true" className="size-4 text-muted-foreground/60" />
}

/**
 * 添加设备 in the desktop app (Figma V09c 685:24728 → V09c-5 686:25550): pick a
 * host from `~/.ssh/config` or type one, trust its host key, and Mikka installs
 * and starts the daemon over SSH. The install runs in the desktop main process,
 * so closing this dialog does not stop it; reopening shows where it is.
 */
export function SshAddDialog({ open, onOpenChange, devices, onAdded }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  devices: DeviceView[]
  onAdded: () => void
}) {
  const t = useTranslations('Devices.ssh')
  const commonT = useTranslations('Common')
  const [hosts, setHosts] = useState<string[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [other, setOther] = useState('')
  const [install, setInstall] = useState<SshInstallState | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState(false)
  const onAddedRef = useRef(onAdded)
  useEffect(() => { onAddedRef.current = onAdded })

  useEffect(() => {
    const ssh = bridgeFromWindow(window as MikkaWindow)?.ssh
    if (!open || !ssh) return
    let live = true
    setStartError(false)
    void ssh.hosts().then(list => { if (live) setHosts(list) }, () => { if (live) setHosts([]) })
    void ssh.state().then(state => { if (live && state && state.status !== 'online') setInstall(state) }, () => {})
    const unsubscribe = ssh.onChange(state => {
      if (!live) return
      setInstall(state)
      if (state.status === 'online') onAddedRef.current()
    })
    return () => { live = false; unsubscribe() }
  }, [open])

  const target = other.trim() || selected
  async function begin(next: string) {
    const ssh = bridgeFromWindow(window as MikkaWindow)?.ssh
    if (!ssh || starting) return
    setStarting(true)
    setStartError(false)
    try { setInstall(await ssh.begin(next)) } catch { setStartError(true) } finally { setStarting(false) }
  }
  async function accept() {
    const ssh = bridgeFromWindow(window as MikkaWindow)?.ssh
    if (!ssh || !install) return
    try { setInstall(await ssh.accept(install.id)) } catch { setStartError(true) }
  }
  function close(next: boolean) {
    if (!next) {
      // A finished, failed or unconfirmed install starts over next time; a running one is restored.
      if (install && install.status !== 'running') setInstall(null)
      setSelected(null)
      setOther('')
    }
    onOpenChange(next)
  }

  const added = install?.status === 'online' ? devices.find(device => device.id === install.deviceId) : undefined
  const fingerprint = install?.status === 'fingerprint'
  const progress = install && !fingerprint

  return <Dialog open={open} onOpenChange={close}>
    <DialogContent closeLabel={commonT('close')} className="sm:max-w-md" aria-describedby={undefined}>
      {fingerprint ? <>
        <DialogHeader><DialogTitle>{t('trust', { host: install.target })}</DialogTitle></DialogHeader>
        <p className="font-mono text-xs break-all text-muted-foreground">{install.fingerprint}</p>
        <DialogFooter>
          <Button variant="secondary" size="sm" onClick={() => setInstall(null)}>{t('cancel')}</Button>
          <Button size="sm" onClick={() => { void accept() }}>{t('trustContinue')}</Button>
        </DialogFooter>
      </> : progress ? <>
        <DialogHeader><DialogTitle>{t('adding', { host: install.target })}</DialogTitle></DialogHeader>
        <ol aria-label={t('progress')} className="flex flex-col gap-3">
          {STEPS.map(step => {
            const state = stepStates(install)[step]
            return <li key={step} className="flex min-w-0 items-center gap-2.5 text-sm">
              <StepIcon state={state} />
              <span className={cn('shrink-0', state === 'pending' && 'text-muted-foreground')}>{t(`steps.${step}`)}</span>
              <span className="sr-only">{t(`stepState.${state}`)}</span>
              {state === 'failed' && install.reason && <span className="ml-auto min-w-0 truncate text-xs text-destructive" title={install.reason}>{install.reason}</span>}
              {step === 'online' && added && <span className="ml-auto"><AgentMarks harnesses={installedAgents(added.harnesses)} /></span>}
            </li>
          })}
        </ol>
        <DialogFooter>
          {install.status === 'online'
            ? <Button size="sm" onClick={() => close(false)}>{t('done')}</Button>
            : <>
              <Button variant="secondary" size="sm" onClick={() => close(false)}>{install.status === 'running' ? t('hide') : t('cancel')}</Button>
              {install.status === 'failed' && install.retryable !== false && <Button size="sm" disabled={starting} onClick={() => { void begin(install.target) }}>{t('retry')}</Button>}
            </>}
        </DialogFooter>
      </> : <>
        <DialogHeader><DialogTitle>{t('title')}</DialogTitle></DialogHeader>
        <div className="flex min-w-0 flex-col gap-4">
          {hosts && hosts.length > 0 && <section className="flex flex-col gap-2">
            <h3 className="text-sm text-muted-foreground">{t('sshConfig')}</h3>
            <ItemGroup role="listbox" aria-label={t('sshConfig')} className="max-h-64 gap-0! overflow-y-auto rounded-lg border">
              {hosts.map((host, index) => {
                const exists = addedHost(host, devices)
                const active = selected === host && !other.trim()
                return <Fragment key={host}>
                  {index > 0 && <ItemSeparator className="my-0" />}
                  <Item role="option" aria-selected={active} aria-disabled={exists || undefined} size="sm"
                    render={<Button variant="ghost" disabled={exists} onClick={() => { setSelected(host); setOther('') }} />}
                    className={cn('h-auto w-full justify-start gap-2.5 rounded-none px-3 py-2.5 font-normal', active && 'bg-muted')}>
                    <TerminalSquare aria-hidden="true" className="text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-left font-mono text-xs">{host}</span>
                    {exists ? <span className="text-xs text-muted-foreground">{t('added')}</span> : active && <Check aria-hidden="true" />}
                  </Item>
                </Fragment>
              })}
            </ItemGroup>
          </section>}
          <FieldGroup><Field>
            <FieldLabel htmlFor="ssh-other-host">{hosts && hosts.length > 0 ? t('otherHost') : t('host')}</FieldLabel>
            <Input id="ssh-other-host" value={other} placeholder="user@host:port" className="font-mono text-xs" spellCheck={false} autoCapitalize="off" onChange={event => setOther(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter' && target) { event.preventDefault(); void begin(target) } }} />
          </Field></FieldGroup>
          {startError && <p role="alert" className="text-xs text-destructive">{t('startFailed')}</p>}
        </div>
        <DialogFooter>
          <Button variant="secondary" size="sm" onClick={() => close(false)}>{t('cancel')}</Button>
          <Button size="sm" disabled={!target || starting} onClick={() => { if (target) void begin(target) }}>{t('add')}</Button>
        </DialogFooter>
      </>}
    </DialogContent>
  </Dialog>
}
