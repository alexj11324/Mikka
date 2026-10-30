import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { CredentialLoginCard } from '@/components/credentials/credential-login-card'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { robots: { index: false, follow: false } }

// Test harness for the R-72 login card. Off unless the e2e server opts in;
// the browser test intercepts the credential API, no vault is touched.
const RUN = '00000000-0000-4000-8000-000000000072'

export default function CredentialLoginPreview() {
  if (process.env.MIKKA_CREDENTIAL_HARNESS !== '1') notFound()
  return <main className="mx-auto flex max-w-sm flex-col gap-4 p-6">
    <CredentialLoginCard prefix={`/mikka/api/threads/${RUN}/credentials`} origin="https://dash.cloudflare.com" name="Cloudflare" />
  </main>
}
