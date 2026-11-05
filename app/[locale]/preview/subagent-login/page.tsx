import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SubagentLoginNeeds } from '@/components/coordinator/subagent-login-needs'
import { LiveProvider } from '@/hooks/use-live-key'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { robots: { index: false, follow: false } }

// Test harness for the chat's sub-agent login card. Off unless the e2e server opts in;
// the browser fixture intercepts scoped JSON event pages and the credential API.
// Fixed render identities do not authorize reads: the real event route still
// requires its own fresh session and active workspace membership.
const BOT = '00000000-0000-4000-8000-0000000000b0'
const WORKSPACE = '00000000-0000-4000-8000-0000000000c0'

export default function SubagentLoginPreview() {
  if (process.env.MIKKA_CREDENTIAL_HARNESS !== '1') notFound()
  return <LiveProvider ownerId="subagent-login-preview" workspaceId={WORKSPACE}>
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <SubagentLoginNeeds botId={BOT} />
    </main>
  </LiveProvider>
}
