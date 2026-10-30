'use client'

import { CircleCheckIcon, EyeIcon, EyeOffIcon, LockIcon, XIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { MikkaMarkSmall } from '@/components/brand/mikka-mark'
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Input } from '@/components/ui/input'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Spinner } from '@/components/ui/spinner'
import { createLoginFlow, type LoginView } from '@/lib/credentials/login-flow'
import type { LoginCopy } from '@/lib/credentials/login-outcome'
import { SiteIcon } from './site-icon'

type Step = 'pill' | 'password' | 'code' | 'done'

/** R-72 secure login card. `prefix` is the thread or sub-agent credential API. */
export function CredentialLoginCard({ prefix, origin, name, onSignedIn }: { prefix: string; origin: string; name: string; onSignedIn?: () => void }) {
  const t = useTranslations('CredentialLogin')
  const flow = useMemo(() => createLoginFlow(prefix), [prefix])
  const [step, setStep] = useState<Step>('pill')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [codeLabel, setCodeLabel] = useState<LoginCopy>({ key: 'code' })
  const [reveal, setReveal] = useState(false)
  const [pending, setPending] = useState(false)
  const [view, setView] = useState<LoginView | null>(null)
  // Bumped on close: a response that lands after ✕ must not reopen or change the card.
  const generation = useRef(0)
  const pill = useRef<HTMLButtonElement>(null)
  const email = useRef<HTMLInputElement>(null)
  const otp = useRef<HTMLInputElement>(null)
  const refocusPill = useRef(false)

  useEffect(() => {
    if (step === 'password') email.current?.focus()
    if (step === 'code') otp.current?.focus()
    if (step === 'pill' && refocusPill.current) { refocusPill.current = false; pill.current?.focus() }
  }, [step])

  const copy = (message: LoginCopy) => t(`outcome.${message.key}`, message.values)

  function settle(next: LoginView) {
    setView(next.kind === 'signed_in' ? null : next)
    if (next.kind === 'signed_in') { setStep('done'); onSignedIn?.() }
    if (next.kind === 'needs_code') { setCodeLabel(next.label); setStep('code') }
  }
  async function run(request: () => Promise<LoginView>) {
    const mine = generation.current
    setPending(true)
    const next = await request()
    if (mine !== generation.current) return
    setPending(false)
    settle(next)
  }
  function close() {
    if (pending) return
    generation.current += 1
    refocusPill.current = true
    setPassword(''); setCode(''); setReveal(false); setView(null); setStep('pill')
  }
  function submitPassword(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    const secret = password
    // The secret leaves component state as soon as it is in flight.
    setPassword('')
    void run(() => flow.password(origin, username, secret))
  }
  function submitCode(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    const value = code
    setCode('')
    void run(() => flow.code(origin, value))
  }
  function recheck(attemptId: string) {
    if (!pending) void run(() => flow.recheck(attemptId))
  }

  const title = t('title', { site: name })
  if (step === 'pill') return <div>
    <Button ref={pill} type="button" onClick={() => setStep('password')}><SiteIcon origin={origin} data-icon="inline-start" />{title}</Button>
  </div>
  if (step === 'done') return <Item variant="muted" data-testid="credential-login-done">
    <ItemMedia><SiteIcon origin={origin} className="size-5" /></ItemMedia>
    <ItemContent><ItemTitle>{t('signedIn', { site: name })}</ItemTitle></ItemContent>
    <ItemActions><CircleCheckIcon className="text-success" /></ItemActions>
  </Item>

  const passwordInvalid = view?.kind === 'rejected' && view.field === 'password'
  const codeInvalid = view?.kind === 'rejected' && view.field === 'code'
  // Errors without a field show under the active field.
  const fieldError = view && (view.kind === 'rejected' || view.kind === 'error') ? <FieldError>{copy(view.message)}</FieldError> : null
  // 设计待 Alex 确认: waiting, unknown (with re-check) and needs_user have no Figma frame yet.
  const notice = view && (view.kind === 'waiting' || view.kind === 'unknown' || view.kind === 'needs_user')
    ? <Alert data-testid="credential-login-notice">
      <AlertDescription>{view.kind === 'waiting' ? t('outcome.waiting') : copy(view.message)}</AlertDescription>
      {view.kind !== 'needs_user' && view.attemptId ? <AlertAction>
        <Button type="button" size="sm" disabled={pending} onClick={() => recheck(view.attemptId!)}>{pending ? <Spinner data-icon="inline-start" /> : null}{t('recheck')}</Button>
      </AlertAction> : null}
    </Alert>
    : null
  const clearProblem = () => { if (view?.kind === 'rejected' || view?.kind === 'error') setView(null) }

  return <Card size="sm" data-testid="credential-login-card">
    <CardHeader>
      <CardTitle><span className="flex items-center gap-2.5"><SiteIcon origin={origin} className="size-5" />{title}</span></CardTitle>
      <CardAction><Button type="button" variant="secondary" size="icon-sm" aria-label={t('close')} disabled={pending} onClick={close}><XIcon data-icon="inline-start" /></Button></CardAction>
    </CardHeader>
    <CardContent>
      {step === 'password' ? <form onSubmit={submitPassword} autoComplete="off">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="credential-login-email">{t('email')}</FieldLabel>
            <Input ref={email} id="credential-login-email" type="email" autoComplete="off" spellCheck={false} placeholder={t('emailPlaceholder')} value={username} onChange={event => setUsername(event.target.value)} disabled={pending} required />
          </Field>
          <Field data-invalid={passwordInvalid || undefined}>
            <FieldLabel htmlFor="credential-login-password">{t('password')}</FieldLabel>
            <InputGroup>
              <InputGroupInput id="credential-login-password" type={reveal ? 'text' : 'password'} autoComplete="off" spellCheck={false} aria-invalid={passwordInvalid || undefined} value={password} onChange={event => { setPassword(event.target.value); clearProblem() }} disabled={pending} required />
              <InputGroupAddon align="inline-end">
                <InputGroupButton size="icon-xs" aria-label={reveal ? t('hidePassword') : t('showPassword')} aria-pressed={reveal} onClick={() => setReveal(value => !value)}>{reveal ? <EyeOffIcon /> : <EyeIcon />}</InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            {fieldError}
          </Field>
          {notice}
          <div className="flex justify-end">
            <Button type="submit" disabled={pending || !username || !password}>{pending ? <Spinner data-icon="inline-start" /> : null}{t('submit')}</Button>
          </div>
        </FieldGroup>
      </form> : <form onSubmit={submitCode} autoComplete="off">
        <FieldGroup>
          <Field data-invalid={codeInvalid || undefined}>
            <FieldLabel htmlFor="credential-login-code">{copy(codeLabel)}</FieldLabel>
            <InputOTP ref={otp} id="credential-login-code" maxLength={6} autoComplete="one-time-code" inputMode="numeric" value={code} onChange={value => { setCode(value); clearProblem() }} disabled={pending} aria-invalid={codeInvalid || undefined}>
              <InputOTPGroup>{[0, 1, 2, 3, 4, 5].map(index => <InputOTPSlot key={index} index={index} aria-invalid={codeInvalid || undefined} />)}</InputOTPGroup>
            </InputOTP>
            {fieldError}
          </Field>
          {notice}
          <div className="flex justify-end">
            <Button type="submit" disabled={pending || code.length < 6}>{pending ? <Spinner data-icon="inline-start" /> : null}{t('verify')}</Button>
          </div>
        </FieldGroup>
      </form>}
    </CardContent>
    <CardFooter>
      <span className="flex w-full items-center justify-center gap-1 text-xs text-muted-foreground"><LockIcon className="size-3" />{t('securedBy')}<MikkaMarkSmall />Mikka</span>
    </CardFooter>
  </Card>
}
