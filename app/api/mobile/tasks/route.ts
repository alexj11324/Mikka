import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { listIssues } from '@/app/actions/issues'
import { json, mobileUser, unauthorized } from '@/lib/mobile-api'

export const dynamic = 'force-dynamic'

/** `GET /api/mobile/tasks`: the 任务 list: the person's tasks in this workspace, newest change first. No board on mobile. */
async function handleGET(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const issues = await listIssues()
  return json({
    tasks: issues.map(issue => ({
      id: issue.id, identifier: issue.identifier, title: issue.title, status: issue.status, priority: issue.priority,
      owner: issue.ownerName, updatedAt: issue.updatedAt,
    })),
  })
}

export const GET = withRequestLog('/api/mobile/tasks', handleGET)
