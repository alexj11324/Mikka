import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  TARGET, AUTHORITY, EvidenceError, assertSandbox, executionContext, loadCredentials, readScope, SCOPE_SQL,
  validateScope, validatePhysical, baselineForAfter, compareAfter, collect,
} from './issue-1166-physical-evidence.mjs';

const id = '12345678-1234-1234-1234-123456789abc';
const hash = 'a'.repeat(64);
const context = { phase: 'before', custodyRunId: TARGET.failedRunId,
  sourceSha: 'b'.repeat(40), workflowRunId: '123', beforeRunId: null };
const afterContext = { ...context, phase: 'after', custodyRunId: id, workflowRunId: '124', beforeRunId: '123' };
const runnerEnv = {
  GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: TARGET.repository,
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: TARGET.ref,
  GITHUB_SHA: context.sourceSha, GITHUB_RUN_ID: '123',
  EVIDENCE_EXPECTED_SOURCE_SHA: context.sourceSha, EVIDENCE_PHASE: 'before',
  EVIDENCE_CUSTODY_RUN_ID: TARGET.failedRunId,
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/fixture/_apis/distributedtask/hubs/build/plans/' + id + '/jobs/' + id + '/idtoken?api-version=2.0',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fake-runner-token',
};
function scope(after = false) {
  return {
    ownerId: 'fixture-owner', ownerEmailSha256: TARGET.ownerEmailSha256,
    questionId: TARGET.questionId, taskId: TARGET.taskId, issueId: TARGET.issueId,
    workspaceId: TARGET.workspaceId, botId: TARGET.botId, answerId: TARGET.answerId,
    questionOriginRunId: TARGET.originRunId, questionSessionId: TARGET.sessionId,
    questionContinuationRunId: after ? id : TARGET.failedRunId,
    questionStatus: 'blocked', questionRevision: after ? 4 : 3,
    answerSha256: hash, answerFingerprintSha256: hash, receiptSha256: hash,
    receiptQuestionId: TARGET.questionId, receiptContinuationRunId: TARGET.failedRunId,
    receiptTaskId: TARGET.taskId, taskStatus: 'blocked', taskRevision: after ? 15 : 13,
    taskAttemptId: id, originStatus: 'stopped', originSessionId: TARGET.sessionId,
    originRowSha256: hash, originMachineState: 'ended', originSandboxId: null,
    failedStatus: 'failed', failedSessionId: TARGET.sessionId, failedRowSha256: hash,
    failedMachineState: after ? 'ended' : 'paused', failedSandboxId: after ? null : TARGET.sandboxId,
    failedQuestionId: TARGET.questionId, failedOriginRunId: TARGET.originRunId,
    failedOriginSessionId: TARGET.sessionId, failedRequiredSandboxId: TARGET.sandboxId,
    failedRequireResume: 'true', frozenDefinitionDigest: hash, frozenDefinitionsMatch: true,
    harness: 'codex', modelSource: 'subscription', subscriptionBindingId: TARGET.subscriptionBindingId,
    subscriptionRoute: 'codex_cli', subscriptionModel: TARGET.subscriptionModel, hasApiKey: false,
    custodyRunId: after ? id : TARGET.failedRunId, custodyRunStatus: 'failed',
    custodySessionId: TARGET.sessionId, custodyStopped: false,
    custodyQuestionId: TARGET.questionId, custodyOriginRunId: TARGET.originRunId,
    custodyOriginSessionId: TARGET.sessionId, custodyRequiredSandboxId: TARGET.sandboxId,
    custodyRequireResume: 'true', custodyDefinitionMatches: true,
    custodyAttemptId: id, custodyAttemptStatus: 'blocked', custodyLeaseExpiresAt: null, custodyLeaseLive: false,
    lineage: after ? [id, TARGET.failedRunId] : [TARGET.failedRunId],
    sandboxId: TARGET.sandboxId, machineState: 'paused', snapshotId: 'codex',
    deviceId: id, repoId: id, epoch: 1, operationId: id, workerLeaseId: null,
    workerLeaseUntil: null, workerLeaseLive: null, sandboxOwnerCount: 1,
    activeRunCount: 0, liveTaskLeaseCount: 0,
  };
}
function physical(after = false) {
  return {
    version: 1, sessionId: TARGET.sessionId,
    file: { bytes: TARGET.fileBytes, sha256: TARGET.fileSha256 },
    git: { head: TARGET.snapshot, snapshotAncestor: true, initialAncestor: true,
      fileMatchesHead: true, snapshotFileSha256: TARGET.fileSha256, trackedStatusSha256: hash },
    workerSourceSha: 'c'.repeat(40), journalFileSha256: hash,
    journals: [TARGET.originRunId, TARGET.failedRunId].map((runId, index) => ({
      runId, state: index === 0 ? 'stopped' : 'failed', sessionId: TARGET.sessionId,
      worktree: TARGET.worktree, projectionSha256: hash,
    })),
    ledgers: [TARGET.originRunId, TARGET.failedRunId].map(runId => ({
      runId, sessionId: TARGET.sessionId, workspaceId: TARGET.workspaceId, route: 'codex_cli',
      bindingId: TARGET.subscriptionBindingId, consumerId: id, revision: 2, accountIdSha256: hash, fileSha256: hash,
    })),
    sessions: [TARGET.originRunId, TARGET.failedRunId].map(runId => ({
      runId, kind: 'sessions', sessionId: TARGET.sessionId, filenameSha256: hash,
      bytes: after ? 150 : 100, sha256: after ? 'd'.repeat(64) : hash,
      prefixMatches: after ? true : null,
    })),
  };
}
function harness(options = {}) {
  const calls = [];
  let state = options.state ?? 'paused';
  let reads = 0;
  const selected = options.context ?? context;
  return {
    calls,
    args: {
      context: selected, baseline: options.baseline, signal: options.signal,
      read: async () => {
        calls.push('read');
        reads++;
        return options.read ? options.read(reads) : scope(selected.phase === 'after');
      },
      provider: {
        info: async () => {
          calls.push('info');
          return { sandboxId: TARGET.sandboxId, state,
            metadata: { application: 'mikka-thread', workspaceId: TARGET.workspaceId },
            lifecycle: { onTimeout: 'pause', autoResume: false } };
        },
        connect: async () => {
          calls.push('connect'); state = 'running';
          options.afterConnect?.();
          if (options.connectError) throw new Error('secret-provider-response');
          return { sandboxId: TARGET.sandboxId };
        },
        pause: async () => {
          calls.push('pause');
          if (!options.pauseUnconfirmed) state = 'paused';
        },
      },
      probe: async () => {
        calls.push('probe');
        if (options.probe) return options.probe();
        if (options.probeError) throw new Error('secret-provider-response');
        return physical(selected.phase === 'after');
      },
      checkpoint: async report => {
        assert.equal(JSON.stringify(report).includes('secret-provider-response'), false);
      },
    },
  };
}

test('fixed target excludes Acme and every other VM', () => {
  assert.doesNotThrow(() => assertSandbox(TARGET.sandboxId));
  for (const value of [TARGET.protectedSandboxId, 'another-vm', null]) {
    assert.throws(() => assertSandbox(value), /sandbox_not_authorized/);
  }
});
test('only a reviewed commit on the dedicated dispatch branch is executable', () => {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: TARGET.repository,
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: TARGET.ref,
    GITHUB_SHA: context.sourceSha, GITHUB_RUN_ID: '123',
    EVIDENCE_EXPECTED_SOURCE_SHA: context.sourceSha, EVIDENCE_PHASE: 'before',
    EVIDENCE_CUSTODY_RUN_ID: TARGET.failedRunId };
  assert.deepEqual(executionContext(env), context);
  for (const change of [
    { GITHUB_REF: 'refs/heads/main' }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REPOSITORY: 'untrusted/fork' }, { EVIDENCE_EXPECTED_SOURCE_SHA: 'd'.repeat(40) },
    { EVIDENCE_CUSTODY_RUN_ID: id }, { EVIDENCE_PHASE: 'after' },
  ]) assert.throws(() => executionContext({ ...env, ...change }));
});
function credentialFetch({ failAt, wrongDatabase } = {}) {
  const calls = [];
  let errorBodyRead = false;
  const values = { E2B_API_KEY: 'fake-e2b-key', MIKKA_DATABASE_URL:
    'postgresql://fixture:fake-password@' + (wrongDatabase ? 'wrong.example.invalid' : AUTHORITY.databaseHosts[0]) + '/orvilo_mvp?sslmode=require' };
  return {
    calls, values, errorBodyRead: () => errorBodyRead,
    request: async (url, options) => {
      calls.push({ url: new URL(url), options });
      if (calls.length === failAt) return { ok: false, json: async () => {
        errorBodyRead = true; return { secret: 'must-never-read-or-print' };
      } };
      const payload = calls.length === 1 ? { value: 'fake.github.jwt' }
        : calls.length === 2 ? { accessToken: 'fake-infisical-token' }
        : { secret: { secretKey: AUTHORITY.secretNames[calls.length - 3],
          secretValue: values[AUTHORITY.secretNames[calls.length - 3]] } };
      return { ok: true, json: async () => payload };
    },
  };
}
test('OIDC fetch reuses one fixed identity and only two exact secret endpoints, without redirects', async () => {
  const h = credentialFetch();
  assert.deepEqual(await loadCredentials(runnerEnv, h.request), h.values);
  assert.equal(h.calls.length, 4);
  assert.equal(h.calls[0].url.origin, 'https://pipelines.actions.githubusercontent.com');
  assert.equal(h.calls[0].url.searchParams.get('audience'), AUTHORITY.audience);
  assert.equal(h.calls[1].url.href, 'https://app.infisical.com/api/v1/auth/oidc-auth/login');
  assert.equal(new URLSearchParams(h.calls[1].options.body).get('identityId'), AUTHORITY.identityId);
  assert.deepEqual(h.calls.slice(2).map(row => row.url.pathname), [
    '/api/v3/secrets/raw/E2B_API_KEY', '/api/v3/secrets/raw/MIKKA_DATABASE_URL',
  ]);
  for (const row of h.calls.slice(2)) {
    assert.equal(row.url.origin, 'https://app.infisical.com');
    assert.deepEqual(Object.fromEntries(row.url.searchParams), {
      workspaceId: AUTHORITY.projectId, environment: 'prod', secretPath: '/vercel',
      include_imports: 'false', expandSecretReferences: 'false',
    });
  }
  for (const row of h.calls) {
    assert.equal(row.options.redirect, 'error');
    assert.ok(row.options.signal instanceof AbortSignal);
  }
});
test('OIDC failure never reads response bodies and never retries with another identity', async () => {
  for (const failAt of [1, 2, 3, 4]) {
    const h = credentialFetch({ failAt });
    await assert.rejects(loadCredentials(runnerEnv, h.request), error => {
      assert.ok(error instanceof EvidenceError);
      assert.match(error.message, /^(oidc_request_failed|infisical_login_failed|named_secret_request_failed)$/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(h.calls.length, failAt);
    assert.equal(h.errorBodyRead(), false);
  }
});
test('runner-issued modern OIDC routes retain opaque parameters and force the fixed audience', async () => {
  const h = credentialFetch();
  const url = 'https://run-actions-2-azure-eastus.actions.githubusercontent.com/42//idtoken/' +
    id + '/' + id + '?service-parameter=opaque&audience=wrong&audience=also-wrong';
  assert.deepEqual(await loadCredentials({ ...runnerEnv, ACTIONS_ID_TOKEN_REQUEST_URL: url }, h.request), h.values);
  assert.equal(h.calls[0].url.hostname, 'run-actions-2-azure-eastus.actions.githubusercontent.com');
  assert.equal(h.calls[0].url.pathname, '/42//idtoken/' + id + '/' + id);
  assert.equal(h.calls[0].url.searchParams.get('service-parameter'), 'opaque');
  assert.deepEqual(h.calls[0].url.searchParams.getAll('audience'), [AUTHORITY.audience]);
  assert.equal(h.calls[0].options.redirect, 'error');
});
test('wrong OIDC authority or database endpoint fails before any VM access', async () => {
  for (const url of [
    'http://pipelines.actions.githubusercontent.com/idtoken',
    'https://attacker.example.invalid/idtoken',
    'https://run-actions-2-azure-eastus.actions.githubusercontent.com.attacker.invalid/idtoken',
    'https://nested.run-actions-2-azure-eastus.actions.githubusercontent.com/idtoken',
    'https://-invalid.actions.githubusercontent.com/idtoken',
    'https://invalid-.actions.githubusercontent.com/idtoken',
    'https://user:password@run-actions-2-azure-eastus.actions.githubusercontent.com/idtoken',
    'https://run-actions-2-azure-eastus.actions.githubusercontent.com:8443/idtoken',
    'https://run-actions-2-azure-eastus.actions.githubusercontent.com/',
    'https://run-actions-2-azure-eastus.actions.githubusercontent.com/' + 'x'.repeat(2048),
    runnerEnv.ACTIONS_ID_TOKEN_REQUEST_URL + '#fragment',
  ]) {
    const h = credentialFetch();
    await assert.rejects(loadCredentials({ ...runnerEnv, ACTIONS_ID_TOKEN_REQUEST_URL: url }, h.request), /oidc_url_rejected/);
    assert.equal(h.calls.length, 0);
  }
  const h = credentialFetch({ wrongDatabase: true });
  await assert.rejects(loadCredentials(runnerEnv, h.request), /database_target_rejected/);
});
test('SQL runs in a read-only transaction with exact target parameters and always rolls back', async () => {
  const calls = [];
  const client = { query: async (sql, args) => {
    calls.push([sql, args]);
    return sql === SCOPE_SQL ? { rows: [{ scope: scope() }] } : {};
  } };
  assert.deepEqual(await readScope(client, context), scope());
  assert.equal(calls[0][0], 'BEGIN READ ONLY');
  assert.equal(calls.at(-1)[0], 'ROLLBACK');
  assert.deepEqual(calls[2][1], [TARGET.questionId, TARGET.taskId, TARGET.issueId,
    TARGET.workspaceId, TARGET.botId, TARGET.originRunId, TARGET.failedRunId,
    TARGET.sandboxId, TARGET.failedRunId]);
  assert.doesNotMatch(SCOPE_SQL, /\b(?:INSERT|UPDATE|DELETE|FOR\s+SHARE|FOR\s+UPDATE|advisory)\b/i);
  const failedCalls = [];
  await assert.rejects(readScope({ query: async sql => {
    failedCalls.push(sql);
    if (sql === SCOPE_SQL) throw new Error('database unavailable');
    return {};
  } }, context));
  assert.equal(failedCalls.at(-1), 'ROLLBACK');
});
test('successful before collection confirms same VM paused before reporting pass', async () => {
  const h = harness();
  const result = await collect(h.args);
  assert.equal(result.outcome, 'passed');
  assert.equal(result.restoration, 'confirmed_paused');
  assert.deepEqual(h.calls, ['read', 'info', 'read', 'connect', 'read', 'probe',
    'read', 'read', 'info', 'read', 'pause', 'info']);
});
test('probe failure is sanitized and still restores the original paused state', async () => {
  const h = harness({ probeError: true });
  const result = await collect(h.args);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.failure, 'operation_failed');
  assert.equal(result.restoration, 'confirmed_paused');
  assert.equal(h.calls.filter(value => value === 'pause').length, 1);
});
test('connect error may have resumed the VM, so unchanged custody still restores paused', async () => {
  const h = harness({ connectError: true });
  const result = await collect(h.args);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.restoration, 'confirmed_paused');
  assert.equal(h.calls.includes('probe'), false);
  assert.equal(h.calls.includes('pause'), true);
});
test('scope drift after connect aborts before probe and never pauses the new owner', async () => {
  const h = harness({ read: n => ({ ...scope(), taskRevision: n >= 3 ? 14 : 13 }) });
  const result = await collect(h.args);
  assert.equal(result.failure, 'scope_changed');
  assert.equal(result.restoration, 'skipped_scope_changed');
  assert.equal(h.calls.includes('probe'), false);
  assert.equal(h.calls.includes('pause'), false);
});
test('new lease during collection prevents pause, including after a successful probe', async () => {
  for (const key of ['workerLeaseLive', 'custodyLeaseLive']) {
    const h = harness({ read: n => ({ ...scope(), [key]: n >= 5 }) });
    const result = await collect(h.args);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.restoration, 'skipped_scope_changed');
    assert.equal(h.calls.includes('pause'), false);
  }
});
test('the final read immediately before pause detects takeover', async () => {
  const h = harness({ read: n => ({ ...scope(), epoch: n >= 6 ? 2 : 1 }) });
  const result = await collect(h.args);
  assert.equal(result.restoration, 'skipped_scope_changed');
  assert.equal(h.calls.includes('pause'), false);
});
test('database unavailable during cleanup never guesses that it still owns the VM', async () => {
  const h = harness({ read: n => {
    if (n >= 5) throw new Error('database unavailable');
    return scope();
  } });
  const result = await collect(h.args);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.restoration, 'unconfirmed');
  assert.equal(h.calls.includes('pause'), false);
});
test('a running VM at entry is inspected only, never connected or paused', async () => {
  const h = harness({ state: 'running' });
  const result = await collect(h.args);
  assert.equal(result.failure, 'provider_not_paused');
  assert.deepEqual(h.calls, ['read', 'info']);
});
test('after active new continuation is inspected only, never connected or paused', async () => {
  const h = harness({ context: afterContext, read: () => ({
    ...scope(true), custodyRunStatus: 'running', custodySessionId: null, activeRunCount: 1,
  }) });
  const result = await collect(h.args);
  assert.equal(result.failure, 'scope_not_idle');
  assert.deepEqual(h.calls, ['read', 'info']);
});
test('owner/VM rejection happens before any provider call', async () => {
  for (const change of [
    { ownerEmailSha256: 'f'.repeat(64) }, { sandboxId: TARGET.protectedSandboxId },
    { hasApiKey: true }, { failedOriginRunId: id },
    { subscriptionBindingId: id }, { subscriptionModel: 'another-model' },
  ]) {
    const h = harness({ read: () => ({ ...scope(), ...change }) });
    const result = await collect(h.args);
    assert.equal(result.outcome, 'failed');
    assert.deepEqual(h.calls, ['read']);
  }
});
test('SIGTERM or deadline after connect still attempts bounded, guarded restoration', async () => {
  const stop = new AbortController();
  const h = harness({ signal: stop.signal, afterConnect: () => stop.abort() });
  const result = await collect(h.args);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.restoration, 'confirmed_paused');
  assert.equal(h.calls.includes('probe'), false);
});
test('provider accepting pause without paused getInfo is not successful restoration', async () => {
  const h = harness({ pauseUnconfirmed: true });
  const result = await collect(h.args);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.restoration, 'unconfirmed');
  assert.equal(result.restorationFailure, 'pause_not_confirmed');
});
test('scope watcher aborts a still-running physical probe when business becomes active', async () => {
  const h = harness({
    read: n => ({ ...scope(), activeRunCount: n >= 4 ? 1 : 0 }),
    probe: () => new Promise(() => {}),
  });
  const result = await collect(h.args);
  assert.equal(result.failure, 'scope_not_idle');
  assert.equal(result.restoration, 'skipped_scope_changed');
  assert.equal(h.calls.includes('pause'), false);
});
test('remote output is reduced to the allowed fields; no arbitrary JSON enters artifacts', () => {
  const raw = physical();
  raw.secret = 'secret-provider-response';
  raw.journals[0].assignment = { token: 'secret-provider-response' };
  raw.sessions[0].raw = 'secret-provider-response';
  assert.equal(JSON.stringify(validatePhysical(raw)).includes('secret-provider-response'), false);
});
test('after compares exact old DB/journal/ledger evidence and allows SID history append by prefix', async () => {
  const before = await collect(harness().args);
  const baseline = baselineForAfter(before, afterContext);
  const h = harness({ context: afterContext, baseline });
  const result = await collect(h.args);
  assert.equal(result.outcome, 'passed');
  assert.equal(result.restoration, 'confirmed_paused');
  const changed = physical(true);
  changed.sessions[0].prefixMatches = false;
  assert.throws(() => compareAfter(baseline, scope(true), changed), /historical_session_prefix_changed/);
  assert.throws(() => compareAfter(baseline, { ...scope(true), failedRowSha256: 'f'.repeat(64) }, physical(true)),
    /historical_database_row_changed/);
  assert.throws(() => baselineForAfter(before, { ...afterContext, sourceSha: 'd'.repeat(40) }),
    /before_report_rejected/);
});
test('after rejects another question, broken continuation lineage or changed physical custody', () => {
  for (const change of [
    { questionContinuationRunId: TARGET.failedRunId }, { lineage: [id] },
    { custodyOriginSessionId: 'different' }, { failedSandboxId: TARGET.sandboxId },
  ]) assert.throws(() => validateScope({ ...scope(true), ...change }, afterContext), EvidenceError);
});
test('reviewed workflow delegates scoped secret reads to the driver and has no automatic triggers', async () => {
  const text = await readFile(new URL('../../.github/workflows/production-smoke.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /Infisical\/secrets-action|secret-path:|GITHUB_ENV/);
  assert.deepEqual(AUTHORITY.secretNames, ['E2B_API_KEY', 'MIKKA_DATABASE_URL']);
  assert.doesNotMatch(text, /^\s+(?:schedule|deployment_status|push|pull_request):/m);
  assert.match(text, /cancel-in-progress: false/);
  assert.match(text, /persist-credentials: false/);
});
