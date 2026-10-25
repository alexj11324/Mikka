import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { commandSchema, digest, ImprovementError, type Feedback } from './contract'
import { SCORER, SCORER_DIGEST, score } from './scorer'
import { createSkillCandidate, SKILL_PATH, BASELINE } from './regression'

type Authorize = (userId: string, issueId: string, tx: PoolClient) => Promise<boolean>
interface Run {
  id: string; userId: string; issueId: string; agentId: string; deviceRepoId: string;
  deviceId: string; repository: string; sessionId: string; status: string; report: Record<string, unknown> | null;
  stopRequestedAt: Date | null; finishedAt: Date; attempt: number; retryOf: string | null
}

function sameSource(snapshot: Record<string, unknown>, run: Run) {
  return snapshot.issueId === run.issueId && snapshot.agentId === run.agentId &&
    snapshot.deviceRepoId === run.deviceRepoId && snapshot.repository === run.repository
}

export function createImprovementStore(pool: Pool, authorize: Authorize) {
  async function withRun<T>(userId: string, runId: string, work: (tx: PoolClient, run: Run, bucket: string) => Promise<T>) {
    if (!userId || !commandSchema.options[1].shape.runId.safeParse(runId).success) throw new ImprovementError('notFound')
    const tx = await pool.connect()
    try {
      await tx.query('BEGIN')
      const { rows: [run] } = await tx.query<Run>(
        `SELECT r.*, coalesce(repo."remoteUrl", repo."repoPath") AS repository
         FROM agent_runs r JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=r."userId"
         WHERE r.id=$1 AND r."userId"=$2 FOR SHARE OF r,repo`, [runId, userId])
      if (!run?.issueId) throw new ImprovementError('notFound')
      await tx.query('SELECT id FROM issues WHERE id=$1 FOR SHARE', [run.issueId])
      if (!await authorize(userId, run.issueId, tx)) throw new ImprovementError('notFound')
      if (run.stopRequestedAt || !['succeeded', 'failed'].includes(run.status) || !run.sessionId || !run.finishedAt)
        throw new ImprovementError('runUnavailable')
      // Issue isolation is deliberately narrower than workspace access: feedback
      // never crosses an issue or guesses a workspace from user-supplied data.
      const bucket = digest({ userId, issueId: run.issueId, agentId: run.agentId,
        repository: run.repository, deviceRepoId: run.deviceRepoId,
        scorer: SCORER_DIGEST, skill: SKILL_PATH, baseline: digest(BASELINE) })
      const result = await work(tx, run, bucket)
      await tx.query('COMMIT')
      return result
    } catch (error) {
      await tx.query('ROLLBACK')
      throw error
    } finally { tx.release() }
  }

  async function ensureScorer(tx: PoolClient) {
    await tx.query('INSERT INTO improvement_scorers(digest,id,version,definition) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [SCORER_DIGEST, SCORER.id, SCORER.version, JSON.stringify(SCORER)])
    const { rows: [row] } = await tx.query('SELECT definition FROM improvement_scorers WHERE digest=$1', [SCORER_DIGEST])
    if (!row || digest(row.definition) !== SCORER_DIGEST) throw new ImprovementError('configurationDrift')
  }

  async function recordFeedback(userId: string, input: Feedback) {
    const parsed = commandSchema.safeParse(input)
    if (!parsed.success || parsed.data.action !== 'feedback') throw new ImprovementError('invalid')
    const feedback = parsed.data
    return withRun(userId, feedback.runId, async (tx, run, bucket) => {
      await ensureScorer(tx)
      // Event lock also serializes conflicting replays targeting different runs.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`improvement-event:${userId}:${feedback.eventId}`])
      const fingerprint = digest(feedback)
      const { rows: [old] } = await tx.query('SELECT id,fingerprint FROM improvement_feedback WHERE "userId"=$1 AND "eventId"=$2', [userId, feedback.eventId])
      if (old) {
        if (old.fingerprint !== fingerprint) throw new ImprovementError('conflict')
        const { rows: [previous] } = await tx.query('SELECT * FROM improvement_scores WHERE id=$1 AND "userId"=$2', [old.id, userId])
        if (!previous || !sameSource(previous.snapshot, run)) throw new ImprovementError('conflict')
        return previous
      }
      const id = randomUUID()
      const assessment = score(feedback.verdict, run.report)
      const publish = run.report?.publish
      const commit = publish && typeof publish === 'object' && 'commit' in publish && typeof publish.commit === 'string' && /^[a-f0-9]{40}$/.test(publish.commit) ? publish.commit : null
      const snapshot = { runId: run.id, issueId: run.issueId, agentId: run.agentId,
        sessionId: run.sessionId, attempt: run.attempt, retryOf: run.retryOf,
        repository: run.repository, deviceRepoId: run.deviceRepoId, environment: `device:${run.deviceId}`, status: run.status,
        finishedAt: run.finishedAt, reportDigest: digest(run.report), reportedCommit: commit,
        commitTrust: 'worker_report', skillUsage: 'unrecorded', scorer: SCORER,
        feedbackTrust: assessment.feedbackTrust, independentVerification: false }
      await tx.query(`INSERT INTO improvement_feedback(id,"userId","eventId","runId","issueId",fingerprint,verdict,note)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, userId, feedback.eventId, run.id, run.issueId, fingerprint, feedback.verdict, feedback.note])
      return (await tx.query(`INSERT INTO improvement_scores(id,"userId","runId",bucket,"scorerDigest",outcome,reason,snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [id, userId, run.id, bucket, SCORER_DIGEST, assessment.outcome, assessment.reason, JSON.stringify(snapshot)])).rows[0]
    })
  }

  async function propose(userId: string, runId: string) {
    return withRun(userId, runId, async (tx, run, bucket) => {
      await ensureScorer(tx)
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`improvement-bucket:${userId}:${bucket}`])
      // One immutable source per distinct run, not per feedback delivery. A
      // previously proposed run cannot repeatedly fund new proposals.
      const { rows: failures } = await tx.query(`SELECT DISTINCT ON (s."runId") s.id,s."runId",s."createdAt"
        FROM improvement_scores s JOIN agent_runs r ON r.id=s."runId"
        WHERE s."userId"=$1 AND s.bucket=$2 AND s.outcome='failure'
        AND r."userId"=$1 AND r."issueId"=$3 AND r."agentId"=$4 AND r."deviceRepoId"=$5
        AND r.status IN ('succeeded','failed') AND r."stopRequestedAt" IS NULL
        AND NOT EXISTS (SELECT 1 FROM improvement_proposal_sources p WHERE p."userId"=$1 AND p.bucket=$2 AND p."runId"=s."runId")
        ORDER BY s."runId",s."createdAt",s.id`, [userId, bucket, run.issueId, run.agentId, run.deviceRepoId])
      // Lock all source runs and recheck cancellation/binding after any writer
      // that raced the discovery query commits. Lock order is stable by run ID.
      const { rows: sources } = await tx.query(`SELECT id FROM agent_runs
        WHERE id=ANY($1::uuid[]) AND "userId"=$2 AND "issueId"=$3 AND "agentId"=$4 AND "deviceRepoId"=$5
        AND status IN ('succeeded','failed') AND "stopRequestedAt" IS NULL
        ORDER BY id FOR SHARE`, [failures.map(row => row.runId), userId, run.issueId, run.agentId, run.deviceRepoId])
      const eligible = new Set(sources.map(row => row.id))
      const currentFailures = failures.filter(row => eligible.has(row.runId))
      const { rows: [age] } = await tx.query(`SELECT min("createdAt") <= now()-($3 * interval '1 day') AS aged
        FROM improvement_scores WHERE "userId"=$1 AND bucket=$2 AND id=ANY($4::uuid[])`, [userId, bucket, SCORER.oldestFailureDays, currentFailures.map(row => row.id)])
      if (currentFailures.length < SCORER.distinctFailures && !age.aged) {
        const { rows: [existing] } = await tx.query('SELECT * FROM improvement_proposals WHERE "userId"=$1 AND bucket=$2 ORDER BY "createdAt" DESC,id DESC LIMIT 1', [userId, bucket])
        return { proposal: existing ?? null, pendingDistinctFailures: currentFailures.length, trigger: 'below_fixed_trigger' }
      }
      // The first loop leaves the candidate unchanged for human review. Further
      // feedback cannot manufacture duplicate proposals of identical bytes.
      const candidate = createSkillCandidate()
      const fingerprint = digest({ bucket, candidateDigest: candidate.candidateDigest })
      const { rows: [existing] } = await tx.query('SELECT * FROM improvement_proposals WHERE "userId"=$1 AND fingerprint=$2', [userId, fingerprint])
      if (existing) return { proposal: existing, pendingDistinctFailures: currentFailures.length, trigger: 'existing_candidate' }
      const id = randomUUID()
      const { result, ...document } = candidate
      const { rows: [proposal] } = await tx.query(`INSERT INTO improvement_proposals(id,"userId",bucket,fingerprint,"issueId","scorerDigest",candidate,result,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'awaiting_independent_review') RETURNING *`,
      [id, userId, bucket, fingerprint, run.issueId, SCORER_DIGEST, JSON.stringify(document), JSON.stringify(result)])
      for (const source of currentFailures) await tx.query(`INSERT INTO improvement_proposal_sources("proposalId","scoreId","userId",bucket,"runId") VALUES($1,$2,$3,$4,$5)`, [id, source.id, userId, bucket, source.runId])
      return { proposal, pendingDistinctFailures: 0, trigger: currentFailures.length >= SCORER.distinctFailures ? 'distinct_failures' : 'oldest_failure' }
    })
  }

  async function read(userId: string, runId: string) {
    return withRun(userId, runId, async (tx, run) => {
      // Authorization follows current source identity, not current scorer or
      // baseline version. Old immutable scores remain inspectable/replayable
      // after legitimate version upgrades, without leaking a moved issue.
      const scores = (await tx.query('SELECT * FROM improvement_scores WHERE "userId"=$1 AND "runId"=$2 ORDER BY "createdAt",id', [userId, run.id])).rows.filter(row => sameSource(row.snapshot, run))
      const proposals = (await tx.query(`SELECT p.* FROM improvement_proposals p
        WHERE p."userId"=$1 AND p."issueId"=$2 AND EXISTS (
          SELECT 1 FROM improvement_proposal_sources src JOIN improvement_scores s ON s.id=src."scoreId"
          WHERE src."proposalId"=p.id AND s.snapshot->>'issueId'=$2::text
          AND s.snapshot->>'agentId'=$3 AND s.snapshot->>'deviceRepoId'=$4 AND s.snapshot->>'repository'=$5)
        ORDER BY p."createdAt",p.id`, [userId, run.issueId, run.agentId, run.deviceRepoId, run.repository])).rows
      return { scores, proposals }
    })
  }
  return { recordFeedback, propose, read }
}
