import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { loadIssueDocument, encodedIssueDocument, upsertLinearComment } from '../linear-sync/document';
import { documentChanged } from '../live/panels';
import { withBasePath } from '../base-path';
import { factoryEventId } from './event-id';
import { readFactoryFlow } from './public-flow';
import { factoryFlowVersion } from './contract';
import { redactFactoryCheckText } from './checks';
import { syncFactoryAcceptanceArtifact } from './acceptance-report';
import type { FactoryTask } from './store';

/** Same task transaction and existing comment document; no worker, timer or new chat speaker. */
export async function syncFactoryPresentation(tx: PoolClient, task: FactoryTask) {
  if (factoryFlowVersion(task) !== 2) return;
  await syncFactoryAcceptanceArtifact(tx,task);
  if (!task.botId) return; // Legacy tasks have no mentioned Bot to impersonate.
  const flow = await readFactoryFlow(tx,task);
  const { rows: [bot] } = await tx.query<{ name: string; locale: string }>(`SELECT left(b.name,200) AS name,COALESCE(s.locale,'zh-CN') AS locale FROM bots b
    LEFT JOIN attention_settings s ON s."userId"=$2 WHERE b.id=$1 AND b."ownerId"=$2 LIMIT 1`,[task.botId,task.userId]);
  if (!bot) return;
  const en = bot.locale === 'en';
  const stages = en ? { triage: 'Triage', spec: 'Specification', implement: 'Implementation', review: 'Review', handoff: 'Ready for you', completed: 'Merged', cancelled: 'Cancelled' }
    : { triage: '分诊', spec: '方案', implement: '实现', review: '审阅', handoff: '交给你', completed: '已合并', cancelled: '已取消' };
  let body = stages[flow.stage];
  if (flow.needsYou?.kind === 'spec_review') body = en ? 'Specification ready for your review.' : '方案待审。';
  else if (flow.needsYou?.kind === 'question') body = en ? 'A question needs your answer.' : '有问题需要你回答。';
  else if (flow.needsYou?.kind === 'blocked' || flow.needsYou?.kind === 'failed') body = `${en ? flow.needsYou.kind === 'blocked' ? 'Blocked' : 'Failed' : flow.needsYou.kind === 'blocked' ? '阻塞' : '失败'}: ${redactFactoryCheckText(task.reason).slice(0,500)}`;
  else if (flow.stage === 'handoff' && flow.acceptance) {
    const { counts, artifactId } = flow.acceptance;
    body = en ? `${counts.passed ?? 0} verified, ${counts.unverified ?? 0} unverified.` : `${counts.passed ?? 0} 项已验证，${counts.unverified ?? 0} 项未验证。`;
    if (counts.failed) body += en ? ` ${counts.failed} failed.` : ` ${counts.failed} 项失败。`;
    body += ` [${en ? 'Acceptance' : '验收'}](${withBasePath(`/?artifact=${artifactId}`)})`;
  }
  if (flow.pullRequest?.url && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(flow.pullRequest.url)) body += ` [PR](${flow.pullRequest.url})`;
  const hash = createHash('sha256').update(body).digest('hex');
  const { rows: [prior] } = await tx.query('SELECT "bodyHash","commentId","createdAt" FROM factory_stage_updates WHERE "taskId"=$1 AND stage=$2 LIMIT 1',[task.id,flow.stage]);
  if (prior?.bodyHash === hash) return;
  const { rows: [issue] } = await tx.query('SELECT id,"userId",content FROM issues WHERE id=$1',[task.issueId]);
  // Task authorization already holds an issue SHARE lock. Never upgrade it:
  // two distinct tasks on this issue may reach this hook concurrently.
  let { rows: [document] } = await tx.query('SELECT state FROM issue_documents WHERE "issueId"=$1 FOR UPDATE',[task.issueId]);
  if (!document) {
    const initial = loadIssueDocument(null,issue.content);
    try {
      await tx.query('INSERT INTO issue_documents ("issueId","userId",state) VALUES ($1,$2,$3) ON CONFLICT ("issueId") DO NOTHING',
        [task.issueId,issue.userId,encodedIssueDocument(initial)]);
    } finally { initial.destroy(); }
    // A concurrent creator's insert waits for COMMIT. Read and lock its saved
    // document before adding this task's comment, preserving both threads.
    ({ rows: [document] } = await tx.query('SELECT state FROM issue_documents WHERE "issueId"=$1 FOR UPDATE',[task.issueId]));
  }
  const doc = loadIssueDocument(document.state,issue.content);
  const commentId = prior?.commentId ?? factoryEventId(`stage-comment:${flow.stage}`,task.id);
  const at = prior?.createdAt ? new Date(prior.createdAt).toISOString() : new Date().toISOString();
  try {
    upsertLinearComment(doc,{ threadId: task.id, messageId: commentId, author: bot.name, body, at });
    await tx.query(`INSERT INTO issue_documents ("issueId","userId",state,"updatedAt") VALUES ($1,$2,$3,now())
      ON CONFLICT ("issueId") DO UPDATE SET state=excluded.state,"updatedAt"=now()`,[task.issueId,issue.userId,encodedIssueDocument(doc)]);
    await tx.query(`INSERT INTO factory_stage_updates ("taskId",stage,"commentId","bodyHash") VALUES ($1,$2,$3,$4)
      ON CONFLICT ("taskId",stage) DO UPDATE SET "bodyHash"=excluded."bodyHash","updatedAt"=now()`,[task.id,flow.stage,commentId,hash]);
    await documentChanged(tx,task.issueId);
  } finally { doc.destroy(); }
}
