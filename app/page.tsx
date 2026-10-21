import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { isAcceptanceEnabled } from '@/lib/acceptance'
import { listIssues } from '@/app/actions/issues'
import { IssueWorkspace } from '@/components/workspace/issue-workspace'
import { getAgentHistory } from '@/lib/agent-store'

export default async function Page({ searchParams }: { searchParams: Promise<{ acceptance?: string; section?: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    if (!isAcceptanceEnabled()) redirect('/sign-in')
    const query = await searchParams
    redirect(query.acceptance === '1' ? '/acceptance' : '/api/acceptance')
  }
  const query = await searchParams
  const [initialIssues, initialAgentHistory] = await Promise.all([
    listIssues(),
    getAgentHistory(session.user.id).catch(() => undefined),
  ])
  return <IssueWorkspace key={session.user.id} user={{ id: session.user.id, name: session.user.name, email: session.user.email, image: session.user.image }} initialIssues={initialIssues} initialAgentHistory={initialAgentHistory} initialSection={query.section === 'agent' ? 'agent' : 'projects'} />
}
