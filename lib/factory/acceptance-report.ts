import chineseMessages from '@/messages/zh-CN.json';
import englishMessages from '@/messages/en.json';
import { drizzle } from 'drizzle-orm/node-postgres';
import { recordCoordinatorEvent } from '../coordinator-event-store';
import { artifactSubmittedEvent } from '../coordinator-events';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { criterionVerificationStatus, runCriterion, runVisualEvidence, type RunCriterion } from '@mikka/protocol/run';
import { artifactStorage, putArtifactObject } from '../artifacts/storage';
import { artifactChanged } from '../live/artifacts';
import { executionIdentityForRun } from '../execution-identity';
import { resolveAppOrigin } from '../auth-config';
import { withBasePath } from '../base-path';
import { redactFactoryCheckText } from './checks';
import type { FactoryTask } from './store';
import type { FactoryAcceptanceMedia } from './public-flow';

type Report = { summary: string; criteria: RunCriterion[]; filesChanged: string[]; verify: { status?: string; command?: string; output?: string }; reviewVerdict?: string; visualEvidence?: unknown };
type Source = { id: string; candidateId: string; sha: string | null; report: Report; author: string; title: string; locale: string; pullRequest: { url: string; additions?: number; deletions?: number } | null };
/** Narrow JSON paths, bounded arrays and excerpts: never read a whole run/snapshot. */
const excerpt = (expression: string, length: number) => `CASE WHEN length(${expression})>${length} THEN left(${expression},${length}) || ' […]' ELSE ${expression} END`;
const projection = (alias: string) => `jsonb_build_object(
  'summary',${excerpt(`${alias}.report->>'summary'`,2000)},
  'filesChanged',COALESCE((SELECT jsonb_agg(${excerpt('file',300)}) FROM (SELECT value AS file FROM jsonb_array_elements_text(COALESCE(${alias}.report->'filesChanged','[]')) LIMIT 100) files),'[]'),
  'criteria',COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'criterionId',entry->>'criterionId','text',${excerpt("entry->>'text'",500)},'passed',entry->'passed','status',entry->>'status',
    'reason',${excerpt("entry->>'reason'",1000)},'resolution',${excerpt("entry->>'resolution'",1000)},'evidence',${excerpt("entry->>'evidence'",2000)},
    'command',${excerpt("entry->>'command'",500)},'exitCode',entry->'exitCode'))) FROM (SELECT value AS entry FROM jsonb_array_elements(COALESCE(${alias}.report->'criteria','[]')) LIMIT 200) criteria),'[]'),
  'verify',jsonb_build_object('status',${alias}.report->'verify'->>'status','command',${excerpt(`${alias}.report->'verify'->>'command'`,500)},'output',${excerpt(`${alias}.report->'verify'->>'output'`,2000)}),
  'visualEvidence',COALESCE((SELECT jsonb_agg(jsonb_build_object('captureId',entry->>'captureId','publicSafe',entry->'publicSafe')) FROM (SELECT value AS entry FROM jsonb_array_elements(COALESCE(${alias}.report->'visualEvidence','[]')) LIMIT 40) captures),'[]'),
  'reviewVerdict',${alias}.report->>'reviewVerdict')`;
const plain = (value: string) => redactFactoryCheckText(value).replace(/[\\`*_{}[\]<>#]/g, '\\$&');
function bounded(value: unknown, bytes = 2000) {
  if (typeof value !== 'string') return '';
  const safe = redactFactoryCheckText(value), encoded = Buffer.from(safe);
  return encoded.length <= bytes ? safe : encoded.subarray(0, bytes - 12).toString('utf8') + '\n[…]';
}
function block(value: string) {
  if (!value) return '';
  const runs = (pattern: RegExp) => Math.max(2,...(value.match(pattern) ?? []).map(text => text.length));
  const ticks = runs(/`+/g), tildes = runs(/~+/g);
  const fence = ticks <= tildes ? '`'.repeat(ticks + 1) : '~'.repeat(tildes + 1);
  return `\n\n${fence}text\n${value}\n${fence}\n`;
}
const safePr = (value: string | undefined) => value && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(value) ? value : null;

type Review = { candidateId: string | null; report: Report };
type ReportCriterion = { criterion: RunCriterion; implementation?: RunCriterion; reviewObservation?: RunCriterion };
/** Current negative review observations affect the current report's counts.
 * Historical reviews stay historical after repair. Both original reports are
 * immutable, and the implementation's observation stays visible alongside a
 * current review finding. At most 200 + 200 observations enter this union. */
function reportCriteria(source: Source, review: Review | null): ReportCriterion[] {
  const copy = (source.locale === 'en' ? englishMessages : chineseMessages).FactoryFlow.report;
  const entries: ReportCriterion[] = source.report.criteria.slice(0,200).flatMap(value => {
    const parsed = runCriterion.safeParse(value);
    return parsed.success ? [{criterion:parsed.data}] : [];
  });
  if (!entries.length) entries.push({criterion:{text:copy.observations,passed:false,status:'unverified',
    reason:copy.missingObservations}});
  if (review?.candidateId === source.candidateId) for (const value of review.report.criteria.slice(0,200)) {
    const parsed = runCriterion.safeParse(value);
    if (!parsed.success || criterionVerificationStatus(parsed.data) === 'passed') continue;
    const finding = parsed.data;
    const existing = entries.find(entry => finding.criterionId && entry.criterion.criterionId
      ? entry.criterion.criterionId === finding.criterionId
      : finding.text?.trim() && entry.criterion.text?.trim() === finding.text.trim());
    if (existing?.reviewObservation && !existing.implementation) {
      existing.criterion = {...finding}; delete existing.criterion.resolution;
      existing.reviewObservation = finding;
    } else if (existing) {
      const original = existing.implementation ?? existing.criterion;
      existing.implementation = original;
      existing.criterion = {...original,passed:false,status:criterionVerificationStatus(finding),reason:finding.reason};
      existing.reviewObservation = finding;
    } else {
      const criterion = {...finding};
      delete criterion.resolution; // A reviewer cannot claim implementation resolved its new finding.
      entries.push({criterion,reviewObservation:finding});
    }
  }
  return entries;
}

/** All claims come from the implementation/review report; host provenance is shown separately. */
export function acceptanceMarkdown(source: Source, review: Review | null, media: FactoryAcceptanceMedia[]) {
  const messages = (source.locale === 'en' ? englishMessages : chineseMessages).FactoryFlow;
  const copy = messages.report;
  const entries = reportCriteria(source,review);
  const criteria = entries.map(entry => entry.criterion);
  const counts = { passed: 0, failed: 0, unverified: 0 };
  for (const criterion of criteria) counts[criterionVerificationStatus(criterion)]++;
  const ordered = entries.map((entry,index) => ({...entry,index})).sort((a,b) => Number(criterionVerificationStatus(b.criterion)==='unverified') - Number(criterionVerificationStatus(a.criterion)==='unverified'));
  const parts = [`# ${messages.acceptance} · ${plain(source.title)}`, plain(bounded(source.report.summary,4000))];
  const shownCaptures = new Set<string>();
  const captureMarkup = (capture: FactoryAcceptanceMedia) => {
    if (shownCaptures.size >= 40 || shownCaptures.has(capture.captureId)) return '';
    shownCaptures.add(capture.captureId);
    return capture.kind === 'image' ? `![${plain(bounded(capture.title,800))}](${capture.url})`
      : `[${copy.recording}: ${plain(bounded(capture.title,800))}](${capture.url})`;
  };
  const perCriterion = Math.min(8500, Math.floor(210000 / Math.max(1,criteria.length)));
  const labels = copy.status;
  for (const {criterion,index,implementation,reviewObservation} of ordered) {
    const key = criterion.criterionId ?? `criterion-${index + 1}`;
    parts.push(`## ${index + 1}. ${plain(bounded(criterion.text ?? criterion.criterionId ?? '',Math.floor(perCriterion * .15)))} · ${labels[criterionVerificationStatus(criterion)]}`);
    if (criterion.reason) parts.push(plain(bounded(criterion.reason,Math.floor(perCriterion * .25))));
    if (reviewObservation) {
      parts.push(copy.reviewObservation.replace('{status}', () => labels[criterionVerificationStatus(reviewObservation)]));
      if (implementation) {
        parts.push(copy.implementationObservation.replace('{status}', () => labels[criterionVerificationStatus(implementation)]));
        if (implementation.reason && implementation.reason !== criterion.reason) parts.push(plain(bounded(implementation.reason,Math.floor(perCriterion * .15))));
      }
      if (reviewObservation.evidence && reviewObservation.evidence !== criterion.evidence) parts.push(block(bounded(reviewObservation.evidence,Math.floor(perCriterion * .2))));
    }
    if (criterion.command) parts.push(block(bounded(`${criterion.command}\n${copy.exit}: ${criterion.exitCode ?? copy.unrecorded}`,Math.floor(perCriterion * .15))));
    if (criterion.evidence) parts.push(block(bounded(criterion.evidence,Math.floor(perCriterion * .35))));
    if (criterion.resolution) parts.push(`${copy.implementationResolution}: ${plain(bounded(criterion.resolution,Math.floor(perCriterion * .25)))}`);
    for (const capture of media.filter(item => item.criterion === key)) parts.push(captureMarkup(capture));
  }
  if (review) {
    parts.push(`## ${copy.review}`, plain(bounded(review.report.summary,4000)));
    if (review.candidateId !== source.candidateId) parts.push(copy.priorReview);
    const findings = review.report.criteria.filter(c => c.passed === false).slice(0,200);
    const findingBudget = Math.min(2000,Math.floor(70000 / Math.max(1,findings.length)));
    for (const finding of findings) {
      parts.push(`### ${plain(bounded(finding.text ?? finding.criterionId ?? '',Math.floor(findingBudget / 4)))}`);
      if (finding.reason) parts.push(plain(bounded(finding.reason,Math.floor(findingBudget / 4))));
      if (finding.evidence?.trim()) parts.push(block(bounded(finding.evidence,Math.floor(findingBudget / 4))));
      const resolution = source.report.criteria.find(c => finding.criterionId ? c.criterionId === finding.criterionId : c.text === finding.text)?.resolution;
      parts.push(resolution ? plain(bounded(resolution,Math.floor(findingBudget / 4))) : copy.resolutionMissing);
    }
  }
  const extra = media.filter(item => !item.criterion);
  if (extra.length) {
    parts.push(`## ${copy.additionalObservations}`);
    for (const capture of extra) parts.push(captureMarkup(capture));
  }
  parts.push(`## ${copy.changes}`);
  const pr = safePr(source.pullRequest?.url);
  if (pr) parts.push(`[${copy.prDiff}](${pr}/files)`);
  const additions = source.pullRequest?.additions, deletions = source.pullRequest?.deletions;
  if (Number.isSafeInteger(additions) && Number.isSafeInteger(deletions)) parts.push(`+${additions} / −${deletions}`);
  else parts.push(copy.lineCountsMissing);
  parts.push(block(source.report.filesChanged.slice(0,100).map(file => bounded(file,300)).join('\n')));
  parts.push(`${copy.run}: ${source.id}\n\n${copy.candidate}: ${source.candidateId}${source.sha ? `\n\nSHA: ${source.sha}` : ''}`);
  return { content: parts.filter(Boolean).join('\n\n'), counts };
}

/** Runs only for a completed implementation/review; one Artifact is versioned across repairs. */
export async function syncFactoryAcceptanceArtifact(tx: PoolClient, task: FactoryTask) {
  if (!task.candidateId || !((task.stage === 'execute' && task.status === 'passed') || (task.stage === 'review' && ['passed','failed'].includes(task.status)) || task.stage === 'approval')) return;
  const { rows: [source] } = await tx.query<Source>(`SELECT r.id,c.id AS "candidateId",c.sha,${projection('r')} AS report,
    left(a.name,200) AS author,left(i.title,200) AS title,COALESCE(settings.locale,'zh-CN') AS locale,
    CASE WHEN p."pullRequest" IS NULL THEN NULL ELSE jsonb_build_object('url',left(p."pullRequest"->>'url',2000),'additions',p."pullRequest"->'additions','deletions',p."pullRequest"->'deletions') END AS "pullRequest"
    FROM factory_candidates c JOIN agent_runs r ON r.id=c."runId" AND r."userId"=$3 AND r."issueId"=$4
    JOIN agents a ON a.id=r."agentId" JOIN issues i ON i.id=r."issueId"
    LEFT JOIN attention_settings settings ON settings."userId"=$3 LEFT JOIN run_publications p ON p."runId"=r.id AND p."userId"=$3
    WHERE c.id=$1 AND c."taskId"=$2 AND r.status='succeeded' AND r."stopReason"='submitted' LIMIT 1`, [task.candidateId,task.id,task.userId,task.issueId]);
  if (!source) return;
  const { rows: [review] } = await tx.query<{ id: string; candidateId: string | null; report: Report }>(`SELECT r.id,a."candidateId",${projection('r')} AS report FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId" AND r."userId"=$2 AND r."issueId"=$3
    WHERE a."taskId"=$1 AND a.stage='review' AND a.status IN ('passed','failed') ORDER BY a.position DESC LIMIT 1`,[task.id,task.userId,task.issueId]);
  const runIds = [source.id,...(review ? [review.id] : [])];
  const declared = runVisualEvidence.safeParse(source.report.visualEvidence);
  const publicCaptureIds = declared.success ? declared.data.map(ref => ref.captureId) : [];
  // Every capture explicitly selected for the PR must also appear here, even
  // when exploratory screenshots would otherwise exhaust the report limit.
  const { rows: captures } = await tx.query<{ id: string; kind: 'image' | 'video'; title: string; runId: string; contentType: string; size: number; durationMs: number | null }>(`SELECT id,kind,left(title,200) AS title,"runId","contentType",size,"durationMs" FROM run_captures WHERE "userId"=$1 AND "runId"=ANY($2::uuid[]) AND ("issueId" IS NULL OR "issueId"=$5) AND status='ready' ORDER BY CASE WHEN "runId"=$3 AND id=ANY($4::uuid[]) THEN 0 ELSE 1 END,"createdAt",id LIMIT 40`,[task.userId,runIds,source.id,publicCaptureIds,task.issueId]);
  const origin = resolveAppOrigin(process.env);
  const currentCriteria = reportCriteria(source,review ?? null);
  const media: FactoryAcceptanceMedia[] = captures.map(capture => {
    const index = currentCriteria.findIndex(entry => entry.criterion.evidence?.includes(capture.id) || entry.reviewObservation?.evidence?.includes(capture.id));
    return { captureId: capture.id, kind: capture.kind, title: redactFactoryCheckText(capture.title), runId: capture.runId,
      contentType: capture.contentType, size: capture.size, durationMs: capture.durationMs,
      candidateId: capture.runId === source.id ? source.candidateId : review?.candidateId ?? undefined,
      appliesToCurrentCandidate: capture.runId === source.id || review?.candidateId === source.candidateId,
      criterion: index < 0 ? null : currentCriteria[index].criterion.criterionId ?? `criterion-${index + 1}`,
      url: origin ? new URL(withBasePath(`/api/captures/${capture.id}`),origin).href : withBasePath(`/api/captures/${capture.id}`) };
  });
  const rendered = acceptanceMarkdown(source,review ?? null,media), hash = createHash('sha256').update(rendered.content).digest('hex');
  const { rows: [existing] } = await tx.query('SELECT f."artifactId",f.sha256,a."latestVersion" FROM factory_acceptance_artifacts f JOIN artifacts a ON a.id=f."artifactId" AND a."userId"=$2 WHERE f."taskId"=$1 FOR UPDATE OF a',[task.id,task.userId]);
  if (existing?.sha256 === hash) return;
  const identity = await executionIdentityForRun(tx,source.id,task.userId);
  const artifactId = existing?.artifactId ?? randomUUID(), version = (existing?.latestVersion ?? 0) + 1;
  const title = `${(source.locale === 'en' ? englishMessages : chineseMessages).FactoryFlow.acceptance} · ${redactFactoryCheckText(source.title)}`.slice(0,200);
  const storage = artifactStorage(), storageKey = `${task.userId}/${artifactId}/v${version}-${hash.slice(0,12)}.md`;
  // Immutable bytes precede their committed metadata, exactly like submitArtifact.
  if (storage === 'r2') await putArtifactObject(storageKey,rendered.content,'text/markdown; charset=utf-8');
  if (existing) await tx.query('UPDATE artifacts SET title=$2,"latestVersion"=$3,"updatedAt"=now() WHERE id=$1',[artifactId,title,version]);
  else await tx.query('INSERT INTO artifacts (id,"userId",kind,title,"runId","issueId") VALUES ($1,$2,\'markdown\',$3,$4,$5)',[artifactId,task.userId,title,source.id,task.issueId]);
  await tx.query('INSERT INTO artifact_versions (id,"artifactId",version,"storageKey","inlineContent",sha256,size,"authorName","executionIdentity") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [randomUUID(),artifactId,version,storageKey,storage === 'inline' ? rendered.content : null,hash,Buffer.byteLength(rendered.content),source.author,identity ? JSON.stringify(identity) : null]);
  await tx.query(`INSERT INTO factory_acceptance_artifacts ("taskId","artifactId","candidateId","runId",sha256,media,counts) VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT ("taskId") DO UPDATE SET "candidateId"=excluded."candidateId","runId"=excluded."runId",sha256=excluded.sha256,media=excluded.media,counts=excluded.counts,"updatedAt"=now()`,
    [task.id,artifactId,task.candidateId,source.id,hash,JSON.stringify(media),JSON.stringify(rendered.counts)]);
  await recordCoordinatorEvent(drizzle(tx),artifactSubmittedEvent({ userId: task.userId, botId: task.botId, runId: source.id, issueId: task.issueId, authorName: source.author },
    { artifactId,version,title,kind:'markdown' }));
  await artifactChanged(tx,task.userId,artifactId);
}
