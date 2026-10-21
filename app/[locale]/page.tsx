import { headers } from 'next/headers'
import { getLocale } from 'next-intl/server'

import { listIssues } from '@/app/actions/issues'
import { IssueWorkspace } from '@/components/workspace/issue-workspace'
import { redirect } from '@/i18n/navigation'
import { auth } from '@/lib/auth'

export default async function Page() {
  const session = await auth.api.getSession({ headers: await headers() })
  const user = session?.user
  if (!user) {
    redirect({ href: '/sign-in', locale: await getLocale() })
    return null
  }
  const initialIssues = await listIssues()
  return <IssueWorkspace user={{ id: user.id, name: user.name, email: user.email }} initialIssues={initialIssues} />
}
