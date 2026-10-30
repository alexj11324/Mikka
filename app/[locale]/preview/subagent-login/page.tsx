import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SubagentLoginNeeds } from '@/components/coordinator/subagent-login-needs'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { robots: { index: false, follow: false } }

// Test harness for the chat's sub-agent login card. Off unless the e2e server opts in;
// the browser test intercepts the event stream and the credential API.
const BOT = '00000000-0000-4000-8000-0000000000b0'

export default function SubagentLoginPreview() {
  if (process.env.MIKKA_CREDENTIAL_HARNESS !== '1') notFound()
  return <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
    <SubagentLoginNeeds botId={BOT} />
  </main>
}
