import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { isAcceptanceEnabled } from '@/lib/acceptance'
import { listIssues } from '@/app/actions/issues'
import { IssueWorkspace } from '@/components/workspace/issue-workspace'

export default async function Page({ searchParams }: { searchParams: Promise<{ acceptance?: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    if (!isAcceptanceEnabled()) redirect('/sign-in')
    const query = await searchParams
    redirect(query.acceptance === '1' ? '/acceptance' : '/api/acceptance')
  }
  const initialIssues = await listIssues()
  return <IssueWorkspace user={{ id: session.user.id, name: session.user.name, email: session.user.email, image: session.user.image }} initialIssues={initialIssues} />
}
