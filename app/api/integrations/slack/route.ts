import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { withRequestLog } from '@/lib/request-log'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { secretsKey } from '@/lib/secrets/crypto'
import { installPlatform, selectableSlackChannel, slackChannels, uninstallSlack } from '@/lib/slack/install-provider'
import {
  installationCredential,
  installationStatus,
  startInstall,
  unlinkMember,
  uninstallForWorkspace,
  updatePreferences,
} from '@/lib/slack/installation-store'

export const runtime = 'nodejs'
const route = '/api/integrations/slack'
const reply = (value: unknown, status = 200) =>
  NextResponse.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } })
const body = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('connect'), workspaceId: z.uuid() }).strict(),
  z.object({ operation: z.literal('unlink'), workspaceId: z.uuid() }).strict(),
  z.object({ operation: z.literal('uninstall'), workspaceId: z.uuid() }).strict(),
  z
    .object({
      operation: z.literal('configure'),
      workspaceId: z.uuid(),
      enabled: z.boolean(),
      watched: z.array(z.string().refine(selectableSlackChannel)).max(100),
    })
    .strict(),
])
async function handle(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return reply({ error: 'authRequired' }, 401)
  const url = new URL(request.url),
    platform = installPlatform()
  const mutating = request.method === 'POST'
  if (
    mutating &&
    (request.headers.get('origin') !== url.origin ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      request.headers.get('x-mikka-viewer') !== session.user.id)
  )
    return reply({ error: 'originRejected' }, 403)
  const input = mutating ? body.safeParse(await request.json().catch(() => null)) : null
  if (input && !input.success) return reply({ error: 'validationGeneric' }, 400)
  const operation = input?.success ? input.data : null
  const workspace = operation?.workspaceId ?? url.searchParams.get('workspaceId')
  if (!workspace || !z.uuid().safeParse(workspace).success) return reply({ error: 'validationGeneric' }, 400)
  try {
    return await withTaskWorkspace(session.user, workspace, async (_, tx) => {
      if (!platform)
        return operation
          ? reply({ error: 'slackUnavailable' }, 503)
          : reply({
              configured: false,
              installation: null,
              viewerId: session.user.id,
              workspaceId: workspace,
              channels: [],
            })
      const owner = session.user.id,
        name = platform.appId
      const [member] = await tx
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspace),
            eq(workspaceMembers.userId, owner),
            eq(workspaceMembers.status, 'active'),
          ),
        )
        .limit(1)
      const admin = member?.role === 'admin'
      const existing = await installationStatus(pool, name, owner, workspace)
      if (!operation) {
        const metadata =
          url.searchParams.get('channels') === '1' && existing?.slackUserId && !existing.revoking
            ? await slackChannels(
                await installationCredential(pool, { app: name, owner, workspace }, { settings: true }),
                existing.slackUserId,
              )
            : []
        return reply({
          configured: true,
          viewerId: owner,
          workspaceId: workspace,
          installation: existing
            ? {
                teamName: existing.teamName,
                connected: existing.connected,
                enabled: existing.enabled,
                watched: existing.watched,
                canUninstall: existing.canUninstall || admin,
                revoking: existing.revoking,
              }
            : null,
          channels: metadata,
        })
      }
      if (operation.operation === 'connect') {
        secretsKey()
        const handoff = await startInstall(pool, owner, workspace, 'handoff')
        return reply({ intent: handoff })
      }
      if (operation.operation === 'unlink') {
        await unlinkMember(pool, name, owner, workspace)
        return reply({ ok: true })
      }
      if (operation.operation === 'uninstall') {
        const ok = await uninstallForWorkspace(
          pool,
          name,
          owner,
          workspace,
          (token) => uninstallSlack(platform, token),
          process.env,
          admin,
        )
        return ok ? reply({ ok: true }) : reply({ error: 'slackProviderUnavailable' }, 503)
      }
      const watched = [...new Set(operation.watched)]
      const additions = watched.filter((id) => !existing?.watched.includes(id))
      if (additions.length) {
        if (!existing?.slackUserId) return reply({ error: 'notFound' }, 404)
        const available = await slackChannels(
          await installationCredential(pool, { app: name, owner, workspace }, { settings: true }),
          existing.slackUserId,
        )
        const allowed = new Set(available.map((c) => c.id))
        if (additions.some((id) => !allowed.has(id))) return reply({ error: 'validationGeneric' }, 400)
      }
      await updatePreferences(pool, name, owner, workspace, operation.enabled, watched)
      return reply({ ok: true })
    })
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    if (code === 'workspaceAccessDenied' || code === 'slackInstallNotAuthorized')
      return reply({ error: 'notFound' }, 404)
    return reply({ error: 'slackUnavailable' }, 503)
  }
}
export const GET = withRequestLog(route, handle)
export const POST = withRequestLog(route, handle)
