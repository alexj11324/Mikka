'use client'

import { CircleCheckIcon, EyeIcon, EyeOffIcon, LockIcon, XIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useMemo, useState, type FormEvent } from 'react'
import { Mikka } from '@/components/ui/svgs/mikka'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Input } from '@/components/ui/input'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Spinner } from '@/components/ui/spinner'
import { createLoginFlow, type LoginOutcome } from '@/lib/credentials/login-flow'
import { SiteIcon } from './site-icon'

type Step = 'pill' | 'password' | 'code' | 'done'
type Problem = 'rejected' | 'failed' | null

/** R-72 secure login card. `prefix` is the thread or sub-agent credential API. */
export function CredentialLoginCard({ prefix, origin, name, onSignedIn }: { prefix: string; origin: string; name: string; onSignedIn?: () => void }) {
  const t = useTranslations('CredentialLogin')
  const flow = useMemo(() => createLoginFlow(prefix), [prefix])
  const [step, setStep] = useState<Step>('pill')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [reveal, setReveal] = useState(false)
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<Problem>(null)

  function settle(outcome: LoginOutcome) {
    setProblem(outcome === 'rejected' || outcome === 'failed' ? outcome : null)
    if (outcome === 'signed_in') { setStep('done'); onSignedIn?.() }
    if (outcome === 'needs_code') setStep('code')
  }
  function close() {
    setPassword(''); setCode(''); setReveal(false); setProblem(null); setStep('pill')
  }
  async function submitPassword(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    const secret = password
    // The secret leaves component state as soon as it is in flight.
    setPassword('')
    const outcome = await flow.password(origin, username, secret)
    setPending(false)
    settle(outcome)
  }
  async function submitCode(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    const value = code
    setCode('')
    const outcome = await flow.code(origin, value)
    setPending(false)
    settle(outcome)
  }

  const title = t('title', { site: name })
  if (step === 'pill') return <div>
    <Button type="button" onClick={() => setStep('password')}><SiteIcon origin={origin} data-icon="inline-start" />{title}</Button>
  </div>
  if (step === 'done') return <Item variant="muted" data-testid="credential-login-done">
    <ItemMedia><SiteIcon origin={origin} /></ItemMedia>
    <ItemContent><ItemTitle>{t('signedIn', { site: name })}</ItemTitle></ItemContent>
    <ItemActions><CircleCheckIcon className="text-success" /></ItemActions>
  </Item>

  const failed = problem === 'failed' ? <FieldError>{t('failed')}</FieldError> : null
  return <Card size="sm" data-testid="credential-login-card">
    <CardHeader>
      <CardTitle><span className="flex items-center gap-2.5"><SiteIcon origin={origin} />{title}</span></CardTitle>
      <CardAction><Button type="button" variant="secondary" size="icon-sm" aria-label={t('close')} onClick={close}><XIcon data-icon="inline-start" /></Button></CardAction>
    </CardHeader>
    <CardContent>
      {step === 'password' ? <form onSubmit={submitPassword} autoComplete="off">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="credential-login-email">{t('email')}</FieldLabel>
            <Input id="credential-login-email" type="email" autoComplete="off" spellCheck={false} placeholder={t('emailPlaceholder')} value={username} onChange={event => setUsername(event.target.value)} disabled={pending} required />
          </Field>
          <Field data-invalid={problem === 'rejected' || undefined}>
            <FieldLabel htmlFor="credential-login-password">{t('password')}</FieldLabel>
            <InputGroup>
              <InputGroupInput id="credential-login-password" type={reveal ? 'text' : 'password'} autoComplete="off" spellCheck={false} aria-invalid={problem === 'rejected' || undefined} value={password} onChange={event => { setPassword(event.target.value); setProblem(null) }} disabled={pending} required />
              <InputGroupAddon align="inline-end">
                <InputGroupButton size="icon-xs" aria-label={reveal ? t('hidePassword') : t('showPassword')} aria-pressed={reveal} onClick={() => setReveal(value => !value)}>{reveal ? <EyeOffIcon /> : <EyeIcon />}</InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            {problem === 'rejected' ? <FieldError>{t('wrongPassword')}</FieldError> : failed}
          </Field>
          <div className="flex justify-end">
            <Button type="submit" disabled={pending || !username || !password}>{pending ? <Spinner data-icon="inline-start" /> : null}{t('submit')}</Button>
          </div>
        </FieldGroup>
      </form> : <form onSubmit={submitCode} autoComplete="off">
        <FieldGroup>
          <Field data-invalid={problem === 'rejected' || undefined}>
            <FieldLabel htmlFor="credential-login-code">{t('code')}</FieldLabel>
            <InputOTP id="credential-login-code" maxLength={6} autoComplete="one-time-code" inputMode="numeric" value={code} onChange={value => { setCode(value); setProblem(null) }} disabled={pending} aria-invalid={problem === 'rejected' || undefined}>
              <InputOTPGroup>{[0, 1, 2, 3, 4, 5].map(index => <InputOTPSlot key={index} index={index} aria-invalid={problem === 'rejected' || undefined} />)}</InputOTPGroup>
            </InputOTP>
            {problem === 'rejected' ? <FieldError>{t('wrongCode')}</FieldError> : failed}
          </Field>
          <div className="flex justify-end">
            <Button type="submit" disabled={pending || code.length < 6}>{pending ? <Spinner data-icon="inline-start" /> : null}{t('verify')}</Button>
          </div>
        </FieldGroup>
      </form>}
    </CardContent>
    <CardFooter>
      <span className="flex w-full items-center justify-center gap-1 text-xs text-muted-foreground"><LockIcon className="size-3" />{t('securedBy')}<Mikka className="size-3" />Mikka</span>
    </CardFooter>
  </Card>
}
