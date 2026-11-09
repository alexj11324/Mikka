import chineseMessages from '@/messages/zh-CN.json';
import englishMessages from '@/messages/en.json';
import { createHash, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { planSpec } from '@mikka/protocol/plan';
import { cleanTitle } from '../artifacts/limits';
import { artifactStorage, putArtifactObject } from '../artifacts/storage';
import { recordCoordinatorEvent } from '../coordinator-event-store';
import { artifactSubmittedEvent } from '../coordinator-events';
import { executionIdentityForRun } from '../execution-identity';
import { artifactChanged } from '../live/artifacts';
import { FactoryError } from './contract';
import { factoryEventId } from './event-id';
import { maskFactoryNote } from './note-mask';
import type { FactoryTask } from './store';

export interface FactorySpecArtifactRef { artifactId: string; version: number; runId: string; sha256: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parsing identifies a reference; the caller must still join its owner/run/issue. */
export function parseFactorySpecArtifactRef(value: unknown): FactorySpecArtifactRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ref = value as Record<string, unknown>;
  return typeof ref.artifactId === 'string' && UUID.test(ref.artifactId) && typeof ref.runId === 'string' && UUID.test(ref.runId) &&
    typeof ref.version === 'number' && Number.isSafeInteger(ref.version) && ref.version > 0 &&
    typeof ref.sha256 === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256)
    ? { artifactId: ref.artifactId, version: ref.version, runId: ref.runId, sha256: ref.sha256 } : null;
}

function bounded(value: string, bytes: number): string {
  const text = maskFactoryNote(value), encoded = Buffer.from(text);
  return encoded.length <= bytes ? text : encoded.subarray(0, bytes - 12).toString('utf8') + '\n[…]';
}
const plain = (value: string) => value.replace(/[\\`*_{}[\]<>#]/g, '\\$&');
export interface FactorySpecSource { runId: string; title: string; summary: string | null; specification: unknown; locale: string }

/** Preserve the daemon's structured plan when present; older plan runs retain
 * their submitted summary. Prompts, logs and execution-session ids are excluded. */
export function factorySpecMarkdown(source: FactorySpecSource): { title: string; content: string } {
  const messages = (source.locale === 'en' ? englishMessages : chineseMessages).FactoryFlow;
  const parsed = planSpec.safeParse(source.specification);
  const specification = parsed.success ? parsed.data : null;
  const title = cleanTitle(`${messages.stages.spec} · ${maskFactoryNote(specification?.title ?? source.title)}`);
  const parts = [`# ${plain(bounded(specification?.title ?? source.title, 2000))}`];
  const summary = specification?.summary || source.summary || '';
  if (summary) parts.push(plain(bounded(summary, 40_000)));
  if (specification) {
    const count = specification.sections.reduce((total, section) => total + section.items.length, 0);
    // The protocol permits very large plans. Keep every heading/item with an
    // explicit truncation marker and stay under the existing 1 MB Artifact cap.
    const itemBudget = Math.min(8000, Math.floor(350_000 / Math.max(count, 1)));
    for (const section of specification.sections) {
      parts.push(`## ${plain(bounded(section.heading, 800))}`);
      parts.push(section.items.map(item => `- ${plain(bounded(item, itemBudget)).replaceAll('\n', '\n  ')}`).join('\n'));
    }
  }
  parts.push(`${messages.report.run}: ${source.runId}`);
  return { title, content: parts.join('\n\n') };
}

export interface FactorySpecArtifactOptions {
  /** An explicit historical copy sends no new submission event or model wake. */
  historical?: boolean;
  /** Validate the same source/authority and render the same bytes without writes. */
  dryRun?: boolean;
}

/** Called in a locked Factory transition or explicit backfill, never during a
 * GET. One immutable plan Artifact per completed spec attempt. Historical mode
 * changes notification only; it never relaxes source or execution authority. */
export async function syncFactorySpecArtifact(tx: PoolClient, task: FactoryTask, options: FactorySpecArtifactOptions = {}): Promise<FactorySpecArtifactRef | null> {
  if (task.stage !== 'spec' || task.status !== 'passed') return null;
  // Reuse the account deletion barrier on the caller's transaction, before any
  // object upload. The Artifact INSERT trigger would run too late, after PUT.
  // Lock/statement failures propagate so deletion races cannot become late writes.
  await tx.query('SELECT mikka_account_assert_writable($1)', [task.userId]);
  const { rows: [source] } = await tx.query<FactorySpecSource & { author: string }>(`SELECT r.id AS "runId",left(i.title,500) AS title,
      left(r.report->>'summary',10000) AS summary,r.report->'plan'->'spec' AS specification,
      left(agent.name,200) AS author,COALESCE(settings.locale,'zh-CN') AS locale
    FROM factory_attempts attempt JOIN factory_tasks task ON task.id=attempt."taskId"
    JOIN agent_runs r ON r.id=attempt."runId" AND r."userId"=task."userId" AND r."issueId"=task."issueId"
    JOIN agents agent ON agent.id=r."agentId" AND agent."userId"=task."userId" JOIN issues i ON i.id=task."issueId"
    LEFT JOIN attention_settings settings ON settings."userId"=task."userId"
    WHERE attempt.id=$1 AND attempt."taskId"=$2 AND task."userId"=$3 AND task."issueId"=$4
      AND attempt.stage='spec' AND attempt.status='passed' AND r.kind='plan' AND r.status='succeeded'
      AND r."stopReason"='submitted' AND r."sessionId" IS NOT NULL AND attempt."sessionId"=r."sessionId"
      AND task."workspaceId"=$5 AND r."workspaceId"=task."workspaceId"
      AND i."workspaceId"=task."workspaceId" AND i."ownershipState"='bound'
    FOR UPDATE OF attempt`, [task.attemptId, task.id, task.userId, task.issueId, task.workspaceId ?? null]);
  if (!source) return null;
  const artifactId = factoryEventId('spec-artifact', `${task.id}:${task.attemptId}`);
  const { rows: [existing] } = await tx.query<{ userId: string; workspaceId: string | null; issueId: string | null; runId: string | null; kind: string; sha256: string | null }>(
    `SELECT a."userId",a."workspaceId",a."issueId",a."runId",a.kind,v.sha256 FROM artifacts a
      LEFT JOIN artifact_versions v ON v."artifactId"=a.id AND v.version=1 WHERE a.id=$1 FOR UPDATE OF a`, [artifactId]);
  let hash = existing?.sha256;
  if (existing) {
    if (existing.workspaceId !== task.workspaceId) throw new FactoryError('factoryNotFound');
    if (existing.userId !== task.userId || existing.issueId !== task.issueId || existing.runId !== source.runId ||
        existing.kind !== 'markdown' || !hash) throw new FactoryError('factoryArtifactMissing');
  }
  // Backfill rechecks grants even when repairing a missing link to an existing
  // Artifact. It cannot restore data through revoked execution authority.
  const identity = !existing || options.historical ? await executionIdentityForRun(tx, source.runId, task.userId) : null;
  if (!existing) {
    const rendered = factorySpecMarkdown(source);
    hash = createHash('sha256').update(rendered.content).digest('hex');
    if (!options.dryRun) {
      const storage = artifactStorage(), storageKey = `${task.userId}/${artifactId}/v1-${hash.slice(0, 12)}.md`;
      if (storage === 'r2') await putArtifactObject(storageKey, rendered.content, 'text/markdown; charset=utf-8');
      await tx.query(`INSERT INTO artifacts (id,"userId","workspaceId",kind,title,"runId","issueId") VALUES ($1,$2,$6,'markdown',$3,$4,$5)`,
        [artifactId, task.userId, rendered.title, source.runId, task.issueId, task.workspaceId]);
      await tx.query(`INSERT INTO artifact_versions (id,"artifactId",version,"storageKey","inlineContent",sha256,size,"authorName","executionIdentity")
        VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8)`, [randomUUID(), artifactId, storageKey, storage === 'inline' ? rendered.content : null,
        hash, Buffer.byteLength(rendered.content), maskFactoryNote(source.author), identity ? JSON.stringify(identity) : null]);
      if (!options.historical) await recordCoordinatorEvent(drizzle(tx), artifactSubmittedEvent({ userId: task.userId, botId: task.botId, runId: source.runId,
        issueId: task.issueId, authorName: maskFactoryNote(source.author) }, { artifactId, version: 1, title: rendered.title, kind: 'markdown' }));
      await artifactChanged(tx, task.userId, artifactId);
    }
  }
  const ref: FactorySpecArtifactRef = { artifactId, version: 1, runId: source.runId, sha256: hash! };
  if (!options.dryRun) await tx.query(`UPDATE factory_attempts SET output=jsonb_set(output,'{specArtifact}',$3::jsonb,true)
    WHERE id=$1 AND "taskId"=$2 AND output->'specArtifact' IS DISTINCT FROM $3::jsonb`, [task.attemptId, task.id, JSON.stringify(ref)]);
  return ref;
}
