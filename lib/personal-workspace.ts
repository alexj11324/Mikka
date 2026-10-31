import 'server-only'
import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaces, workspaceMembers } from '@/lib/db/workspace-schema'
import { defaultWorkspaceName, type WorkspaceLocale } from '@/lib/workspace-name'

const workspaceUUID = (seed: string) => {
  const hash = createHash('sha256').update(seed).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

/** The person's one personal workspace (decision 2026-10-31-2130), created on first need. Idempotent. */
export async function ensurePersonalWorkspace(user: { id: string; email: string; name: string }, locale: WorkspaceLocale): Promise<string> {
  return workspaceDb.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-owner:${user.id}`}, 0))`)
    const [own] = await tx.select({ id: workspaces.id }).from(workspaces).where(and(eq(workspaces.userId, user.id), eq(workspaces.kind, 'personal'))).limit(1)
    if (own) return own.id
    // The sign-up default id when it is free; otherwise (it became a team) a second deterministic id.
    let id = workspaceUUID(`orvilo-default:${user.id}`)
    const [taken] = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, id)).limit(1)
    if (taken) id = workspaceUUID(`mikka-personal:${user.id}`)
    await tx.insert(workspaces).values({ id, userId: user.id, name: defaultWorkspaceName(locale, user.name).slice(0, 120), kind: 'personal' }).onConflictDoNothing()
    await tx.insert(workspaceMembers).values({ workspaceId: id, userId: user.id, email: user.email.toLowerCase(), name: user.name, role: 'admin' }).onConflictDoNothing()
    return id
  })
}
