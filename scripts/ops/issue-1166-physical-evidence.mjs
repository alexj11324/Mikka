// Temporary, fixed-target evidence driver for #1166. Do not merge to main.
// Production SQL is read-only. The only provider mutations resume/pause the
// existing authorized sandbox; no create, fork, snapshot, kill or template API.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const TARGET = Object.freeze({
  repository: 'alexj11324/Mikka',
  ref: 'refs/heads/ops/issue-1166-physical-evidence',
  ownerEmailSha256: 'c6032681fcca35e9a45d042dc67def8773bf58b68cc42392d2ce643c79765a42',
  workspaceId: 'de300000-154f-4875-832f-70e7ffc3b62b',
  botId: '0c2865c3-7d69-49d2-a3fd-02c484621958',
  issueId: '65e92e1e-4d75-4531-b1bd-a2a68d7689c7',
  taskId: '9ea956ce-a604-4c2e-a724-fb04fa5a3c9b',
  questionId: '40c859a6-f048-470d-b036-d6e17feb4765',
  originRunId: 'c7bdd043-22fa-4ea3-8705-dcdc372262f3',
  failedRunId: 'e57a6d03-510e-496f-bd88-97375318cd9e',
  sessionId: '01a1a2a5-76f1-7881-b182-311eba17fa98',
  subscriptionBindingId: 'ad6c44e2-3961-4518-8874-42b4c041e902',
  subscriptionModel: 'gpt-5.6-luna',
  answerId: '8dac8075-4313-4fca-912c-d6d500bd49f5',
  sandboxId: 'itxw486q7r74fasogje2v',
  protectedSandboxId: 'ihuee6xcl4vvkox0lmpsz',
  worktree: '/home/user/.mikka/worker/worktrees/e2cc22fa-5644-4fad-8d98-070472e609d2',
  filename: 'factory-1146-codex-d8f3d3f2.txt',
  fileBytes: 85,
  fileSha256: '4e80716f5de244c05cab6f9fdf3d93c90f35fc2cabcf4a07ae79772c48d35032',
  snapshot: '8f418086fff9bcd42d17e32de7b7f4a968fdfc0a',
  ancestor: '627f9af9e1a1e76154e6343aeb72c110a53f3e28',
});
export const AUTHORITY = Object.freeze({
  identityId: '2cf9fa19-b9db-4c08-8ca0-b31859f2cbac',
  audience: 'mikka-infisical',
  projectId: '89850d6a-f020-4936-863e-df77380dfe40',
  environment: 'prod', path: '/vercel',
  secretNames: Object.freeze(['E2B_API_KEY', 'MIKKA_DATABASE_URL']),
  databaseHosts: Object.freeze([
    'ep-twilight-violet-b5lbqgbv.c-7.us-east-2.aws.neon.tech',
    'ep-twilight-violet-b5lbqgbv-pooler.c-7.us-east-2.aws.neon.tech',
  ]),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const TERMINAL = ['succeeded', 'stopped', 'failed', 'cancelled'];
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const fingerprint = value => sha256(JSON.stringify(value));
export class EvidenceError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new EvidenceError(code); };
const requireThat = (condition, code) => { if (!condition) fail(code); };
// Provider/SQL error messages, causes, response bodies and stacks never leave.
const errorCode = error => error instanceof EvidenceError ? error.code : 'operation_failed';

export function assertSandbox(id) {
  requireThat(id !== TARGET.protectedSandboxId && id === TARGET.sandboxId, 'sandbox_not_authorized');
}
export function executionContext(env) {
  requireThat(env.GITHUB_ACTIONS === 'true' &&
    env.GITHUB_REPOSITORY === TARGET.repository &&
    env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    env.GITHUB_REF === TARGET.ref &&
    COMMIT.test(env.GITHUB_SHA ?? '') &&
    env.EVIDENCE_EXPECTED_SOURCE_SHA === env.GITHUB_SHA &&
    /^\d+$/.test(env.GITHUB_RUN_ID ?? ''), 'execution_context_rejected');
  requireThat(['before', 'after'].includes(env.EVIDENCE_PHASE), 'phase_rejected');
  requireThat(UUID.test(env.EVIDENCE_CUSTODY_RUN_ID ?? ''), 'custody_run_rejected');
  if (env.EVIDENCE_PHASE === 'before') {
    requireThat(env.EVIDENCE_CUSTODY_RUN_ID === TARGET.failedRunId, 'before_custody_rejected');
  } else {
    requireThat(env.EVIDENCE_CUSTODY_RUN_ID !== TARGET.failedRunId &&
      /^\d+$/.test(env.EVIDENCE_BEFORE_RUN_ID ?? ''), 'after_custody_rejected');
  }
  return {
    phase: env.EVIDENCE_PHASE, custodyRunId: env.EVIDENCE_CUSTODY_RUN_ID,
    sourceSha: env.GITHUB_SHA, workflowRunId: env.GITHUB_RUN_ID,
    beforeRunId: env.EVIDENCE_BEFORE_RUN_ID || null,
  };
}

export async function loadCredentials(env, request = fetch) {
  executionContext(env);
  let tokenUrl;
  try { tokenUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL); } catch { fail('oidc_url_rejected'); }
  requireThat(tokenUrl.protocol === 'https:' && tokenUrl.hostname === 'pipelines.actions.githubusercontent.com' &&
    tokenUrl.port === '' && tokenUrl.username === '' && tokenUrl.password === '' && tokenUrl.hash === '' &&
    /^\/[A-Za-z0-9_-]+\/_apis\/distributedtask\/hubs\/build\/plans\/[0-9a-f-]+\/jobs\/[0-9a-f-]+\/idtoken$/.test(tokenUrl.pathname) &&
    [...tokenUrl.searchParams.keys()].every(key => key === 'api-version') &&
    typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === 'string' && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length > 0,
  'oidc_url_rejected');
  tokenUrl.searchParams.set('audience', AUTHORITY.audience);
  const json = async (url, options, code) => {
    try {
      const response = await request(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      // Do not read failed response bodies: some upstream actions dump them.
      if (!response.ok) fail(code);
      return await response.json();
    } catch { fail(code); }
  };
  const oidc = await json(tokenUrl.href, {
    headers: { Authorization: 'Bearer ' + env.ACTIONS_ID_TOKEN_REQUEST_TOKEN },
  }, 'oidc_request_failed');
  requireThat(typeof oidc.value === 'string' && oidc.value.length <= 16_384 &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(oidc.value), 'oidc_response_rejected');
  const login = await json('https://app.infisical.com/api/v1/auth/oidc-auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ identityId: AUTHORITY.identityId, jwt: oidc.value }).toString(),
  }, 'infisical_login_failed');
  requireThat(typeof login.accessToken === 'string' && login.accessToken.length > 0 &&
    login.accessToken.length <= 16_384, 'infisical_login_rejected');
  const secrets = {};
  for (const name of AUTHORITY.secretNames) {
    const url = new URL('https://app.infisical.com/api/v3/secrets/raw/' + name);
    url.search = new URLSearchParams({
      workspaceId: AUTHORITY.projectId, environment: AUTHORITY.environment,
      secretPath: AUTHORITY.path, include_imports: 'false', expandSecretReferences: 'false',
    }).toString();
    const response = await json(url.href, {
      headers: { Authorization: 'Bearer ' + login.accessToken },
    }, 'named_secret_request_failed');
    requireThat(response.secret?.secretKey === name && typeof response.secret.secretValue === 'string' &&
      response.secret.secretValue.length > 0 && response.secret.secretValue.length <= 16_384,
    'named_secret_response_rejected');
    secrets[name] = response.secret.secretValue;
  }
  let database;
  try { database = new URL(secrets.MIKKA_DATABASE_URL); } catch { fail('database_target_rejected'); }
  requireThat(['postgres:', 'postgresql:'].includes(database.protocol) &&
    AUTHORITY.databaseHosts.includes(database.hostname) && database.pathname === '/orvilo_mvp' &&
    ['', '5432'].includes(database.port) && database.hash === '', 'database_target_rejected');
  // These are kept in this process only. No workflow env export, token file,
  // fallback identity, universal-auth credential, or policy change.
  return secrets;
}

// Parameters are fixed q/task/issue/workspace/bot/C7/e57/VM plus the reviewed
// custody UUID. All sensitive row content is hashed inside PostgreSQL.
export const SCOPE_SQL = `
WITH RECURSIVE lineage AS (
  SELECT r.id,r."continuesRunId",r."userId",r."issueId",1 AS depth
  FROM agent_runs r WHERE r.id=$9
  UNION ALL
  SELECT r.id,r."continuesRunId",r."userId",r."issueId",l.depth+1
  FROM lineage l JOIN agent_runs r ON r.id=l."continuesRunId"
    AND r."userId"=l."userId" AND r."issueId"=l."issueId"
  WHERE l.depth<12
)
SELECT jsonb_build_object(
  'ownerId',q."userId",
  'ownerEmailSha256',encode(sha256(convert_to(lower(btrim(u.email)),'UTF8')),'hex'),
  'questionId',q.id,'questionStatus',q.status,'questionRevision',q.revision,
  'questionOriginRunId',q."originRunId",'questionSessionId',q."originSessionId",
  'questionContinuationRunId',q."continuationRunId",'answerId',q."answerId",
  'answerSha256',encode(sha256(convert_to(q.answer::text,'UTF8')),'hex'),
  'answerFingerprintSha256',encode(sha256(convert_to(q."answerFingerprint",'UTF8')),'hex'),
  'receiptSha256',encode(sha256(convert_to(q.result::text,'UTF8')),'hex'),
  'receiptQuestionId',q.result->>'questionId',
  'receiptContinuationRunId',q.result->>'continuationRunId',
  'receiptTaskId',q.result->'task'->>'id'
) || jsonb_build_object(
  'taskId',t.id,'taskStatus',t.status,'taskRevision',t.revision,'taskAttemptId',t."attemptId",
  'taskRouteSha256',encode(sha256(convert_to(t.route::text,'UTF8')),'hex'),
  'issueId',i.id,'issueStatus',i.status,'issueRevision',i.revision,
  'workspaceId',b."workspaceId",'botId',b."botId",
  'originStatus',o.status,'originSessionId',o."sessionId",
  'originRowSha256',encode(sha256(convert_to(row_to_json(o)::text,'UTF8')),'hex'),
  'originMachineState',om.state,'originSandboxId',om."sandboxId",
  'failedStatus',f.status,'failedSessionId',f."sessionId",
  'failedRowSha256',encode(sha256(convert_to(row_to_json(f)::text,'UTF8')),'hex'),
  'failedMachineState',fm.state,'failedSandboxId',fm."sandboxId",
  'failedQuestionId',f."questionContinuation"->>'questionId',
  'failedOriginRunId',f."questionContinuation"->>'originRunId',
  'failedOriginSessionId',f."questionContinuation"->>'originSessionId',
  'failedRequiredSandboxId',f."questionContinuation"->>'requiredSandboxId',
  'failedRequireResume',f."questionContinuation"->>'requireSessionResume',
  'frozenDefinitionDigest',f."agentDefinition"->>'definitionDigest',
  'frozenDefinitionsMatch',o."agentDefinition"->>'definitionDigest'=f."agentDefinition"->>'definitionDigest',
  'harness',f."agentDefinition"->>'harness',
  'modelSource',f."agentDefinition"->>'modelSource',
  'subscriptionBindingId',f."agentDefinition"->'subscription'->>'bindingId',
  'subscriptionRoute',f."agentDefinition"->'subscription'->>'route',
  'subscriptionModel',f."agentDefinition"->'subscription'->>'modelId',
  'hasApiKey',COALESCE(f."agentDefinition"->'apiKey','null'::jsonb)<>'null'::jsonb
) || jsonb_build_object(
  'custodyRunId',r.id,'custodyRunStatus',r.status,'custodySessionId',r."sessionId",
  'custodyStopped',r."stopRequestedAt" IS NOT NULL,
  'custodyQuestionId',r."questionContinuation"->>'questionId',
  'custodyOriginRunId',r."questionContinuation"->>'originRunId',
  'custodyOriginSessionId',r."questionContinuation"->>'originSessionId',
  'custodyRequiredSandboxId',r."questionContinuation"->>'requiredSandboxId',
  'custodyRequireResume',r."questionContinuation"->>'requireSessionResume',
  'custodyDefinitionMatches',r."agentDefinition"->>'definitionDigest'=f."agentDefinition"->>'definitionDigest',
  'custodyAttemptId',a.id,'custodyAttemptStatus',a.status,
  'custodyLeaseExpiresAt',r."leaseExpiresAt",
  'custodyLeaseLive',r."leaseExpiresAt">clock_timestamp(),
  'lineage',(SELECT json_agg(id ORDER BY depth) FROM lineage),
  'sandboxId',m."sandboxId",'machineState',m.state,'snapshotId',m."snapshotId",
  'deviceId',m."deviceId",'repoId',m."repoId",'epoch',m.epoch,
  'operationId',m."operationId",'workerLeaseId',m."workerLeaseId",
  'workerLeaseUntil',m."workerLeaseUntil",
  'workerLeaseLive',m."workerLeaseUntil">clock_timestamp(),
  'sandboxOwnerCount',(SELECT count(*)::int FROM thread_machines x WHERE x."sandboxId"=$8),
  'activeRunCount',(SELECT count(*)::int FROM agent_runs x
    WHERE x.status NOT IN ('succeeded','failed','stopped','cancelled')
      AND (x."deviceId"=m."deviceId" OR (x."userId"=q."userId" AND x."issueId"=$3))),
  'liveTaskLeaseCount',(SELECT count(*)::int FROM thread_machines x
    WHERE x."workerLeaseUntil">clock_timestamp()
      AND (x."sandboxId"=$8 OR (x."ownerId"=q."userId" AND x."workspaceId"=$4 AND x."issueId"=$3)))
) AS scope
FROM factory_questions q
JOIN "user" u ON u.id=q."userId"
JOIN factory_tasks t ON t.id=q."taskId" AND t."userId"=q."userId" AND t."issueId"=q."issueId" AND t."botId"=$5
JOIN issues i ON i.id=q."issueId" AND i."userId"=q."userId"
JOIN agent_runs o ON o.id=$6 AND o."userId"=q."userId" AND o."issueId"=q."issueId" AND o."botId"=$5
JOIN agent_runs f ON f.id=$7 AND f."userId"=o."userId" AND f."issueId"=o."issueId" AND f."botId"=o."botId"
  AND f."agentId"=o."agentId" AND f."deviceId"=o."deviceId" AND f."deviceRepoId"=o."deviceRepoId"
JOIN agent_runs r ON r.id=$9 AND r."userId"=f."userId" AND r."issueId"=f."issueId" AND r."botId"=f."botId"
  AND r."agentId"=f."agentId" AND r."deviceId"=f."deviceId" AND r."deviceRepoId"=f."deviceRepoId"
JOIN factory_attempts a ON a."runId"=r.id AND a."taskId"=t.id
JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId" AND b."workspaceId"=$4 AND b."botId"=$5
JOIN computer_run_bindings ob ON ob."runId"=o.id AND ob."ownerId"=b."ownerId" AND ob."workspaceId"=b."workspaceId" AND ob."botId"=b."botId"
JOIN computer_run_bindings fb ON fb."runId"=f.id AND fb."ownerId"=b."ownerId" AND fb."workspaceId"=b."workspaceId" AND fb."botId"=b."botId"
JOIN thread_machines om ON om."runId"=o.id AND om."ownerId"=b."ownerId" AND om."workspaceId"=b."workspaceId"
JOIN thread_machines fm ON fm."runId"=f.id AND fm."ownerId"=b."ownerId" AND fm."workspaceId"=b."workspaceId"
JOIN thread_machines m ON m."runId"=r.id AND m."ownerId"=b."ownerId" AND m."workspaceId"=b."workspaceId"
  AND m."botId"=b."botId" AND m."issueId"=r."issueId" AND m."deviceId"=r."deviceId" AND m."repoId"=r."deviceRepoId"
WHERE q.id=$1 AND q."taskId"=$2 AND q."issueId"=$3
`;
export async function readScope(client, context) {
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '8s'");
    const result = await client.query(SCOPE_SQL, [
      TARGET.questionId, TARGET.taskId, TARGET.issueId, TARGET.workspaceId,
      TARGET.botId, TARGET.originRunId, TARGET.failedRunId, TARGET.sandboxId, context.custodyRunId,
    ]);
    requireThat(result.rows.length === 1, 'scope_not_found');
    return result.rows[0].scope;
  } finally { await client.query('ROLLBACK'); }
}
export function validateScope(s, context, { idle = true } = {}) {
  requireThat(s && s.ownerEmailSha256 === TARGET.ownerEmailSha256, 'scope_owner_changed');
  for (const key of ['questionId', 'taskId', 'issueId', 'workspaceId', 'botId', 'answerId']) {
    requireThat(s[key] === TARGET[key], 'scope_identity_changed');
  }
  assertSandbox(s.sandboxId);
  requireThat(s.questionOriginRunId === TARGET.originRunId &&
    s.questionSessionId === TARGET.sessionId && s.originSessionId === TARGET.sessionId &&
    s.failedSessionId === TARGET.sessionId && s.originStatus === 'stopped' && s.failedStatus === 'failed' &&
    s.originMachineState === 'ended' && s.originSandboxId === null, 'scope_history_changed');
  requireThat(s.receiptQuestionId === TARGET.questionId &&
    s.receiptContinuationRunId === TARGET.failedRunId && s.receiptTaskId === TARGET.taskId &&
    ['answerSha256', 'answerFingerprintSha256', 'receiptSha256', 'originRowSha256', 'failedRowSha256']
      .every(key => SHA.test(s[key] ?? '')), 'scope_answer_changed');
  requireThat(s.failedQuestionId === TARGET.questionId && s.failedOriginRunId === TARGET.originRunId &&
    s.failedOriginSessionId === TARGET.sessionId && s.failedRequiredSandboxId === TARGET.sandboxId &&
    s.failedRequireResume === 'true' && s.frozenDefinitionsMatch === true &&
    s.harness === 'codex' && s.modelSource === 'subscription' &&
    s.subscriptionRoute === 'codex_cli' && s.subscriptionBindingId === TARGET.subscriptionBindingId &&
    s.subscriptionModel === TARGET.subscriptionModel && s.hasApiKey === false, 'scope_subscription_changed');
  requireThat(s.custodyRunId === context.custodyRunId && s.custodyDefinitionMatches === true &&
    s.custodyQuestionId === TARGET.questionId && s.custodyOriginRunId === TARGET.originRunId &&
    s.custodyOriginSessionId === TARGET.sessionId && s.custodyRequiredSandboxId === TARGET.sandboxId &&
    s.custodyRequireResume === 'true' && Array.isArray(s.lineage) &&
    s.lineage[0] === context.custodyRunId && s.lineage.includes(TARGET.failedRunId), 'scope_custody_changed');
  if (context.phase === 'before') {
    requireThat(s.custodyRunId === TARGET.failedRunId && s.questionContinuationRunId === TARGET.failedRunId &&
      s.questionStatus === 'blocked' && s.taskStatus === 'blocked' &&
      s.custodyAttemptId === s.taskAttemptId && s.failedSandboxId === TARGET.sandboxId, 'scope_before_changed');
  } else {
    requireThat(s.questionContinuationRunId === context.custodyRunId &&
      s.failedMachineState === 'ended' && s.failedSandboxId === null, 'scope_after_changed');
  }
  requireThat(s.sandboxOwnerCount === 1 && UUID.test(s.deviceId ?? '') && UUID.test(s.repoId ?? '') &&
    ['running', 'paused', 'error'].includes(s.machineState), 'scope_machine_changed');
  if (idle) requireThat(TERMINAL.includes(s.custodyRunStatus) && !s.custodyStopped &&
    s.custodySessionId === TARGET.sessionId && s.activeRunCount === 0 &&
    !s.custodyLeaseLive && !s.workerLeaseLive && s.liveTaskLeaseCount === 0 &&
    ['blocked', 'resolved'].includes(s.questionStatus), 'scope_not_idle');
  return s;
}

export function validateInfo(info) {
  assertSandbox(info?.sandboxId);
  requireThat(info.metadata?.application === 'mikka-thread' &&
    info.metadata?.workspaceId === TARGET.workspaceId, 'provider_scope_changed');
  requireThat(info.lifecycle?.onTimeout === 'pause' && info.lifecycle?.autoResume === false, 'provider_lifecycle_rejected');
  return { sandboxId: info.sandboxId, state: info.state, onTimeout: 'pause', autoResume: false };
}

// Strict reconstruction prevents extra remote fields from reaching artifacts.
export function validatePhysical(p) {
  requireThat(p?.version === 1 && p.sessionId === TARGET.sessionId, 'physical_schema_rejected');
  const checkedHash = value => { requireThat(SHA.test(value ?? ''), 'physical_hash_rejected'); return value; };
  const checkedCommit = value => { requireThat(COMMIT.test(value ?? ''), 'physical_commit_rejected'); return value; };
  requireThat(p.file?.bytes === TARGET.fileBytes && p.file.sha256 === TARGET.fileSha256 &&
    p.git?.snapshotAncestor === true && p.git?.initialAncestor === true &&
    p.git?.fileMatchesHead === true && p.git?.snapshotFileSha256 === TARGET.fileSha256, 'physical_artifact_changed');
  requireThat(Array.isArray(p.journals) && p.journals.length === 2 &&
    Array.isArray(p.ledgers) && p.ledgers.length === 2 &&
    Array.isArray(p.sessions) && p.sessions.length >= 2 && p.sessions.length <= 64, 'physical_history_missing');
  const runIds = [TARGET.originRunId, TARGET.failedRunId];
  const journals = p.journals.map((row, index) => {
    requireThat(row.runId === runIds[index] && row.sessionId === TARGET.sessionId &&
      row.worktree === TARGET.worktree && row.state === (index === 0 ? 'stopped' : 'failed'), 'physical_journal_changed');
    return {
      runId: row.runId, state: row.state, sessionId: row.sessionId, worktree: row.worktree,
      projectionSha256: checkedHash(row.projectionSha256),
    };
  });
  const ledgers = p.ledgers.map((row, index) => {
    requireThat(row.runId === runIds[index] && row.sessionId === TARGET.sessionId &&
      row.workspaceId === TARGET.workspaceId && row.route === 'codex_cli' &&
      row.bindingId === TARGET.subscriptionBindingId && UUID.test(row.consumerId ?? '') &&
      Number.isInteger(row.revision), 'physical_ledger_changed');
    return {
      runId: row.runId, sessionId: row.sessionId, workspaceId: row.workspaceId,
      route: row.route, bindingId: row.bindingId, consumerId: row.consumerId,
      revision: row.revision, accountIdSha256: checkedHash(row.accountIdSha256),
      fileSha256: checkedHash(row.fileSha256),
    };
  });
  const sessions = p.sessions.map(row => {
    requireThat(runIds.includes(row.runId) && ['sessions', 'archived_sessions'].includes(row.kind) &&
      row.sessionId === TARGET.sessionId && Number.isSafeInteger(row.bytes) &&
      row.bytes > 0 && row.bytes <= 32 * 1024 * 1024 &&
      (row.prefixMatches === null || typeof row.prefixMatches === 'boolean'), 'physical_session_rejected');
    return {
      runId: row.runId, kind: row.kind, sessionId: row.sessionId,
      filenameSha256: checkedHash(row.filenameSha256), bytes: row.bytes,
      sha256: checkedHash(row.sha256), prefixMatches: row.prefixMatches,
    };
  });
  requireThat(runIds.every(id => sessions.some(row => row.runId === id)), 'physical_session_missing');
  return {
    version: 1, sessionId: TARGET.sessionId,
    file: { bytes: TARGET.fileBytes, sha256: TARGET.fileSha256 },
    git: { head: checkedCommit(p.git.head), snapshotAncestor: true, initialAncestor: true,
      fileMatchesHead: true, snapshotFileSha256: TARGET.fileSha256,
      trackedStatusSha256: checkedHash(p.git.trackedStatusSha256) },
    workerSourceSha: checkedCommit(p.workerSourceSha),
    journalFileSha256: checkedHash(p.journalFileSha256), journals, ledgers, sessions,
  };
}
export function baselineForAfter(report, context) {
  requireThat(report?.version === 1 && report.outcome === 'passed' &&
    report.phase === 'before' && report.execution?.sourceSha === context.sourceSha &&
    report.execution?.workflowRunId === context.beforeRunId &&
    report.restoration === 'confirmed_paused' && report.target?.sandboxId === TARGET.sandboxId,
  'before_report_rejected');
  const physical = validatePhysical(report.physical);
  validateScope(report.scope, { phase: 'before', custodyRunId: TARGET.failedRunId });
  return { scope: report.scope, physical };
}
export function compareAfter(before, scope, physical) {
  for (const key of ['originRowSha256', 'failedRowSha256', 'answerSha256', 'answerFingerprintSha256', 'receiptSha256']) {
    requireThat(before.scope[key] === scope[key], 'historical_database_row_changed');
  }
  requireThat(fingerprint(before.physical.journals) === fingerprint(physical.journals) &&
    fingerprint(before.physical.ledgers) === fingerprint(physical.ledgers), 'historical_physical_row_changed');
  for (const old of before.physical.sessions) {
    requireThat(physical.sessions.some(row => row.runId === old.runId &&
      row.filenameSha256 === old.filenameSha256 && row.bytes >= old.bytes &&
      row.prefixMatches === true), 'historical_session_prefix_changed');
  }
}

export async function collect({ context, read, provider, probe, baseline = null, signal, checkpoint = async () => {} }) {
  const report = {
    version: 1, phase: context.phase, execution: context,
    target: { sandboxId: TARGET.sandboxId, questionId: TARGET.questionId,
      originRunId: TARGET.originRunId, failedRunId: TARGET.failedRunId, sessionId: TARGET.sessionId },
    outcome: 'failed', restoration: 'not_needed', startedAt: new Date().toISOString(),
  };
  let scope, scopeHash, connectAttempted = false;
  const check = async () => {
    const next = validateScope(await read(), context);
    requireThat(fingerprint(next) === scopeHash, 'scope_changed');
    return next;
  };
  try {
    scope = validateScope(await read(), context, { idle: false });
    report.scope = scope;
    report.scopeSha256 = scopeHash = fingerprint(scope);
    // For an active after run, getInfo is the only provider call.
    report.initialProvider = validateInfo(await provider.info());
    validateScope(scope, context);
    requireThat(report.initialProvider.state === 'paused', 'provider_not_paused');
    signal?.throwIfAborted();
    await check();
    connectAttempted = true; // A lost response may still have resumed the VM.
    report.restoration = 'pending';
    await checkpoint(report);
    const sandbox = await provider.connect(signal);
    signal?.throwIfAborted();
    await check();
    const monitorAbort = new AbortController();
    const probeAbort = new AbortController();
    const onAbort = () => probeAbort.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const monitor = async () => {
      while (!monitorAbort.signal.aborted) {
        await delay(1000, undefined, { signal: monitorAbort.signal });
        await check();
      }
    };
    const monitorPromise = monitor();
    try {
      report.physical = validatePhysical(await Promise.race([
        probe(sandbox, baseline?.physical ?? null, probeAbort.signal), monitorPromise,
      ]));
    } finally {
      probeAbort.abort();
      monitorAbort.abort();
      await monitorPromise.catch(() => {});
      signal?.removeEventListener('abort', onAbort);
    }
    signal?.throwIfAborted();
    await check();
    if (context.phase === 'before') requireThat(report.physical.git.head === TARGET.snapshot, 'before_git_head_changed');
    if (context.phase === 'after') {
      requireThat(baseline !== null, 'before_report_missing');
      compareAfter(baseline, scope, report.physical);
      report.comparison = 'original_rows_ledgers_journals_and_session_prefixes_preserved';
    }
    report.outcome = 'passed';
  } catch (error) {
    report.failure = errorCode(error);
  } finally {
    if (connectAttempted) {
      try {
        // No SQL lease/lock is acquired. Never pause if business has taken over.
        await check();
        const info = validateInfo(await provider.info());
        if (info.state !== 'paused') {
          requireThat(info.state === 'running', 'provider_state_changed');
          await check(); // Freshest possible read before the external mutation.
          await provider.pause();
        }
        const restored = validateInfo(await provider.info());
        requireThat(restored.state === 'paused', 'pause_not_confirmed');
        report.restoration = 'confirmed_paused';
      } catch (error) {
        report.outcome = 'failed';
        report.restoration = error instanceof EvidenceError &&
          (error.code.startsWith('scope_') || error.code === 'sandbox_not_authorized')
          ? 'skipped_scope_changed' : 'unconfirmed';
        report.restorationFailure = errorCode(error);
      }
    }
    report.finishedAt = new Date().toISOString();
    await checkpoint(report);
  }
  return report;
}

async function main() {
  const context = executionContext(process.env);
  // Only after-context accepts the named, reviewed before artifact, never paths from input.
  let baseline = null;
  if (context.phase === 'after') {
    const bytes = await readFile('physical-evidence-before/evidence.json');
    requireThat(bytes.length <= 1024 * 1024, 'before_report_too_large');
    baseline = baselineForAfter(JSON.parse(bytes.toString('utf8')), context);
  }
  const secrets = await loadCredentials(process.env);
  const [{ Client }, { Sandbox }] = await Promise.all([import('pg'), import('e2b')]);
  const client = new Client({
    connectionString: secrets.MIKKA_DATABASE_URL,
    application_name: 'issue-1166-readonly-evidence',
    options: '-c default_transaction_read_only=on',
    connectionTimeoutMillis: 10_000, query_timeout: 10_000,
  });
  const apiOptions = () => ({ apiKey: secrets.E2B_API_KEY, requestTimeoutMs: 10_000,
    retries: 0, signal: AbortSignal.timeout(15_000), domain: 'e2b.app', debug: false });
  const stop = new AbortController();
  // Avoid EventEmitter's unhandled-error printing raw database/provider data.
  client.on('error', () => stop.abort());
  const abort = () => stop.abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  const timer = setTimeout(abort, 120_000);
  let connected = false;
  try {
    await mkdir('physical-evidence-report', { recursive: true });
    await client.connect();
    connected = true;
    const python = await readFile(new URL('./issue-1166-physical-probe.py', import.meta.url), 'utf8');
    const report = await collect({
      context, baseline, signal: stop.signal,
      read: () => readScope(client, context),
      provider: {
        info: () => { assertSandbox(TARGET.sandboxId); return Sandbox.getInfo(TARGET.sandboxId, apiOptions()); },
        connect: signal => {
          assertSandbox(TARGET.sandboxId);
          return Sandbox.connect(TARGET.sandboxId, { ...apiOptions(), timeoutMs: 180_000,
            signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
        },
        pause: () => { assertSandbox(TARGET.sandboxId); return Sandbox.pause(TARGET.sandboxId, apiOptions()); },
      },
      probe: async (sandbox, before, signal) => {
        assertSandbox(sandbox.sandboxId);
        const input = Buffer.from(JSON.stringify({ target: TARGET, phase: context.phase,
          prefixes: before?.sessions ?? [] })).toString('base64');
        const command = "timeout --signal=TERM --kill-after=2s 20s /usr/bin/python3 -B - '" +
          input + "' <<'MIKKA_EVIDENCE_PY'\n" + python + "\nMIKKA_EVIDENCE_PY";
        const result = await sandbox.commands.run(command, { user: 'root', timeoutMs: 25_000,
          requestTimeoutMs: 10_000, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
        requireThat(result.exitCode === 0 && result.stderr === '' &&
          result.stdout.length <= 128 * 1024, 'physical_probe_failed');
        return JSON.parse(result.stdout);
      },
      checkpoint: report => writeFile('physical-evidence-report/evidence.json',
        JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }),
    });
    console.log(JSON.stringify({ phase: report.phase, outcome: report.outcome,
      failure: report.failure ?? null, restoration: report.restoration,
      scopeSha256: report.scopeSha256 ?? null }));
    process.exitCode = report.outcome === 'passed' ? 0 : 1;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
    if (connected) await client.end().catch(() => {});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify({ outcome: 'failed', failure: errorCode(error) }));
    process.exitCode = 1;
  });
}
