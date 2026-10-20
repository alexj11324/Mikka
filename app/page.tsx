import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { listIssues } from '@/app/actions/issues'
import { IssueWorkspace } from '@/components/workspace/issue-workspace'

export default async function Page() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/sign-in')
  const initialIssues = await listIssues()
  return <IssueWorkspace user={{ name: session.user.name, email: session.user.email }} initialIssues={initialIssues} />
}
