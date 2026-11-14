import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { PoolClient } from 'pg'
import { factoryEventId } from '../../lib/factory/event-id'
import { publicationEvidenceDigest, type PublicationEvidence, type PublicCapture } from '../../lib/captures/publication-contract'

type Query = Pick<PoolClient, 'query'>
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64')

/** Explicit synthetic stored media for a successful producer in DB fixtures.
 * The MP4 is a playable 0.2-second blue frame, not live acceptance evidence. */
export async function addFactoryVisualEvidence(db: Query, runId: string, options: { captureId?: string; kind?: 'image' | 'video' } = {}) {
  const { rows: [run] } = await db.query('SELECT "userId","issueId" FROM agent_runs WHERE id=$1', [runId])
  if (!run) throw new Error('Visual evidence fixture requires its producer run')
  const captureId = options.captureId ?? randomUUID(), kind = options.kind ?? 'image'
  const bytes = kind === 'video' ? await readFile(new URL('../fixtures/factory-visual-evidence.mp4', import.meta.url)) : png
  const contentType = kind === 'video' ? 'video/mp4' : 'image/png'
  await db.query(`INSERT INTO run_captures(id,"userId","runId","issueId",kind,"contentType",source,status,title,size,sha256,"inlineContent","storageKey","durationMs","createdAt","updatedAt")
    VALUES($1,$2,$3,$4,$5,$6,'local','ready','Synthetic visual verification fixture',$7,$8,$9,$10,$11,now()-interval '1 second',now()-interval '1 second')`,
  [captureId,run.userId,runId,run.issueId,kind,contentType,bytes.length,createHash('sha256').update(bytes).digest('hex'),bytes,
    `${run.userId}/runs/${runId}/captures/${captureId}.${kind === 'video' ? 'mp4' : 'png'}`,kind === 'video' ? 200 : null])
  return captureId
}

/** Synthetic host PR-body acknowledgement for a fixture's current producer.
 * Uses the production receipt shape and existing share rows. No GitHub call. */
export async function addFactoryPublicationEvidence(db: Query, taskId: string, options: { captureId?: string; url?: string } = {}) {
  const { rows: [current] } = await db.query(`SELECT t."userId",t."issueId",c.id AS "candidateId",c."runId",c.kind,c.sha,c.repository
    FROM factory_tasks t JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id WHERE t.id=$1`, [taskId])
  if (!current || current.kind !== 'repository') return null
  const { rows: [capture] } = await db.query(`SELECT id AS "captureId",kind,"contentType",size,"durationMs",sha256 FROM run_captures
    WHERE "runId"=$1 AND "userId"=$2 AND status='ready' AND ($3::uuid IS NULL OR id=$3) ORDER BY "createdAt",id LIMIT 1`,
    [current.runId,current.userId,options.captureId ?? null])
  if (!capture) throw new Error('PR evidence fixture requires current producer media')
  const token = `mkc_${randomBytes(24).toString('base64url')}`
  const publicCapture: PublicCapture = { ...capture, url: `https://evidence.example.invalid/api/captures/shared/${token}` }
  await db.query('INSERT INTO run_capture_shares(id,"captureId","tokenHash","createdBy") VALUES($1,$2,$3,$4)',
    [randomUUID(),capture.captureId,createHash('sha256').update(token).digest('hex'),current.userId])
  await db.query(`UPDATE agent_runs SET report=jsonb_build_object('summary','Synthetic completed producer','filesChanged','[]'::jsonb,
    'openQuestions','[]'::jsonb,'nextStep',NULL)||report||jsonb_build_object('visualEvidence',$2::jsonb,
      'publish',jsonb_build_object('branch','fixture','pushed',true,'remote',NULL)||(report->'publish')) WHERE id=$1`,
    [current.runId,JSON.stringify([{ captureId: capture.captureId, publicSafe: true }])])
  const unsigned = { version: 1 as const,taskId,candidateId: current.candidateId,runId: current.runId,sha: current.sha,
    userId: current.userId,issueId: current.issueId,captures: [publicCapture] }
  const receipt: PublicationEvidence = { ...unsigned,digest: publicationEvidenceDigest(unsigned) }
  await db.query(`INSERT INTO factory_events("taskId","eventId",request,result) VALUES($1,$2,$3,$4)
    ON CONFLICT ("taskId","eventId") DO UPDATE SET request=EXCLUDED.request,result=EXCLUDED.result`,
    [taskId,factoryEventId('pr-visual-evidence',current.runId),JSON.stringify({ kind:'pr_visual_evidence',taskId,candidateId:current.candidateId,runId:current.runId }),JSON.stringify(receipt)])
  await db.query(`INSERT INTO run_publications("runId","userId","issueId","remoteUrl","remoteKey",status,"pullRequest")
    VALUES($1,$2,$3,$4,$4,'published',$5) ON CONFLICT ("runId") DO UPDATE SET status='published',"pullRequest"=EXCLUDED."pullRequest"`,
    [current.runId,current.userId,current.issueId,current.repository,JSON.stringify({ url: options.url ?? 'https://github.com/alexj11324/Mikka/pull/1',state:'open',evidenceDigest:receipt.digest })])
  return receipt
}
