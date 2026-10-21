'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { Check, Circle, Plus, TerminalSquare } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { CodeBlock, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle } from '@/components/reui/code-block/code-block'
import { IconTile } from '@/components/reui/icon-tile'
import { createDeviceToken, listLocalSshHosts, type SshHostView } from '@/app/actions/agents'
import { useActionError } from '@/lib/use-action-error'
import { cn } from '@/lib/utils'

type Mode = 'form' | 'progress' | 'manual'
type StepKey = 'login' | 'check' | 'install' | 'start' | 'connect'
type StepState = 'idle' | 'active' | 'done' | 'failed'

const STEP_KEYS: StepKey[] = ['login', 'check', 'install', 'start', 'connect']

const EMPTY_STEPS = Object.fromEntries(STEP_KEYS.map(key => [key, { state: 'idle' as StepState, detail: '' }])) as Record<StepKey, { state: StepState; detail: string }>

function StepMark({ state }: { state: StepState }) {
  if (state === 'done') return <Check className="size-3.5 text-success-foreground" aria-hidden="true" />
  if (state === 'active') return <Spinner aria-hidden="true" />
  if (state === 'failed') return <Circle className="size-3.5 text-destructive" aria-hidden="true" />
  return <Circle className="size-3.5 text-muted-foreground" aria-hidden="true" />
}

/** The two commands a person runs by hand when SSH is not an option. */
function manualCommands(token: string, labels: { login: string; start: string }): string {
  return [
    labels.login,
    `pnpm daemon:login -- --token ${token}`,
    '',
    labels.start,
    'pnpm daemon',
  ].join('\n')
}

/**
 * Connects a machine that runs agents. The SSH path does the work from this
 * server: log in, check the host, install the daemon, start it, wait for its
 * first heartbeat. The manual path hands over a token instead.
 */
export function ConnectDeviceDialog() {
  const t = useTranslations('Devices.connect')
  const commonT = useTranslations('Common')
  const locale = useLocale()
  const translateError = useActionError()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('form')
  const [host, setHost] = useState('')
  const [actAs, setActAs] = useState('')
  const [hosts, setHosts] = useState<SshHostView[]>([])
  const [steps, setSteps] = useState(EMPTY_STEPS)
  const [error, setError] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    void listLocalSshHosts().then(list => { if (alive) setHosts(list) }).catch(() => undefined)
    return () => { alive = false }
  }, [open])

  function reset() {
    abort.current?.abort()
    setMode('form'); setHost(''); setActAs(''); setSteps(EMPTY_STEPS); setError(''); setToken(null)
  }

  async function connect() {
    if (!host.trim()) return
    setError('')
    setSteps(EMPTY_STEPS)
    setMode('progress')
    const controller = new AbortController()
    abort.current = controller
    try {
      const response = await fetch('/api/devices/ssh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host, user: actAs, name: '', locale }),
        signal: controller.signal,
      })
      if (!response.ok || !response.body) throw new Error('connect failed')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line) as { step: StepKey; state: StepState; detail?: string }
            setSteps(previous => ({ ...previous, [event.step]: { state: event.state, detail: event.detail ?? '' } }))
          } catch { /* a partial line; the next chunk completes it */ }
        }
      }
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(t('interrupted'))
    }
  }

  function mintToken() {
    setError('')
    startTransition(async () => {
      try {
        const result = await createDeviceToken({ name: '' })
        if ('error' in result) { setError(translateError(result.error)); return }
        setToken(result.token)
      } catch {
        setError(t('tokenFailed'))
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={next => { setOpen(next); if (!next) reset() }}>
      <DialogTrigger render={<Button size="sm" />}>
        <Plus data-icon="inline-start" />
        {t('trigger')}
      </DialogTrigger>
      <DialogContent closeLabel={commonT('close')} className="sm:max-w-xl">
        {mode === 'form' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <IconTile variant="frame" aria-hidden="true"><TerminalSquare /></IconTile>
                {t('title')}
              </DialogTitle>
              <DialogDescription>
                {t('description')}
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="ssh-host">{t('host')}</FieldLabel>
                <Input id="ssh-host" value={host} placeholder={t('hostPlaceholder')} onChange={event => setHost(event.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="ssh-user">{t('actAs')}</FieldLabel>
                <Input id="ssh-user" value={actAs} placeholder={t('actAsPlaceholder')} onChange={event => setActAs(event.target.value)} />
              </Field>
            </FieldGroup>
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-muted-foreground">{t('fromConfig')}</p>
              {hosts.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('noHosts')}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {hosts.map(item => (
                    <li key={item.alias}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full justify-between"
                        onClick={() => { setHost(item.hostName ?? item.alias); setActAs(item.user ?? '') }}
                      >
                        <span className="truncate font-mono">{item.alias}</span>
                        <span className="text-xs text-muted-foreground">{item.hostName ?? 'ssh'}</span>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setMode('manual')}>{t('manualToken')}</Button>
              <Button size="sm" disabled={!host.trim()} onClick={connect}>{t('connect')}</Button>
            </DialogFooter>
          </>
        )}

        {mode === 'progress' && (
          <>
            <DialogHeader>
              <DialogTitle>{t('connectingHost', { host })}</DialogTitle>
              <DialogDescription>{t('progressDescription')}</DialogDescription>
            </DialogHeader>
            <ul className="flex flex-col gap-3">
              {STEP_KEYS.map(key => {
                const status = steps[key]
                return (
                  <li key={key} className="flex items-start gap-3">
                    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center"><StepMark state={status.state} /></span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className={cn(status.state === 'idle' ? 'text-sm text-muted-foreground' : 'text-sm font-medium')}>{t(`steps.${key}`)}</span>
                      {status.detail && <span className="truncate text-xs text-muted-foreground">{status.detail}</span>}
                    </span>
                  </li>
                )
              })}
            </ul>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={reset}>{commonT('cancel')}</Button>
              {steps.connect.state === 'done' && <Button size="sm" onClick={() => setOpen(false)}>{t('done')}</Button>}
            </DialogFooter>
          </>
        )}

        {mode === 'manual' && (
          <>
            <DialogHeader>
              <DialogTitle>{t('manualTitle')}</DialogTitle>
              <DialogDescription>
                {t('manualDescription')}
              </DialogDescription>
            </DialogHeader>
            {token ? (
              <div className="flex flex-col gap-2">
                <CodeBlock code={manualCommands(token, { login: t('manual.loginComment'), start: t('manual.startComment') })} language="bash" defaultWrap>
                  <CodeBlockHeader>
                    <CodeBlockTitle>{t('commandTitle')}</CodeBlockTitle>
                    <CodeBlockCopyButton className="ml-auto" labels={{ copy: t('copyCommand'), copied: t('copied') }} />
                  </CodeBlockHeader>
                </CodeBlock>
                <p className="text-xs text-muted-foreground">{t('tokenOnce')}</p>
              </div>
            ) : (
              <FieldDescription>{t('tokenHint')}</FieldDescription>
            )}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setMode('form')}>{t('back')}</Button>
              {token
                ? <Button size="sm" onClick={() => setOpen(false)}>{t('done')}</Button>
                : <Button size="sm" disabled={pending} onClick={mintToken}>{pending && <Spinner data-icon="inline-start" />}{t('generateToken')}</Button>}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
