'use client'

import { useSearchParams } from 'next/navigation'
import { CredentialLoginCard } from '@/components/credentials/credential-login-card'

const RUN = '00000000-0000-4000-8000-000000000072'

/** `?run=` swaps the credential API without remounting the card, so tests can race a prefix change. */
export function CredentialLoginHarness() {
  const run = useSearchParams().get('run') ?? RUN
  return <CredentialLoginCard prefix={`/mikka/api/threads/${run}/credentials`} origin="https://dash.cloudflare.com" name="Cloudflare" />
}
