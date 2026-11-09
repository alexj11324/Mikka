import 'server-only'
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { artifacts, artifactVersions } from '@/lib/db/schema'
import { withAccountWrite } from '@/lib/account/write-guard'
import { deleteArtifactObject } from '@/lib/artifacts/storage'
import { artifactChanged } from '@/lib/live/artifacts'
import { artifactWorkspace, type ArtifactReader } from './access'
import { taskReaderScope, withTaskWorkspace } from '@/lib/task-workspace'

/**
 * Deletes one of the person's own artifacts (资料库, R-51): the row, and with it
 * (on delete cascade) its versions and share links. Files kept in storage (a
 * version with no inline content) go the way an avatar's replaced file does
 * (lib/account/avatar.ts): their keys are recorded in account_storage_retirements
 * in the same transaction, removed from storage after the commit, and a key whose
 * removal fails stays recorded, so account deletion still finds it. False when it
 * is not theirs or no longer exists.
 */
export async function deleteOwnArtifact(reader: ArtifactReader, artifactId: string): Promise<boolean> {
  const workspaceId = await artifactWorkspace(reader, artifactId)
  if (!workspaceId) return false
  const { userId } = taskReaderScope(reader)
  const retired = await withTaskWorkspace(reader, workspaceId, () => withAccountWrite(userId, async () => {
    const [own] = await db.select({ id: artifacts.id, issueId: artifacts.issueId }).from(artifacts)
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.userId, userId), eq(artifacts.workspaceId, workspaceId))).limit(1).for('update')
    if (!own) return null
    const keys = (await db.select({ key: artifactVersions.storageKey }).from(artifactVersions)
      .where(and(eq(artifactVersions.artifactId, own.id), isNotNull(artifactVersions.storageKey), isNull(artifactVersions.inlineContent)))).map(row => row.key!)
    for (const key of keys) await db.execute(sql`insert into account_storage_retirements("userId","storageKey") values(${userId},${key}) on conflict do nothing`)
    await db.delete(artifacts).where(and(eq(artifacts.id, own.id), eq(artifacts.userId, userId)))
    await artifactChanged(db, userId, own.id, workspaceId)
    if (own.issueId) await (await import('@/lib/live/project-map')).projectMapIssueChanged(db, own.issueId)
    return keys
  }))
  if (!retired) return false
  for (const key of retired) {
    try {
      await deleteArtifactObject(key)
      await db.execute(sql`delete from account_storage_retirements where "userId"=${userId} and "storageKey"=${key}`)
    } catch { console.warn('artifact_object_cleanup_failed') }
  }
  return true
}
