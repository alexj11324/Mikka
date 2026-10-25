import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import type { Directory } from './group-conversations-store'
import { artifactAnchor, anchorStatus } from './artifact-anchors'
import { appendGroupMessage, enqueueWork, reject, requireAgent, requireGroup, transaction } from './group-review-access'

const content = z.string().max(1_000_000)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const base = { artifactId: z.uuid(), baseVersionId: z.uuid(), baseHash: hash }
export const artifactCommand = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), title: z.string().trim().min(1).max(200), mediaType: z.enum(['text/markdown','text/html','text/plain']), currentAgentId: z.uuid(), content }).strict(),
  z.object({ action: z.literal('read'), artifactId: z.uuid() }).strict(),
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('revise'), ...base, content }).strict(),
  z.object({ action: z.literal('thread'), ...base, anchor: artifactAnchor, body: z.string().trim().min(1).max(32000) }).strict(),
  z.object({ action: z.literal('comment'), artifactId: z.uuid(), threadId: z.uuid(), body: z.string().trim().min(1).max(32000) }).strict(),
  z.object({ action: z.literal('send'), ...base, threadId: z.uuid(), requestId: z.uuid() }).strict(),
  z.object({ action: z.literal('accept'), ...base }).strict(),
])
export const contentHash = (value: string) => createHash('sha256').update(value).digest('hex')
export async function insertVersion(client: PoolClient, artifactId: string, baseVersionId: string | null, content: string, authorType: 'user' | 'agent', authorId: string, workId: string | null = null, advanceHead = true) {
  const id = randomUUID(), hash = contentHash(content)
  await client.query(`INSERT INTO artifact_versions (id,"artifactId","baseVersionId",content,hash,"authorType","authorId","workId") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, artifactId, baseVersionId, content, hash, authorType, authorId, workId])
  if (advanceHead) await client.query('UPDATE artifacts SET "headVersionId"=$2 WHERE id=$1', [artifactId, id])
  return { id, hash }
}
export async function artifactForGroup(client: PoolClient, conversationId: string, artifactId: string) {
  const row = (await client.query('SELECT * FROM artifacts WHERE id=$1 AND "conversationId"=$2', [artifactId, conversationId])).rows[0]
  if (!row) return reject(404, 'not_found')
  return row
}
async function exactBase(client: PoolClient, artifact: { id: string; headVersionId: string }, versionId: string, hash: string) {
  const row = (await client.query('SELECT * FROM artifact_versions WHERE "artifactId"=$1 AND id=$2', [artifact.id, versionId])).rows[0]
  if (!row) return reject(404, 'not_found')
  if (row.hash !== hash) return reject(409, 'version_hash_conflict')
  if (artifact.headVersionId !== versionId) return reject(409, 'version_conflict')
  return row
}
/** Auth user comes from the session, never from the command. Group membership is
 * required even in the same workspace; all conflict checks share the group lock. */
export async function reviewArtifact(pool: Pool, directory: Directory, conversationId: string, userId: string, command: unknown) {
  const parsed = artifactCommand.safeParse(command)
  if (!parsed.success || !z.uuid().safeParse(conversationId).success) return reject(422, 'invalid_input')
  const input = parsed.data
  return transaction(pool, async client => {
    const { group } = await requireGroup(client, directory, conversationId, userId)
    if (input.action === 'list') return { artifacts: (await client.query('SELECT * FROM artifacts WHERE "conversationId"=$1 ORDER BY "createdAt",id', [conversationId])).rows }
    if (input.action === 'create') {
      await requireAgent(client, directory, conversationId, group.workspaceId, input.currentAgentId)
      const id = randomUUID()
      await client.query(`INSERT INTO artifacts (id,"conversationId",title,"mediaType","currentAgentId","createdBy") VALUES ($1,$2,$3,$4,$5,$6)`, [id, conversationId, input.title, input.mediaType, input.currentAgentId, userId])
      return { artifactId: id, version: await insertVersion(client, id, null, input.content, 'user', userId) }
    }
    const artifact = await artifactForGroup(client, conversationId, input.artifactId)
    if (input.action === 'read') {
      const versions = (await client.query('SELECT * FROM artifact_versions WHERE "artifactId"=$1 ORDER BY "createdAt",id', [artifact.id])).rows
      const threads = (await client.query('SELECT * FROM artifact_threads WHERE "artifactId"=$1 ORDER BY "createdAt",id', [artifact.id])).rows
      for (const thread of threads) {
        const version = versions.find(v => v.id === thread.versionId)
        thread.anchorStatus = anchorStatus(thread.anchor, version.content, artifact.mediaType, thread.versionId, artifact.headVersionId)
        thread.comments = (await client.query('SELECT * FROM artifact_comments WHERE "threadId"=$1 ORDER BY "createdAt",id', [thread.id])).rows
      }
      return { artifact, versions, threads, requests: (await client.query('SELECT r.*,w.status,w."agentId",ar.error AS "runtimeError" FROM artifact_change_requests r JOIN conversation_work w ON w.id=r."workId" LEFT JOIN agent_runs ar ON ar.id=w."runId" WHERE r."artifactId"=$1 ORDER BY w."createdAt"', [artifact.id])).rows, acceptances: (await client.query('SELECT * FROM artifact_acceptances WHERE "artifactId"=$1', [artifact.id])).rows }
    }
    if (input.action === 'comment') {
      const thread = (await client.query('SELECT 1 FROM artifact_threads WHERE id=$1 AND "artifactId"=$2', [input.threadId, artifact.id])).rows[0]
      if (!thread) return reject(404, 'not_found')
      const id = randomUUID()
      await client.query(`INSERT INTO artifact_comments (id,"threadId","authorType","authorId",body) VALUES ($1,$2,'user',$3,$4)`, [id, input.threadId, userId, input.body])
      return { commentId: id }
    }
    // Repeated explicit send returns its original intent, even after a proposal
    // advanced the head; the key cannot be replayed for another thread/base.
    if (input.action === 'send') {
      const previous = (await client.query('SELECT * FROM artifact_change_requests WHERE id=$1', [input.requestId])).rows[0]
      if (previous) {
        if (previous.artifactId !== artifact.id || previous.threadId !== input.threadId || previous.baseVersionId !== input.baseVersionId) return reject(409, 'request_conflict')
        const v = (await client.query('SELECT hash FROM artifact_versions WHERE id=$1', [previous.baseVersionId])).rows[0]
        if (v.hash !== input.baseHash) return reject(409, 'request_conflict')
        return { workId: previous.workId }
      }
    }
    const version = await exactBase(client, artifact, input.baseVersionId, input.baseHash)
    if (input.action === 'revise') return { version: await insertVersion(client, artifact.id, version.id, input.content, 'user', userId) }
    if (input.action === 'accept') {
      await client.query(`INSERT INTO artifact_acceptances ("artifactId","versionId",hash,"userId") VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [artifact.id, version.id, version.hash, userId])
      await client.query('UPDATE artifacts SET "acceptedVersionId"=$2 WHERE id=$1', [artifact.id, version.id])
      return { acceptedVersionId: version.id, hash: version.hash }
    }
    if (input.action === 'thread') {
      // Preserve invalid/ambiguous anchors visibly as orphaned. Never search for
      // a convenient match and silently attach it to another location/version.
      const status = anchorStatus(input.anchor, version.content, artifact.mediaType, version.id, artifact.headVersionId)
      const id = randomUUID()
      await client.query('INSERT INTO artifact_threads (id,"artifactId","versionId",anchor,"createdBy") VALUES ($1,$2,$3,$4,$5)', [id, artifact.id, version.id, JSON.stringify(input.anchor), userId])
      await client.query(`INSERT INTO artifact_comments (id,"threadId","authorType","authorId",body) VALUES ($1,$2,'user',$3,$4)`, [randomUUID(), id, userId, input.body])
      return { threadId: id, anchorStatus: status }
    }
    const thread = (await client.query('SELECT * FROM artifact_threads WHERE id=$1 AND "artifactId"=$2', [input.threadId, artifact.id])).rows[0]
    if (!thread) return reject(404, 'not_found')
    if (thread.versionId !== version.id || anchorStatus(thread.anchor, version.content, artifact.mediaType, thread.versionId, artifact.headVersionId) !== 'attached') return reject(409, 'anchor_outdated_or_orphaned')
    const comments = (await client.query('SELECT "authorType","authorId",body FROM artifact_comments WHERE "threadId"=$1 ORDER BY "createdAt",id', [thread.id])).rows
    // Explicit action creates a visible human trigger, separately from saving a comment.
    const trigger = await appendGroupMessage(client, conversationId, 'user', userId, JSON.stringify({ type: 'artifact_change_request', artifactId: artifact.id, versionId: version.id, hash: version.hash, threadId: thread.id, comments }))
    const work = await enqueueWork(client, directory, conversationId, userId, trigger.id, artifact.currentAgentId)
    await client.query('INSERT INTO artifact_change_requests (id,"artifactId","threadId","baseVersionId","workId") VALUES ($1,$2,$3,$4,$5)', [input.requestId, artifact.id, thread.id, version.id, work.id])
    return { workId: work.id, triggerMessageId: trigger.id }
  })
}
