import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { isAcceptanceEnabled } from '@/lib/acceptance'
import { listIssues } from '@/app/actions/issues'
import { WorkspaceApp } from '@/components/workspace-app'

export default async function Page({ searchParams }: { searchParams: Promise<{ acceptance?: string; issue?: string }> }) {
  const query = await searchParams
  const initialSelected = query.issue && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.issue) ? query.issue : null
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    if (initialSelected) redirect(`/sign-in?next=${encodeURIComponent(`/?issue=${initialSelected}`)}`)
    if (!isAcceptanceEnabled()) redirect('/sign-in')
    redirect(query.acceptance === '1' ? '/acceptance' : '/api/acceptance')
  }
  const initialIssues = await listIssues()
  return <WorkspaceApp initialSelected={initialSelected} user={{ id: session.user.id, name: session.user.name, email: session.user.email, image: session.user.image }} initialIssues={initialIssues} />
}
