import 'server-only'
import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { userAvatars } from '@/lib/db/schema'
import { artifactStorage, deleteArtifactObject, getArtifactObjectBytes, putArtifactObject } from '@/lib/artifacts/storage'
import { withAccountWrite } from './write-guard'
import { AVATAR_EXTENSIONS, avatarPath, type AvatarContentType } from './avatar-file'

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

// Avatars share the private artifacts bucket (lib/artifacts/storage.ts) and are
// served by app/api/avatars/[userId]/[hash]. They are not written into
// user.image as data URLs: user.image travels with every session read, member
// list and RSC payload, so it stays a short URL.

/** Stores the picture and returns the path to put in user.image. Replaces any earlier upload. */
export async function saveAvatar(userId: string, contentType: AvatarContentType, bytes: Uint8Array): Promise<string> {
  const saved = await withAccountWrite(userId, () => saveWritableAvatar(userId, contentType, bytes))
  if (saved.retired) {
    try {
      await deleteArtifactObject(saved.retired)
      await db.execute(sql`delete from account_storage_retirements where "userId"=${userId} and "storageKey"=${saved.retired}`)
    } catch { console.warn('avatar_object_cleanup_failed') }
  }
  return saved.path
}

async function saveWritableAvatar(userId: string, contentType: AvatarContentType, bytes: Uint8Array): Promise<{ path: string; retired: string | null }> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'avatar:'} || ${userId},0))`)
  const sha256 = sha256Hex(bytes)
  const storage = artifactStorage()
  const storageKey = storage === 'r2' ? `avatars/${userId}/${sha256}.${AVATAR_EXTENSIONS[contentType]}` : null
  if (storageKey) await putArtifactObject(storageKey, new Uint8Array(bytes), contentType)
  const [previous] = await db.select({ storageKey: userAvatars.storageKey }).from(userAvatars).where(eq(userAvatars.userId, userId)).limit(1)
  const row = {
    sha256, contentType, size: bytes.length, storageKey,
    inlineContent: storageKey ? null : Buffer.from(bytes), updatedAt: new Date(),
  }
  if (previous?.storageKey && previous.storageKey !== storageKey) await db.execute(sql`insert into account_storage_retirements("userId","storageKey") values(${userId},${previous.storageKey}) on conflict do nothing`)
  await db.insert(userAvatars).values({ userId, ...row }).onConflictDoUpdate({ target: userAvatars.userId, set: row })
  return { path: avatarPath(userId, sha256), retired: previous?.storageKey && previous.storageKey !== storageKey ? previous.storageKey : null }
}

export interface AvatarFile { contentType: AvatarContentType; bytes: Uint8Array }

/** The current picture at that hash, or null once it has been replaced or removed. */
export async function readAvatar(userId: string, sha256: string): Promise<AvatarFile | null> {
  const [row] = await db.select().from(userAvatars).where(and(eq(userAvatars.userId, userId), eq(userAvatars.sha256, sha256))).limit(1)
  if (!row) return null
  if (row.inlineContent) return { contentType: row.contentType, bytes: new Uint8Array(row.inlineContent) }
  if (!row.storageKey) return null
  return { contentType: row.contentType, bytes: await getArtifactObjectBytes(row.storageKey) }
}
