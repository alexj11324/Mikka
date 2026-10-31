'use client'

import { useRef, useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowRightIcon, MailIcon } from 'lucide-react'
import { Auth } from '@/components/blocks/auth-19/components/auth'
import { AuthCard } from '@/components/blocks/auth-19/components/auth-card'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import { Link } from '@/i18n/navigation'
import { EMAIL_RESEND_COOLDOWN_SECONDS, recoveryMessageKey, type AuthRecoveryResult } from '@/lib/auth-recovery'
import { useCooldown } from './use-cooldown'
import { Turnstile, type TurnstileHandle } from './turnstile'

// One email field that asks the backend to send a link: the reset link on
// /forgot-password, the verification link on /verify-email. Only the person's
// click sends; the response never says whether an email went out.
export function EmailRequestForm({ title, description, submitLabel, send, turnstile = false }: { title: string; description?: string; submitLabel: string; send: (email: string, turnstileToken: string | null) => Promise<AuthRecoveryResult>; turnstile?: boolean }) {
  const t = useTranslations('Auth')
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)
  const [processed, setProcessed] = useState(false)
  const [error, setError] = useState('')
  const [cooldown, startCooldown] = useCooldown()
  const widget = useRef<TurnstileHandle>(null)
  const [token, setToken] = useState<string | null>(null)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pendingRef.current || cooldown > 0) return
    const email = String(new FormData(event.currentTarget).get('email')).trim()
    pendingRef.current = true
    setPending(true)
    setError('')
    try {
      const result = await send(email, token)
      if (result.ok) {
        setProcessed(true)
        startCooldown(EMAIL_RESEND_COOLDOWN_SECONDS)
      } else if (result.error === 'rate_limited') {
        startCooldown(result.retryAfter ?? EMAIL_RESEND_COOLDOWN_SECONDS)
      } else {
        setError(t(recoveryMessageKey(result.error)))
      }
    } catch {
      setError(t('connectionFailed'))
    } finally {
      // A Turnstile token is single-use, accepted or not.
      widget.current?.reset()
      pendingRef.current = false
      setPending(false)
    }
  }
  return <Auth label={title}>
    <AuthCard title={title} description={processed ? t('requestProcessed') : description}>
      {error && <p id="recovery-error" role="alert" className="text-destructive text-sm">{error}</p>}
      <form className="flex flex-col gap-5" onSubmit={submit} aria-busy={pending} aria-describedby={error ? 'recovery-error' : undefined}>
        <FieldGroup>
          <Field data-disabled={pending} className="gap-2">
            <FieldLabel htmlFor="email">{t('email')}</FieldLabel>
            <InputGroup>
              <InputGroupAddon><MailIcon aria-hidden="true" /></InputGroupAddon>
              <InputGroupInput id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required disabled={pending} />
            </InputGroup>
          </Field>
        </FieldGroup>
        {turnstile && <Turnstile ref={widget} onToken={setToken} />}
        <Button type="submit" variant={processed ? 'outline' : 'default'} className="w-full" disabled={pending || cooldown > 0}>
          {cooldown > 0 ? t('retryIn', { seconds: cooldown }) : processed ? t('resendLink') : submitLabel}
          {pending ? <Spinner data-icon="inline-end" /> : !processed && cooldown === 0 && <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />}
        </Button>
      </form>
      <p className="text-muted-foreground text-center text-xs">
        <Link href="/sign-in" className="text-foreground underline underline-offset-4">{t('backToSignIn')}</Link>
      </p>
    </AuthCard>
  </Auth>
}
