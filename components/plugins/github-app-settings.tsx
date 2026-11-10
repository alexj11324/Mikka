'use client'

import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { withBasePath } from '@/lib/base-path'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { openPathInBrowser } from '@/lib/platform/open-settings'
import { AppTile } from '@/components/plugins/connected-apps'
import { dropQueryKeys, workspaceLink } from '@/components/workspace/workspace-navigation'

const PATH = withBasePath('/api/github/manifest')
const details = ['admin', 'origin', 'state', 'encryption', 'storage', 'configured', 'request', 'response', 'template'] as const
type Detail = typeof details[number]
type AppStatus = { viewerId: string; admin: boolean; configured?: boolean; slug?: string | null; installUrl?: string | null; error?: string; detail?: Detail }
const detailOf = (value: unknown): Detail | 'default' => typeof value === 'string' && details.includes(value as Detail) ? value as Detail : 'default'

async function readStatus([, viewerId]: readonly [string, string]): Promise<AppStatus> {
  const response = await fetch(PATH, { cache: 'no-store' })
  const result = await response.json() as AppStatus
  if (result.viewerId !== viewerId || typeof result.admin !== 'boolean') throw new Error('viewer')
  return result
}

/**
 * The server's GitHub App, for a current server administrator only (`shown`): its state, and creating it through
 * GitHub's manifest flow (the form `ManifestForm` submits). Shared by the section below and UI layers.
 */
export function useGitHubAppSetup(userId: string) {
  const t = useTranslations('Settings.integrations')
  const failure = useTranslations('RunErrors.github_app_setup_failed')
  const { data, error, mutate } = useSWR([PATH, userId] as const, readStatus, { revalidateOnMount: false, revalidateOnFocus: false, shouldRetryOnError: false, dedupingInterval: 0 })
  useEffect(() => { void mutate() }, [mutate])
  const [open, setOpen] = useState(false)
  const [owner, setOwner] = useState<'personal' | 'organization'>('personal')
  const [organization, setOrganization] = useState('')
  const [working, setWorking] = useState(false)
  const [problem, setProblem] = useState<Detail | 'default' | null>(null)
  const [submission, setSubmission] = useState<{ action: string; manifest: string } | null>(null)
  const manifestForm = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (!submission) return
    try { manifestForm.current?.submit() }
    catch { setProblem('default'); setWorking(false); setSubmission(null) }
  }, [submission])

  useEffect(() => {
    if (error || data?.viewerId !== userId || !data.admin) return
    const url = new URL(window.location.href)
    if (url.searchParams.get('create-github-app') === '1') {
      if (!data.configured && !data.error) setOpen(true)
      dropQueryKeys('create-github-app')
    }
    const result = url.searchParams.get('github-app')
    if (!result) return
    if (result === 'created') toast.success(t('githubAppCreated'))
    else setProblem(detailOf(result))
    dropQueryKeys('github-app')
  }, [data, error, t, userId])

  async function create() {
    if (working) return
    setWorking(true); setProblem(null)
    try {
      const response = await fetch(PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(owner === 'organization' ? { organization: organization.trim() } : {}) })
      const result = await response.json() as { viewerId?: string; action?: string; manifest?: unknown; detail?: unknown }
      if (result.viewerId !== userId) { setProblem('admin'); setWorking(false); return }
      if (!response.ok) { setProblem(detailOf(result.detail)); setWorking(false); return }
      // GitHub's manifest flow is a browser form POST, so no Mikka proxy receives the provider setup.
      const action = new URL(result.action ?? '')
      if (action.origin !== 'https://github.com' || !/^\/(?:settings|organizations\/[A-Za-z\d-]+\/settings)\/apps\/new$/.test(action.pathname)
        || action.username || action.password || action.hash || !result.manifest || typeof result.manifest !== 'object') throw new Error('manifest')
      setSubmission({ action: action.toString(), manifest: JSON.stringify(result.manifest) })
    } catch { setProblem('default'); setWorking(false) }
  }

  const shown = !error && data?.viewerId === userId && data.admin
  const readFailed = Boolean(data?.error)
  const message = problem ? failure(problem) : readFailed ? failure(detailOf(data?.detail)) : null
  const owners = [{ value: 'personal', label: t('githubAppPersonal') }, { value: 'organization', label: t('githubAppOrganization') }]
  const begin = async () => {
    setProblem(null)
    try {
      const handoff = await openPathInBrowser(withBasePath(`${workspaceLink({ section: 'plugins' })}&app=github&create-github-app=1`))
      if (handoff === 'unsupported') setProblem('default')
      if (handoff === 'browser') setOpen(true)
    } catch { setProblem('default') }
  }
  return {
    shown, data: shown ? data : undefined, retry: () => { void mutate() }, readFailed, message, owners, owner, organization, working, open, setOpen, begin, create,
    setOwner: (value: string) => { if (value === 'personal' || value === 'organization') { setOwner(value); setProblem(null) } },
    setOrganization: (value: string) => { setOrganization(value); setProblem(null) },
    /** The hidden form that hands the manifest to GitHub; render it wherever the setup is shown. */
    manifest: submission && <form ref={manifestForm} method="POST" action={submission.action} hidden><FieldGroup><Field><Input type="hidden" name="manifest" value={submission.manifest} readOnly /></Field></FieldGroup></form>,
  }
}

/** Only a current server administrator sees this server-wide configuration. */
export function GitHubAppSettings({ userId }: { userId: string }) {
  const t = useTranslations('Settings.integrations')
  const common = useTranslations('Common')
  const setup = useGitHubAppSetup(userId)
  const { data, readFailed, message, owners, owner, organization, working, open, setOpen, begin, create } = setup
  if (!data) return null
  return <>
    {setup.manifest}
    <SettingsSection id="github-app-heading" title={t('githubApp')}>
      <SettingRow title={data.configured ? data.slug ?? t('githubAppConfigured') : t('githubNotConfigured')} icon={<AppTile app="github" />}>
        {readFailed ? <Button type="button" variant="secondary" size="sm" onClick={setup.retry}>{common('retry')}</Button>
          : data.configured ? data.installUrl && <Button variant="secondary" size="sm" nativeButton={false} render={<a href={data.installUrl} target="_blank" rel="noopener noreferrer" />}>{t('githubAuthorize')}</Button>
          : <Button type="button" variant="secondary" size="sm" onClick={() => { void begin() }}>{t('githubAppCreate')}</Button>}
      </SettingRow>
    </SettingsSection>
    {message && !open && <Alert variant="destructive"><AlertTitle>{message}</AlertTitle></Alert>}
    <Dialog open={open} onOpenChange={next => { if (!working) setOpen(next) }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('githubAppCreate')}</DialogTitle></DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void create() }}>
          <FieldGroup>
            <Field><FieldLabel htmlFor="github-app-owner">{t('githubAppOwner')}</FieldLabel>
              <Select value={owner} items={owners} disabled={working} onValueChange={value => { if (value) setup.setOwner(value) }}>
                <SelectTrigger id="github-app-owner" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>{owners.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
              </Select>
            </Field>
            {owner === 'organization' && <Field><FieldLabel htmlFor="github-app-organization">{t('githubAppOrganizationName')}</FieldLabel>
              <Input id="github-app-organization" value={organization} required pattern="[A-Za-z0-9](?:[A-Za-z0-9\-]{0,37}[A-Za-z0-9])?" maxLength={39} disabled={working} autoComplete="off" spellCheck={false} onChange={event => setup.setOrganization(event.target.value)} />
            </Field>}
          </FieldGroup>
          {message && <FieldError role="alert">{message}</FieldError>}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={working} onClick={() => setOpen(false)}>{common('cancel')}</Button>
            <Button type="submit" disabled={working || (owner === 'organization' && !organization.trim())}>{working ? t('working') : t('githubAppCreate')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </>
}
