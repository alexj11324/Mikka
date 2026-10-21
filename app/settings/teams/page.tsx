import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { loadTeamDirectory } from '@/app/actions/teams'
import { TeamDirectory } from '@/components/teams/team-directory'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

export const metadata: Metadata = { title: '团队管理 · Orvilo3', description: '浏览工作区公开团队，管理团队成员、任务归属与项目关联。' }
export default async function TeamsPage({ searchParams }: { searchParams: Promise<{ workspace?: string; team?: string; create?: string; view?: string }> }) {
  const query = await searchParams
  if (!(await getSession())?.user) redirect('/sign-in?next=%2Fsettings%2Fteams')
  const initial = await loadTeamDirectory(query.workspace).catch(() => null)
  if (!initial) return <section className="mx-auto flex max-w-lg flex-col gap-6 p-8" aria-label="团队目录访问错误"><Alert variant="destructive"><AlertTitle>无法访问团队目录</AlertTitle><AlertDescription>请确认工作区成员资格仍在启用中。</AlertDescription></Alert><Link href="/settings/teams" className="underline underline-offset-4">返回可访问的工作区</Link></section>
  return <TeamDirectory key={initial.workspace.id} initial={initial} />
}
