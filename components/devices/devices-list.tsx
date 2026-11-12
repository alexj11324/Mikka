'use client'

import { SettingsLoading } from '@/components/settings/primitives'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { Check, Copy, Laptop, MoreHorizontal, Plus, Server } from 'lucide-react'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import type { DeviceView } from '@/app/actions/agents'
import { HarnessLabel } from '@/components/labels/entity-labels'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldGroup, FieldLabel, FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemGroup, ItemSeparator } from '@/components/ui/item'
import { Switch } from '@/components/ui/switch'
import { useDeviceActions } from '@/components/devices/use-device-actions'
import { cn } from '@/lib/utils'
import { canRenameDevice, DEVICE_NAME_MAX } from '@/lib/device-name'
import type { SettingsDevicesProps } from '@/components/slots/settings-devices-contract'
import { AgentMarks, installedAgents, sandboxBlockedAgents } from './agent-marks'

/** Each agent's own published install command; the daemon detects it on 重新检测 Agent. */
const AGENT_INSTALL = [
  { harness: 'claude_code', command: 'npm install -g @anthropic-ai/claude-code' },
  { harness: 'codex', command: 'npm install -g @openai/codex' },
  { harness: 'cursor', command: 'curl https://cursor.com/install -fsS | bash' },
] as const

/** 安装方法: where a device reports no coding agent, each agent's install command. */
/** The install commands in a popover; `label` replaces the trigger's words (a UI layer's own line). */
export function InstallAgents({ label }: { label?: ReactNode } = {}) {
  const t = useTranslations('Devices')
  const [copied, setCopied] = useState<string | null>(null)
  function copy(command: string) {
    void navigator.clipboard.writeText(command).then(() => setCopied(command), () => {})
  }
  return <Popover>
    <PopoverTrigger className="shrink-0 cursor-pointer text-foreground underline underline-offset-2">{label ?? t('installAgent')}</PopoverTrigger>
    <PopoverContent align="start" className="w-96 gap-2">
      {AGENT_INSTALL.map(({ harness, command }) => <div key={harness} className="flex flex-col gap-1">
        <span className="text-xs"><HarnessLabel harness={harness} /></span>
        <span className="flex items-center gap-1">
          <code className="min-w-0 flex-1 truncate font-mono text-xs">{command}</code>
          <Button variant="ghost" size="icon-sm" aria-label={t('copyInstall', { command })} onClick={() => copy(command)}>{copied === command ? <Check /> : <Copy />}</Button>
        </span>
      </div>)}
    </PopoverContent>
  </Popover>
}

/** Ubuntu's own spec for the AppArmor user namespace restriction and its override file. */
const UBUNTU_USERNS_SPEC = 'https://discourse.ubuntu.com/t/spec-unprivileged-user-namespace-restrictions-via-apparmor-in-ubuntu-23-10/37626'
const USERNS_NOW = 'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0'
const USERNS_PERSIST = "echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/20-apparmor.conf"

/** A command the person runs on the device, with a copy button. */
function FixCommand({ command }: { command: string }) {
  const t = useTranslations('Devices')
  const [copied, setCopied] = useState(false)
  return <span className="flex items-center gap-1">
    <code className="min-w-0 flex-1 break-all font-mono text-xs">{command}</code>
    <Button variant="ghost" size="icon-sm" aria-label={t('copyInstall', { command })} onClick={() => { void navigator.clipboard.writeText(command).then(() => setCopied(true), () => {}) }}>{copied ? <Check /> : <Copy />}</Button>
  </span>
}

/** Why a device's agents cannot run. The daemon already tried to fetch the tools itself and rechecks on its own. */
export function SandboxBlocked({ missing, reason, detail }: { missing: string[]; reason?: 'userns_restricted'; detail?: string }) {
  const t = useTranslations('Devices')
  return <Popover>
    <PopoverTrigger className="shrink-0 cursor-pointer text-foreground underline underline-offset-2">{t('sandboxFix')}</PopoverTrigger>
    <PopoverContent align="start" className="w-96 gap-2">
      {missing.length > 0
        ? <span className="text-xs">{t('sandboxMissing', { packages: missing.join(', ') })}</span>
        : reason === 'userns_restricted'
          ? <>
            <span className="text-xs">{t('sandboxUserns')}</span>
            <span className="text-xs text-muted-foreground">{t('sandboxUsernsNow')}</span>
            <FixCommand command={USERNS_NOW} />
            <span className="text-xs text-muted-foreground">{t('sandboxUsernsPersist')}</span>
            <FixCommand command={USERNS_PERSIST} />
            <a className="text-xs underline underline-offset-2" href={UBUNTU_USERNS_SPEC} target="_blank" rel="noreferrer">{t('sandboxUsernsSpec')}</a>
          </>
          : <span className="text-xs">{t('sandboxRefused')}</span>}
      {missing.length === 0 && detail && <span className="break-all text-xs text-muted-foreground">{t('sandboxDetail', { detail })}</span>}
    </PopoverContent>
  </Popover>
}

/** The device type with the online dot on its corner. */
function DeviceTypeIcon({ device }: { device: DeviceView }) {
  const Icon = device.deviceType === 'server' ? Server : Laptop
  return <span className="relative inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground">
    <Icon aria-hidden="true" className="size-4.5" />
    <span aria-hidden="true" className={cn('absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-card', device.online ? 'bg-success' : 'bg-muted-foreground/50')} />
  </span>
}

/**
 * Why the device gets no runs, in the 离线 · 不会被派任务 form; nothing when it can take runs.
 * Which models a run may use comes from credentials alone (Alex, 2026-11-06, #1539), so the device
 * says only whether it takes runs, never which models.
 */
export function NoRunsLine({ device, agents, blocked }: { device: DeviceView; agents: number; blocked: boolean }) {
  const t = useTranslations('Devices')
  const reason = !device.online ? null
    : !device.enabled ? t('noRuns', { reason: t('notScheduling') })
    : agents === 0 ? t('noRuns', { reason: blocked ? t('sandboxUnavailable') : t('noAgent') })
    : device.harnesses.some(item => item.installed && item.subscriptionBroker) ? null
    : t('noSubscriptionRuns', { reason: t('needsUpdate') })
  if (!device.online) return <span className="text-xs text-warning-foreground">{t('offlineNoRuns')}</span>
  return reason ? <span className="truncate text-xs text-warning-foreground">{reason}</span> : null
}

function DeviceRow({ device, onChanged, onReconnect }: { device: DeviceView; onChanged: () => void; onReconnect: (device: DeviceView) => void }) {
  const t = useTranslations('Devices')
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const { busy, rename, remove, command, setEnabled } = useDeviceActions(device, onChanged)
  const [renaming, setRenaming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const agents = installedAgents(device.harnesses)
  const blocked = sandboxBlockedAgents(device.harnesses)

  const status = device.online
    ? t('online')
    : device.lastSeenAt ? t('offlineSince', { time: format.relativeTime(new Date(device.lastSeenAt), now) }) : t('neverOnline')

  // On a phone the two switches move to their own line under the name, keeping their labels (D1).
  return <Item role="listitem" className="flex-wrap gap-3 rounded-none px-3.5 py-3">
    <DeviceTypeIcon device={device} />
    <span className={cn('flex min-w-0 flex-1 flex-col gap-0.5', !device.online && 'text-muted-foreground')}>
      <span className="truncate text-sm font-medium">{device.name}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
        <span className="truncate">{status}</span>
        {device.online && (agents.length > 0
          ? <AgentMarks agents={agents} />
          : blocked.agents.length > 0 ? <SandboxBlocked missing={blocked.missing} reason={blocked.reason} detail={blocked.detail} /> : <InstallAgents />)}
      </span>
      <NoRunsLine device={device} agents={agents.length} blocked={blocked.agents.length > 0} />
    </span>
    {!device.online && <Button variant="secondary" size="sm" onClick={() => onReconnect(device)}>{t('reconnect')}</Button>}
    {/* 参与调度: the device's one switch (decision 2026-11-02-1400); on a phone it keeps its label on its own line. */}
    <span className="flex items-center gap-2 text-sm text-muted-foreground max-sm:order-last max-sm:basis-full max-sm:pl-8">
      <span aria-hidden="true">{t('allowScheduling')}</span>
      <Switch disabled={busy} checked={device.enabled} aria-label={t('allowSchedulingTo', { name: device.name })} onCheckedChange={enabled => { void setEnabled(enabled) }} />
    </span>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t('menu', { name: device.name })} />}><MoreHorizontal data-icon="inline-start" /></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => setRenaming(true)}>{t('actions.rename')}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => { void command('restart') }}>{t('actions.restart')}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => { void command('update') }}>{t('actions.update')}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => { void command('redetect') }}>{t('actions.redetect')}</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem variant="destructive" onClick={() => setRemoving(true)}>{t('actions.remove')}</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    <RenameDialog device={device} open={renaming} onOpenChange={setRenaming} onSave={async name => { const saved = await rename(name); if (saved) setRenaming(false); return saved }} />
    <AlertDialog open={removing} onOpenChange={setRemoving}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('remove.title', { name: device.name })}</AlertDialogTitle>
          <AlertDialogDescription>{device.online ? t('remove.uninstall', { name: device.name }) : t('remove.offline', { name: device.name })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('remove.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={async event => { event.preventDefault(); if (await remove()) setRemoving(false) }}>{t('remove.confirm')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Item>
}

function RenameDialog({ device, open, onOpenChange, onSave }: { device: DeviceView; open: boolean; onOpenChange: (open: boolean) => void; onSave: (name: string) => Promise<boolean> }) {
  const t = useTranslations('Devices')
  const commonT = useTranslations('Common')
  const [name, setName] = useState(device.name)
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (open) setName(device.name) }, [open, device.name])
  const trimmed = name.trim()
  const valid = canRenameDevice(device.name, name)
  async function save() {
    if (!valid || saving) return
    setSaving(true)
    await onSave(trimmed)
    setSaving(false)
  }
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent closeLabel={commonT('close')} className="sm:max-w-md" aria-describedby={undefined}>
      <DialogHeader><DialogTitle>{t('rename.title')}</DialogTitle></DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`rename-${device.id}`} className="sr-only">{t('rename.label')}</FieldLabel>
          <Input id={`rename-${device.id}`} autoFocus value={name} maxLength={DEVICE_NAME_MAX} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void save() } }} />
        </Field>
      </FieldGroup>
      <DialogFooter>
        <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>{t('rename.cancel')}</Button>
        <Button size="sm" disabled={!valid || saving} onClick={() => { void save() }}>{t('rename.save')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

function DeviceGroup({ title, devices, onChanged, onReconnect }: { title: string; devices: DeviceView[]; onChanged: () => void; onReconnect: (device: DeviceView) => void }) {
  return devices.length > 0 && <section aria-label={title} className="flex flex-col gap-2">
    <h2 className="px-1 text-sm font-medium text-muted-foreground">{title}</h2>
    <ItemGroup role="list" className="gap-0! overflow-hidden rounded-xl border bg-card">{devices.map((device, index) => <Fragment key={device.id}>{index > 0 && <ItemSeparator className="my-0" />}<DeviceRow device={device} onChanged={onChanged} onReconnect={onReconnect} /></Fragment>)}</ItemGroup>
  </section>
}

/** 设置 › 设备's page as the open-source UI draws it; the slot settings-devices' default. */
export function DevicesPageView({ devices, listError, onAdd, onChanged, onReconnect, localSetup }: SettingsDevicesProps) {
  const t = useTranslations('Devices')
  return <div className="flex flex-col gap-6">
    <div className="flex items-center justify-between gap-3">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <Button size="sm" variant="secondary" aria-keyshortcuts="Meta+N Control+N" onClick={onAdd}><Plus data-icon="inline-start" />{t('add.trigger')}</Button>
    </div>
    {localSetup}
    {listError && <FieldError className="text-xs">{t('listError')}</FieldError>}
    {/* Not read yet: rows' shapes, never 还没有设备 (review C6, R-39). A failed first read says only that. */}
    {!devices ? !listError && <div className="overflow-hidden rounded-xl border bg-card"><SettingsLoading bare label={t('loading')} /></div>
      : devices.length === 0 ? <Empty className="rounded-xl border"><EmptyHeader><EmptyTitle>{t('emptyTitle')}</EmptyTitle></EmptyHeader></Empty> : <>
      <DeviceGroup title={t('computers')} devices={devices.filter(device => device.deviceType !== 'server')} onChanged={onChanged} onReconnect={onReconnect} />
      <DeviceGroup title={t('otherDevices')} devices={devices.filter(device => device.deviceType === 'server')} onChanged={onChanged} onReconnect={onReconnect} />
    </>}
  </div>
}
