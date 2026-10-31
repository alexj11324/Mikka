'use client'

import { Fragment, useEffect, useState } from 'react'
import useSWR from 'swr'
import { Check, Copy, Laptop, MoreHorizontal, Plus, Server } from 'lucide-react'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { listDevices, removeDevice, renameDevice, sendDeviceCommand, setDeviceEnabled, type DeviceView } from '@/app/actions/agents'
import { HarnessLabel } from '@/components/labels/entity-labels'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemGroup, ItemSeparator } from '@/components/ui/item'
import { Switch } from '@/components/ui/switch'
import { bridgeFromWindow, type MikkaWindow } from '@/lib/platform/detect'
import { useActionError } from '@/lib/use-action-error'
import { cn } from '@/lib/utils'
import { ConnectDeviceDialog } from './connect-device-dialog'
import { AgentMarks, installedAgents } from './agent-marks'
import { SshAddDialog } from './ssh-add-dialog'

type Command = 'redetect' | 'restart' | 'update'
type Result = { error: string } | object

/** Each agent's own published install command; the daemon detects it on 重新检测 Agent. */
const AGENT_INSTALL = [
  { harness: 'claude_code', command: 'npm install -g @anthropic-ai/claude-code' },
  { harness: 'codex', command: 'npm install -g @openai/codex' },
  { harness: 'cursor', command: 'curl https://cursor.com/install -fsS | bash' },
] as const

/** 安装方法: where a device reports no coding agent, each agent's install command. */
function InstallAgents() {
  const t = useTranslations('Devices')
  const [copied, setCopied] = useState<string | null>(null)
  function copy(command: string) {
    void navigator.clipboard.writeText(command).then(() => setCopied(command), () => {})
  }
  return <Popover>
    <PopoverTrigger className="shrink-0 cursor-pointer text-foreground underline underline-offset-2">{t('installAgent')}</PopoverTrigger>
    <PopoverContent align="start" className="w-96 gap-2">
      {AGENT_INSTALL.map(({ harness, command }) => <div key={harness} className="flex flex-col gap-1">
        <span className="text-xs"><HarnessLabel harness={harness} /></span>
        <span className="flex items-center gap-1">
          <code className="min-w-0 flex-1 truncate font-mono text-xs">{command}</code>
          <Button variant="ghost" size="icon-sm" aria-label={t('copyInstall', { command })} onClick={() => copy(command)}>{copied === command ? <Check /> : <Copy />}</Button>
        </span>
      </div>)}
      <p className="text-xs text-muted-foreground">{t('installAgentHint')}</p>
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

function DeviceRow({ device, onChanged, onReconnect }: { device: DeviceView; onChanged: () => void; onReconnect: () => void }) {
  const t = useTranslations('Devices')
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const translateError = useActionError()
  const [renaming, setRenaming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const agents = installedAgents(device.harnesses)

  async function run(action: () => Promise<Result>, done?: () => void): Promise<boolean> {
    try {
      const result = await action()
      if ('error' in result) { toast.error(translateError(result.error)); return false }
      done?.()
      onChanged()
      return true
    } catch { toast.error(translateError('deviceSaveFailed')); return false }
  }

  // An offline device keeps the command until it reconnects (#491).
  const command = (kind: Command) => run(() => sendDeviceCommand({ deviceId: device.id, kind }), () => {
    toast.success(device.online ? t(`commands.sent.${kind}`, { name: device.name }) : t('commands.queued', { name: device.name }))
  })

  const status = device.online
    ? t('online')
    : device.lastSeenAt ? t('offlineSince', { time: format.relativeTime(new Date(device.lastSeenAt), now) }) : t('neverOnline')

  return <Item role="listitem" className="gap-3 rounded-none px-3.5 py-3">
    <DeviceTypeIcon device={device} />
    <span className={cn('flex min-w-0 flex-1 flex-col gap-0.5', !device.online && 'text-muted-foreground')}>
      <span className="truncate text-sm font-medium">{device.name}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className="truncate">{device.online && agents.length === 0 ? `${status} · ${t('noAgent')}` : status}</span>
        {device.online && (agents.length > 0
          ? <AgentMarks harnesses={agents} />
          : <InstallAgents />)}
      </span>
    </span>
    {!device.online && <Button variant="secondary" size="sm" onClick={onReconnect}>{t('reconnect')}</Button>}
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      <span aria-hidden="true" className="max-sm:hidden">{t('allowScheduling')}</span>
      <Switch checked={device.enabled} aria-label={t('allowSchedulingTo', { name: device.name })} onCheckedChange={enabled => { void run(() => setDeviceEnabled({ deviceId: device.id, enabled })) }} />
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
    <RenameDialog device={device} open={renaming} onOpenChange={setRenaming} onSave={name => run(() => renameDevice(device.id, name), () => setRenaming(false))} />
    <AlertDialog open={removing} onOpenChange={setRemoving}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('remove.title', { name: device.name })}</AlertDialogTitle>
          <AlertDialogDescription>{t('remove.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('remove.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => { void run(() => removeDevice(device.id), () => setRemoving(false)) }}>{t('remove.confirm')}</AlertDialogAction>
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
  const valid = trimmed.length > 0 && trimmed.length <= 60 && trimmed !== device.name
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
          <Input id={`rename-${device.id}`} autoFocus value={name} maxLength={60} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void save() } }} />
        </Field>
      </FieldGroup>
      <DialogFooter>
        <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>{t('rename.cancel')}</Button>
        <Button size="sm" disabled={!valid || saving} onClick={() => { void save() }}>{t('rename.save')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

function DeviceGroup({ title, devices, onChanged, onReconnect }: { title: string; devices: DeviceView[]; onChanged: () => void; onReconnect: () => void }) {
  return devices.length > 0 && <section aria-label={title} className="flex flex-col gap-2">
    <h2 className="px-1 text-sm font-medium text-muted-foreground">{title}</h2>
    <ItemGroup role="list" className="gap-0! overflow-hidden rounded-xl border bg-card">{devices.map((device, index) => <Fragment key={device.id}>{index > 0 && <ItemSeparator className="my-0" />}<DeviceRow device={device} onChanged={onChanged} onReconnect={onReconnect} /></Fragment>)}</ItemGroup>
  </section>
}

/**
 * 设置 › 设备 (Figma V09b 683:24269, S-L2 684:24422, S-L3 684:24731): only
 * machines the user connected, laptops under 本机 and SSH-installed servers
 * under Remote control. The bots' cloud computer is ours and never listed.
 * 添加设备 is the one-click SSH install in the desktop app (V09c) and the three
 * commands on the web (V09d), where the browser cannot open SSH (#491).
 */
export function DevicesSettings() {
  const t = useTranslations('Devices')
  const { data: devices = [], error, mutate } = useSWR('devices', listDevices, { refreshInterval: 5000 })
  const [adding, setAdding] = useState(false)
  const [desktopSsh, setDesktopSsh] = useState(false)
  useEffect(() => { setDesktopSsh(Boolean(bridgeFromWindow(window as MikkaWindow)?.ssh)) }, [])
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n' && !event.shiftKey && !event.altKey) { event.preventDefault(); setAdding(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const changed = () => { void mutate() }
  const reconnect = () => setAdding(true)
  return <div className="flex flex-col gap-6">
    <div className="flex items-center justify-between gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
      <Button size="sm" variant="secondary" aria-keyshortcuts="Meta+N Control+N" onClick={() => setAdding(true)}><Plus data-icon="inline-start" />{t('add.trigger')}</Button>
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{t('listError')}</p>}
    {devices.length === 0 ? <Empty className="rounded-xl border"><EmptyHeader><EmptyTitle>{t('emptyTitle')}</EmptyTitle></EmptyHeader></Empty> : <>
      <DeviceGroup title={t('thisMachine')} devices={devices.filter(device => device.deviceType !== 'server')} onChanged={changed} onReconnect={reconnect} />
      <DeviceGroup title={t('otherDevices')} devices={devices.filter(device => device.deviceType === 'server')} onChanged={changed} onReconnect={reconnect} />
    </>}
    {desktopSsh
      ? <SshAddDialog open={adding} onOpenChange={setAdding} devices={devices} onAdded={changed} />
      : <ConnectDeviceDialog open={adding} onOpenChange={setAdding} hideTrigger />}
  </div>
}
