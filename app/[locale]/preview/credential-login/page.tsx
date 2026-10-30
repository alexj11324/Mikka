import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { CredentialLoginHarness } from './harness'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { robots: { index: false, follow: false } }

// Test harness for the R-72 login card. Off unless the e2e server opts in;
// the browser test intercepts the credential API, no vault is touched.
export default function CredentialLoginPreview() {
  if (process.env.MIKKA_CREDENTIAL_HARNESS !== '1') notFound()
  return <main className="mx-auto flex max-w-sm flex-col gap-4 p-6">
    <Suspense><CredentialLoginHarness /></Suspense>
  </main>
}
