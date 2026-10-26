'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { addDeviceRepo, createAgent, type DeviceView } from '@/app/actions/agents'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import type { SupportedHarness } from '@/lib/db/schema'

export function DeviceSetupDialog({ device, open, onOpenChange, onChanged }: { device: DeviceView; open: boolean; onOpenChange: (open: boolean) => void; onChanged: () => void }) {
  const t = useTranslations('DeviceSetup')
  const [path, setPath] = useState('')
  const [remote, setRemote] = useState('')
  const [branch, setBranch] = useState('main')
  const [verify, setVerify] = useState('')
  const [name, setName] = useState('')
  const harnesses = device.harnesses.filter(item => item.installed && (item.harness === 'codex' || item.harness === 'claude_code'))
  const [harness, setHarness] = useState<SupportedHarness | ''>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  async function saveRepo() {
    setBusy(true); setError(''); setSaved('')
    try { await addDeviceRepo({ deviceId: device.id, repoPath: path, remoteUrl: remote, baseBranch: branch, verifyCommand: verify }); setSaved(t('repoSaved')); onChanged() }
    catch { setError(t('repoError')) }
    finally { setBusy(false) }
  }
  async function saveAgent() {
    if (!harness) return
    setBusy(true); setError(''); setSaved('')
    try { await createAgent({ deviceId: device.id, harness, name, description: '', instructions: '' }); setSaved(t('agentSaved')); onChanged() }
    catch { setError(t('agentError')) }
    finally { setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>{t('title', { device: device.name })}</DialogTitle><DialogDescription>{t('description')}</DialogDescription></DialogHeader>
    <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void saveRepo() }}><FieldGroup>
      <Field><FieldLabel htmlFor="setup-path">{t('path')}</FieldLabel><Input id="setup-path" className="border-0 bg-muted" required value={path} onChange={event => setPath(event.target.value)} /></Field>
      <Field><FieldLabel htmlFor="setup-remote">{t('remote')}</FieldLabel><Input id="setup-remote" className="border-0 bg-muted" required value={remote} onChange={event => setRemote(event.target.value)} /></Field>
      <Field><FieldLabel htmlFor="setup-branch">{t('branch')}</FieldLabel><Input id="setup-branch" className="border-0 bg-muted" required value={branch} onChange={event => setBranch(event.target.value)} /></Field>
      <Field><FieldLabel htmlFor="setup-verify">{t('verify')}</FieldLabel><Input id="setup-verify" className="border-0 bg-muted" required value={verify} onChange={event => setVerify(event.target.value)} /></Field>
    </FieldGroup><Button size="sm" type="submit" disabled={busy || !device.online || !device.enabled}>{t('addRepo')}</Button></form>
    <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void saveAgent() }}><FieldGroup>
      <Field><FieldLabel htmlFor="setup-name">{t('agentName')}</FieldLabel><Input id="setup-name" className="border-0 bg-muted" required maxLength={60} value={name} onChange={event => setName(event.target.value)} /></Field>
      <Field><FieldLabel htmlFor="setup-harness">{t('harness')}</FieldLabel><NativeSelect className="[&>select]:border-0 [&>select]:bg-muted" id="setup-harness" required value={harness} onChange={event => setHarness(event.target.value as SupportedHarness | '')}><NativeSelectOption value="">{t('chooseHarness')}</NativeSelectOption>{harnesses.map(item => <NativeSelectOption key={item.harness} value={item.harness}>{item.harness === 'codex' ? 'Codex' : 'Claude Code'}</NativeSelectOption>)}</NativeSelect></Field>
    </FieldGroup><Button size="sm" type="submit" disabled={busy || !device.online || !device.enabled || !harness}>{t('addAgent')}</Button></form>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}{saved && <p role="status" className="text-xs">{saved}</p>}
  </DialogContent></Dialog>
}
