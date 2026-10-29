import { isolatedPostgresURL } from "../../tests/helpers/isolated-postgres.mjs";
import { createFactoryDispatch } from "./dispatch";
import { factoryDispatchDatabase } from "./transaction";
import { insertRunOnce } from "../run-dispatch";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  readFile,
  readdir,
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  factoryCheckGates,
  configureFactoryCheck,
  createFactoryCheckClaim,
} from "./checks";
import { createFactoryTestAuthority } from "../../tests/helpers/factory-test-authority";
import { createLocalPublicationAdapter } from "./local-publication";
import {
  createVercelPublicationAdapter,
  MIKKA_VERCEL,
  vercelTarget,
} from "./vercel-publication";
import { createVercelMonitorProbe } from "./vercel-monitor";
import { vercelProtocolFixture } from "../../tests/helpers/factory-vercel";
import { createLocalMonitorProbe } from "./monitor-probe";
import { readFactoryPublicationReceiptV2 } from "./publication-receipt";
import { readFactoryArtifact } from "./evidence";
import { registerHooks } from "node:module";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import { evidenceSchema, FactoryError, type FactoryBinding } from "./contract";
import { handleFactory } from "./http";
import {
  createFactoryStore,
  type FactoryTask,
  type FactorySnapshot,
} from "./store";
import {
  createFactoryMonitor,
  monitorGate,
  type MonitorInput,
} from "./monitor";
import {
  monitorFingerprint,
  normalizeMonitorFailure,
  monitorWorkspacePartition,
} from "./monitor-fingerprint";

test("legacy and unlinked workspace issues never collapse into a personal-owner partition", () => {
  const base = {
    userId: "owner",
    issueId: "issue-a",
    workspaceId: null,
    issueScope: "workspace",
    linearTeamSyncId: null,
  };
  assert.notEqual(
    monitorWorkspacePartition(base),
    monitorWorkspacePartition({ ...base, issueId: "issue-b" }),
  );
  assert.notEqual(
    monitorWorkspacePartition({ ...base, linearTeamSyncId: "team-a" }),
    monitorWorkspacePartition({ ...base, linearTeamSyncId: "team-b" }),
  );
  assert.equal(
    monitorWorkspacePartition({ ...base, workspaceId: "workspace-a" }),
    "workspace:workspace-a",
  );
  assert.equal(
    monitorWorkspacePartition({ ...base, issueScope: "personal" }),
    "personal:owner",
  );
});

test("fingerprints strip volatile IDs and secret output; owner/workspace/component/candidate environment isolate failures", () => {
  const base = {
    userId: "one",
    workspaceKey: "workspace:a",
    repository: "repo",
    environment: "preview:fixed",
    component: "backend",
    check: "health",
    failure:
      "failed request 123 token=secret-value https://user:pass@example.invalid/?key=secret",
  };
  const fingerprint = monitorFingerprint(base).fingerprint;
  assert.equal(
    monitorFingerprint({
      ...base,
      failure:
        "failed request 456 token=another https://other.invalid/?token=xyz",
    }).fingerprint,
    fingerprint,
  );
  for (const key of [
    "userId",
    "workspaceKey",
    "repository",
    "environment",
    "component",
    "check",
  ] as const)
    assert.notEqual(
      monitorFingerprint({ ...base, [key]: "other" }).fingerprint,
      fingerprint,
    );
  assert.doesNotMatch(
    normalizeMonitorFailure(base.failure),
    /secret-value|user:pass|example.invalid/,
  );
  assert.notEqual(
    monitorFingerprint({ ...base, failure: "database unavailable" })
      .fingerprint,
    fingerprint,
  );
});

// Explicit disposable loopback target only. Never read DATABASE_URL/credentials or impersonate CI.
const target = process.env.FACTORY_MONITOR_TEST_URL;
if (target) {
  const url = new URL(target);
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(
    url.pathname === "/mikka_monitor_195" ||
      (process.env.CI === "true" &&
        process.env.GITHUB_ACTIONS === "true" &&
        url.pathname === "/mikka_e2e"),
  );
}
const binding = (t: FactoryTask): FactoryBinding => ({
  taskId: t.id,
  issueId: t.issueId,
  attemptId: t.attemptId,
  revision: t.revision,
  candidateId: t.candidateId,
});
const rejects = (fn: () => Promise<unknown>, code: string) =>
  assert.rejects(
    fn,
    (error: unknown) => error instanceof FactoryError && error.code === code,
  );

test(
  "PG17 monitor: real transactions, concurrent dedupe, original issue, restart/rollback, fences, repair and recovery",
  { skip: !target, timeout: 120_000 },
  async (t) => {
    // Only resolve Next's compile-time marker; use actual document/Yjs/SQL behavior.
    const marker = registerHooks({
      resolve(specifier, context, next) {
        return next(
          specifier === "server-only"
            ? "next/dist/compiled/server-only/empty.js"
            : specifier,
          context,
        );
      },
    });
    const { appendMonitorEvidence } = await import("./monitor-evidence");
    const { loadIssueDocument, readIssueThreads } =
      await import("../linear-sync/document");
    marker.deregister();
    const fixtureURL = await isolatedPostgresURL(target!);
    const schema = `monitor_195_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: fixtureURL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    let pool = new Pool({
      connectionString: fixtureURL,
      max: 16,
      options: `-c search_path=${schema}`,
    });
    const scopes = new Map<string, string>();
    const denied = new Set<string>();
    const authorize = async (
      userId: string,
      issueId: string,
      tx: PoolClient,
    ) => {
      const { rows } = await tx.query(
        'SELECT id FROM issues WHERE id=$1 AND "userId"=$2 FOR SHARE',
        [issueId, userId],
      );
      return rows.length === 1 && !denied.has(issueId);
    };
    const policyFixture = createFactoryTestAuthority();
    const { approvals: createFactoryApprovals, gates: { approval: approvalGate, publish: publishGate } } = policyFixture;
    // Actual 193/194 validators and publisher; OAuth/Harness identities and conclusions remain fixtures.
    const integrationGates = {
      ...factoryCheckGates,
      approval: approvalGate,
      publish: publishGate,
      monitor: monitorGate,
    };
    const targetRoot = await mkdtemp(
      join(tmpdir(), "mikka-195-real-publication-"),
    );
    const publicationTarget = "local-monitor-target",
      targetEnvironment = "local-monitor-acceptance",
      repository = MIKKA_VERCEL.repository;
    const cloud = await vercelProtocolFixture();
    const actualProbes: unknown[] = [];
    const ownerFixtures = new Map<
      string,
      { deviceId: string; repoId: string; agentId: string; sessionId: string }
    >();
    let store = createFactoryStore(pool, authorize, integrationGates);
    let appendCount = 0;
    let failAppend = false;
    const makeMonitor = () =>
      createFactoryMonitor(
        pool,
        store,
        authorize,
        async (owner, issue) => scopes.get(issue) ?? `personal:${owner}`,
        async (tx, notice) => {
          if (failAppend) throw new Error("injected rollback before commit");
          await appendMonitorEvidence(tx, notice);
          appendCount++;
        },
        [
          createVercelMonitorProbe(
            "production",
            () => "disposable-protocol-fixture",
            { testOrigin: cloud.origin },
          ),
          createLocalMonitorProbe({
            root: targetRoot,
            target: publicationTarget,
            environment: targetEnvironment,
            repository,
          }),
        ],
      );
    let monitor = makeMonitor();
    const agentId = randomUUID();
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: new URL("../..", import.meta.url),
      encoding: "utf8",
    }).trim();
    const ensureOwner = async (owner: string) => {
      const cached = ownerFixtures.get(owner);
      if (cached) return cached;
      const f = {
        deviceId: randomUUID(),
        repoId: randomUUID(),
        agentId: owner === "owner" ? agentId : randomUUID(),
        sessionId: randomUUID(),
      };
      await pool.query(
        `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now()) ON CONFLICT (id) DO NOTHING`,
        [owner, owner + "@example.invalid"],
      );
      await pool.query(
        `INSERT INTO "session" (id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES ($1,$2,$3,now()+interval '1 hour',now(),now())`,
        [f.sessionId, owner, "fixture-cookie-" + randomUUID()],
      );
      await pool.query(
        `INSERT INTO account (id,"userId","providerId","accountId","createdAt","updatedAt") VALUES ($1,$2,'github',$3,now(),now())`,
        [randomUUID(), owner, "fixture-" + owner],
      );
      await pool.query(
        `INSERT INTO devices (id,"ownerId",name,enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'Local identity fixture',true,now(),'[{"harness":"codex","installed":true}]')`,
        [f.deviceId, owner],
      );
      await pool.query(
        `INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl","verifyCommand") VALUES ($1,$2,$3,$4,$5,'git rev-parse HEAD')`,
        [
          f.repoId,
          f.deviceId,
          owner,
          new URL("../..", import.meta.url).pathname,
          repository,
        ],
      );
      await pool.query(
        `INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,$2,$3,'codex',$4) ON CONFLICT (id) DO UPDATE SET "deviceId"=excluded."deviceId"`,
        [f.agentId, owner, "Fixture agent " + owner, f.deviceId],
      );
      ownerFixtures.set(owner, f);
      return f;
    };
    const source = async (
      userId: string,
      issueId: string,
      runId: string | null = null,
      kind = "user_message",
    ) => {
      const id = randomUUID();
      await pool.query(
        'INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey","issueId","runId",payload) VALUES ($1,$2,$3,$4,$5,$6,\'{}\')',
        [id, userId, kind, `fixture:${id}`, issueId, runId],
      );
      return id;
    };
    const issue = async (owner = "owner", workspace = "workspace:a", scope: "personal" | "workspace" = "personal") => {
      const id = randomUUID();
      await pool.query(
        'INSERT INTO issues (id,"userId",title,content,status,priority,scope) VALUES ($1,$2,\'Monitor layer fixture\',\'{"type":"doc","content":[{"type":"paragraph"}]}\',\'todo\',\'normal\',$3)',
        [id, owner, scope],
      );
      scopes.set(id, workspace);
      return id;
    };
    const run = async (owner: string, issueId: string, kind: 'implement' | 'acceptance' = 'implement') => {
      const f = await ensureOwner(owner),
        id = randomUUID();
      await pool.query(
        `INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",kind,status,"sessionId","startedAt") VALUES ($1,$2,$3,$4,$5,$6,$8,'queued',$7,clock_timestamp())`,
        [id, owner, issueId, f.agentId, f.deviceId, f.repoId, `session:${id}`, kind],
      );
      return id;
    };
    const complete = async (
      id: string,
      failure: string | null = null,
      commit = sha,
    ) => {
      const actual = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: new URL("../..", import.meta.url),
        encoding: "utf8",
      });
      const report = {
        summary: "Actual local command; Harness and conclusions are fixtures",
        filesChanged: [],
        check: { sha: commit, readOnly: true },
        verify: {
          status: failure ? "failed" : "passed",
          command: "git rev-parse HEAD",
          exitCode: failure ? 1 : 0,
          signal: null,
          timedOut: false,
          output: failure ?? actual,
        },
        criteria: [
          {
            passed: !failure,
            text: "Explicit fixture conclusion",
            evidence: actual,
          },
        ],
        openQuestions: [],
        nextStep: null,
        publish: { branch: "fixture", commit, pushed: false, remote: null },
      };
      await pool.query(
        `UPDATE agent_runs SET status=$2,"stopReason"='submitted',report=$3,"finishedAt"=clock_timestamp() WHERE id=$1`,
        [id, failure ? "failed" : "succeeded", JSON.stringify(report)],
      );
      return report;
    };
    const evidence = async (
      task: FactoryTask,
      runId: string,
    ): Promise<import("./contract").FactoryEvidence> => {
      const c = (
        await pool.query(
          "SELECT environment,sha FROM factory_candidates WHERE id=$1",
          [task.candidateId],
        )
      ).rows[0];
      const recordedAt = (
        await pool.query("SELECT clock_timestamp() AS t")
      ).rows[0].t.toISOString();
      return {
        artifact: `run-report:${runId}`,
        kind: "report",
        runId,
        sessionId: `session:${runId}`,
        candidateId: task.candidateId,
        sha: c.sha,
        environment: c.environment,
        recordedAt,
      };
    };
    const publicationFor = async (owner: string, task: FactoryTask) => {
      const tx = await pool.connect();
      try {
        await tx.query("BEGIN");
        await tx.query("SELECT id FROM factory_tasks WHERE id=$1 FOR UPDATE", [
          task.id,
        ]);
        const r = await readFactoryPublicationReceiptV2(
          tx,
          owner,
          task.id,
          task.candidateId!,
        );
        await tx.query("COMMIT");
        return r;
      } catch (e) {
        await tx.query("ROLLBACK");
        throw e;
      } finally {
        tx.release();
      }
    };
    const probeAndComplete = async (
      owner: string,
      task: FactoryTask,
      id: string,
      failure: string | null,
    ) => {
      const receipt = await publicationFor(owner, task);
      const path = join(
        targetRoot,
        receipt.verifiedTarget.operationId + ".json",
      );
      if (receipt.verifiedTarget.provider) {
        cloud.state.healthStatus = failure === "cloud-health" ? 503 : 200;
        cloud.state.aliasOverride =
          failure === "cloud-alias" ? "dpl_moved" : null;
      } else if (failure) {
        const original = await readFile(path, "utf8");
        if (
          [
            "wrong-target",
            "wrong-environment",
            "wrong-sha",
            "wrong-operation",
          ].includes(failure)
        ) {
          const body = JSON.parse(original);
          if (failure === "wrong-target") body.target = "another-actual-target";
          if (failure === "wrong-environment")
            body.targetEnvironment = "local-another-environment";
          if (failure === "wrong-sha") body.candidate.sha = "2".repeat(40);
          if (failure === "wrong-operation") body.idempotencyKey = randomUUID();
          await writeFile(path, JSON.stringify(body) + "\n");
        } else await writeFile(path, original + " ");
      }
      await pool.query(`UPDATE agent_runs SET status='running' WHERE id=$1`, [
        id,
      ]);
      const audit = await monitor.probeRun(owner, id);
      assert.ok(audit);
      const rawArtifact = (
        await pool.query(
          'SELECT chunk FROM run_chunks WHERE "runId"=$1 AND seq=0',
          [id],
        )
      ).rows[0].chunk;
      actualProbes.push({ receipt, audit, rawArtifact });
      await pool.query(
        `UPDATE agent_runs SET status=$2,"stopReason"='submitted',report=$3,"finishedAt"=clock_timestamp() WHERE id=$1`,
        [
          id,
          audit.exitCode === 0 ? "succeeded" : "failed",
          JSON.stringify({
            summary: "Actual backend target probe; Harness identity fixture",
            filesChanged: [],
            check: { sha, readOnly: true },
            verify: {
              status: audit.exitCode === 0 ? "passed" : "failed",
              command: audit.command,
              exitCode: audit.exitCode,
              timedOut: audit.timedOut,
              signal: audit.signal,
            },
            publish: { commit: null },
          }),
        ],
      );
      return audit;
    };
    const toMonitor = async (
      owner: string,
      issueId: string,
      failure: string | null = "controlled local artifact fault",
      initial?: FactorySnapshot,
      production = false,
    ) => {
      let state =
        initial ??
        (await store.route(owner, {
          issueId,
          eventId: randomUUID(),
          sourceEventId: await source(owner, issueId),
          rationale: "Explicit local fixture",
        }));
      const f = await ensureOwner(owner),
        execute = await run(owner, issueId);
      state = await store.apply(owner, binding(state.task), randomUUID(), {
        action: "bind_run",
        runId: execute,
      });
      await complete(execute);
      state = await store.apply(owner, binding(state.task), randomUUID(), {
        action: "candidate",
        runId: execute,
        candidate: {
          sha,
          repository,
          environment: `device:${f.deviceId}`,
          scope: "backend-health",
        },
      });
      state = await store.apply(owner, binding(state.task), randomUUID(), {
        action: "finish",
        status: "passed",
        reason: "Executor identity fixture",
        evidence: [await evidence(state.task, execute)],
        output: {},
      });
      for (const stage of ["review", "verify"] as const) {
        state = await store.apply(owner, binding(state.task), randomUUID(), {
          action: "advance",
          stage,
          reason: "Independent gate integration",
        });
        const id = await run(owner, issueId, 'acceptance');
        const tx = await pool.connect();
        try {
          await tx.query("BEGIN");
          await configureFactoryCheck(tx, state.task, id);
          state = await store.apply(owner, binding(state.task), randomUUID(), {
            action: "bind_run",
            runId: id,
          }, tx);
          await tx.query("COMMIT");
        } catch (e) {
          await tx.query("ROLLBACK");
          throw e;
        } finally {
          tx.release();
        }
        await complete(id);
        const refs = [await evidence(state.task, id)];
        if (stage === "verify") {
          const input = randomUUID(),
            output = randomUUID(),
            call = randomUUID(),
            actual = execFileSync("git", ["rev-parse", "HEAD"], {
              cwd: new URL("../..", import.meta.url),
              encoding: "utf8",
            });
          await pool.query(
            'INSERT INTO run_chunks (id,"runId",seq,chunk) VALUES ($1,$2,1,$3),($4,$2,2,$5)',
            [
              input,
              id,
              JSON.stringify({
                type: "tool-input-available",
                toolName: "shell",
                toolCallId: call,
                input: { command: "git rev-parse HEAD" },
              }),
              output,
              JSON.stringify({
                type: "tool-output-available",
                toolCallId: call,
                output: { exitCode: 0, stdout: actual },
              }),
            ],
          );
          for (const chunk of [input, output])
            refs.push({
              ...(await evidence(state.task, id)),
              artifact: `run-chunk:${chunk}`,
              kind: "log",
            });
        }
        state = await store.read(owner, state.task.id);
        const output = state.attempts.find(
          (a) => a.id === state.task.attemptId,
        )!.output;
        state = await store.apply(owner, binding(state.task), randomUUID(), {
          action: "finish",
          status: "passed",
          reason: "Real 193 validator; fixture Harness conclusions",
          evidence: refs,
          output,
        });
      }
      state = await store.apply(owner, binding(state.task), randomUUID(), {
        action: "advance",
        stage: "approval",
        reason: "Independent gates passed",
      });
      const actor = { userId: owner, sessionId: f.sessionId };
      const selectedTarget = production
        ? vercelTarget({ ...MIKKA_VERCEL, environment: "production" })
        : publicationTarget;
      const selectedEnvironment = production ? "production" : targetEnvironment;
      const action = production
        ? ("deploy_production" as const)
        : ("deploy_preview" as const);
      const service = createFactoryApprovals(pool, authorize, store, [
        production
          ? createVercelPublicationAdapter(
              { ...MIKKA_VERCEL, environment: "production" },
              cloud.client,
            )
          : createLocalPublicationAdapter({
              root: targetRoot,
              target: publicationTarget,
              repository,
              environment: targetEnvironment,
              candidateEnvironment: `device:${f.deviceId}`,
            }),
      ]);
      const inventory = await service.evidence(actor, state.task.id);
      const approved = await service.approve(actor, policyFixture.request(actor.userId, {
        binding: inventory.binding,
        eventId: randomUUID(),
        candidate: inventory.manifest.candidate,
        action,
        target: selectedTarget,
        targetEnvironment: selectedEnvironment,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        evidenceDigest: inventory.evidenceDigest,
        evidenceReadId: inventory.evidenceReadId,
      }, inventory));
      await service.publish(actor, {
        ...approved,
        eventId: randomUUID(),
        action,
        target: selectedTarget,
        targetEnvironment: selectedEnvironment,
      });
      state = await store.read(owner, state.task.id);
      state = await store.apply(owner, binding(state.task), randomUUID(), {
        action: "advance",
        stage: "monitor",
        reason: "Actual local publication complete",
      });
      const dispatch = createFactoryDispatch(pool, store, (tx, userId, input) =>
        insertRunOnce(factoryDispatchDatabase(tx), userId, input, {
          deviceId: f.deviceId,
          baseBranch: "main",
          prompt: "Explicit local Harness identity fixture",
        }),
      );
      const dispatched = await dispatch(owner, {
        binding: binding(state.task),
        agentId: f.agentId,
        deviceRepoId: f.repoId,
      });
      const id = dispatched.runId;
      state = dispatched;
      const assignment = await createFactoryCheckClaim(pool, authorize)(
        owner,
        f.deviceId,
        id,
        new Date(Date.now() + 60000).toISOString(),
      );
      assert.equal(assignment.baseBranch, sha);
      assert.equal(assignment.policy.readOnly, true);
      await pool.query('UPDATE agent_runs SET "sessionId"=$2 WHERE id=$1', [
        id,
        `session:${id}`,
      ]);
      await probeAndComplete(owner, state.task, id, failure);
      return {
        task: state.task,
        input: {
          binding: binding(state.task),
          sourceEventId: await source(owner, issueId, id, "run_finished"),
        } satisfies MonitorInput,
        runId: id,
      };
    };
    try {
      assert.match(
        (await pool.query("SHOW server_version")).rows[0].server_version,
        /^17\./,
      );
      const dir = new URL("../../drizzle/", import.meta.url);
      for (const name of orderMigrations(
        (await readdir(dir)).filter((n) => n.endsWith(".sql")),
      ))
        await pool.query(await readFile(new URL(name, dir), "utf8"));
      await pool.query(
        await readFile(
          new URL("20261029044005_factory_195_monitor.sql", dir),
          "utf8",
        ),
      );
      await pool.query(
        "INSERT INTO agents (id,\"userId\",name,harness) VALUES ($1,'owner','Fixture agent','codex')",
        [agentId],
      );
      // This monitor case starts from an already imported workspace issue.
      // A personal task cannot acquire team consent through a fixture UPDATE.
      const issueId = await issue("owner", "workspace:a", "workspace");
      const teamId = randomUUID();
      await pool.query(
        `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Fixture owner','owner@example.invalid',false,now(),now())`,
      );
      await pool.query(
        "INSERT INTO linear_team_syncs (id,\"ownerId\",\"linearTeamId\",\"linearTeamKey\",\"linearTeamName\") VALUES ($1,'owner','fixture-team','FIX','Fixture team')",
        [teamId],
      );
      await pool.query(
        'INSERT INTO linear_issue_links (id,"issueId","ownerId","teamSyncId","linearIssueId","linearIdentifier") VALUES ($1,$2,\'owner\',$3,\'fixture-remote-issue\',\'FIX-195\')',
        [randomUUID(), issueId, teamId],
      );
      const first = await toMonitor("owner", issueId);
      await t.test(
        "ten concurrent replays retain one observation and one original logical issue",
        async () => {
          const results = await Promise.all(
            Array.from({ length: 10 }, () =>
              monitor.consume("owner", first.input),
            ),
          );
          assert.equal(results.filter((r) => !r.replayed).length, 1);
          assert.equal(new Set(results.map((r) => r.incidentId)).size, 1);
          assert.ok(
            results.every((r) => r.issueId === issueId && r.occurrences === 1),
          );
          assert.equal(
            (
              await pool.query(
                "SELECT deliveries FROM factory_monitor_observations",
              )
            ).rows[0].deliveries,
            10,
          );
          assert.equal(appendCount, 1);
          const document = (
            await pool.query(
              'SELECT state FROM issue_documents WHERE "issueId"=$1',
              [issueId],
            )
          ).rows[0];
          const doc = loadIssueDocument(document.state, { type: "doc" });
          const threads = readIssueThreads(doc);
          assert.equal(threads.length, 1);
          assert.equal(threads[0].messages.length, 1);
          assert.match(
            threads[0].messages[0].body,
            new RegExp(first.input.sourceEventId),
          );
          assert.doesNotMatch(
            threads[0].messages[0].body,
            /fixture-secret|HTTP 503/,
          );
          doc.destroy();
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM linear_sync_outbox WHERE \"issueId\"=$1 AND status='queued'",
                [issueId],
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT "linearIssueId" FROM linear_issue_links WHERE "issueId"=$1',
                [issueId],
              )
            ).rows[0].linearIssueId,
            "fixture-remote-issue",
          );
          assert.equal(
            (await store.read("owner", first.task.id)).task.status,
            "failed",
          );
          await rejects(
            () =>
              monitor.consume("owner", {
                ...first.input,
                binding: { ...first.input.binding, revision: 999 },
              }),
            "factoryReplayMismatch",
          );
          const serialized = JSON.stringify(
            (await pool.query("SELECT * FROM factory_monitor_observations"))
              .rows,
          );
          assert.doesNotMatch(serialized, /fixture-secret|HTTP 503/);
        },
      );
      await t.test(
        "ten distinct failures reuse original issue, despite originating from other tasks",
        async () => {
          // Normal dispatch permits one live run per issue. Complete observations
          // sequentially, then deliver their ten distinct persisted events concurrently.
          const inputs = [];
          for (let i = 0; i < 10; i++)
            inputs.push(
              await toMonitor(
                "owner",
                issueId,
                `HTTP 503 request ${i} token=another-fixture`,
              ),
            );
          const results = await Promise.all(
            inputs.map((x) => monitor.consume("owner", x.input)),
          );
          assert.equal(new Set(results.map((r) => r.incidentId)).size, 1);
          assert.equal(
            (
              await pool.query(
                "SELECT occurrences FROM factory_monitor_incidents",
              )
            ).rows[0].occurrences,
            11,
          );
          assert.equal(
            (await pool.query("SELECT count(*)::int AS n FROM issues")).rows[0]
              .n,
            1,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM coordinator_events WHERE \"dedupeKey\" LIKE 'factory-monitor:%'",
              )
            ).rows[0].n,
            11,
          );
        },
      );
      await t.test(
        "owner, workspace, stale candidate, echo, cancellation and authorization fail closed",
        async () => {
          await rejects(
            () => monitor.consume("other", first.input),
            "factoryNotFound",
          );
          const secondIssue = await issue("owner", "workspace:b");
          const second = await toMonitor("owner", secondIssue);
          await rejects(
            () =>
              monitor.consume("owner", {
                ...second.input,
                binding: { ...second.input.binding, candidateId: randomUUID() },
              }),
            "factoryStale",
          );
          const result = await monitor.consume("owner", second.input);
          assert.notEqual(
            result.incidentId,
            (
              await pool.query(
                'SELECT id FROM factory_monitor_incidents WHERE "issueId"=$1',
                [issueId],
              )
            ).rows[0].id,
          );
          const foreign = await toMonitor("other", await issue("other"));
          const foreignResult = await monitor.consume("other", foreign.input);
          assert.notEqual(result.incidentId, foreignResult.incidentId);
          const echo = await toMonitor("owner", issueId);
          const echoId = await source(
            "owner",
            issueId,
            echo.runId,
            "run_blocked",
          );
          await rejects(
            () =>
              monitor.consume("owner", {
                ...echo.input,
                sourceEventId: echoId,
              }),
            "factoryMonitorSourceMismatch",
          );
          await store.apply("owner", binding(echo.task), randomUUID(), {
            action: "cancel",
            reason: "user cancel",
          });
          await rejects(
            () => monitor.consume("owner", echo.input),
            "factoryStopped",
          );
          denied.add(issueId);
          await rejects(
            () => monitor.consume("owner", first.input),
            "factoryNotFound",
          );
          denied.delete(issueId);
          const revoked = await toMonitor("owner", issueId);
          const stopped = await store.apply(
            "owner",
            binding(revoked.task),
            randomUUID(),
            { action: "revoke", reason: "Permission revoked" },
          );
          await rejects(
            () => monitor.consume("owner", revoked.input),
            "factoryStopped",
          );
          await rejects(
            () =>
              store.apply("owner", binding(stopped.task), randomUUID(), {
                action: "repair",
                reason: "must not repair after revocation",
              }),
            "factoryStopped",
          );
        },
      );
      await t.test(
        "crash before commit rolls back observation, issue count, stage and notice; reconnect replays committed result",
        async () => {
          const sample = await toMonitor("owner", issueId);
          const before = (
            await pool.query(
              "SELECT sum(occurrences)::int AS n FROM factory_monitor_incidents",
            )
          ).rows[0].n;
          failAppend = true;
          await assert.rejects(
            () => monitor.consume("owner", sample.input),
            /injected rollback/,
          );
          failAppend = false;
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM factory_monitor_observations WHERE "sourceEventId"=$1',
                [sample.input.sourceEventId],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (await store.read("owner", sample.task.id)).task.status,
            "running",
          );
          assert.equal(
            (
              await pool.query(
                "SELECT sum(occurrences)::int AS n FROM factory_monitor_incidents",
              )
            ).rows[0].n,
            before,
          );
          const committed = await monitor.consume("owner", sample.input);
          await pool.end();
          pool = new Pool({
            connectionString: fixtureURL,
            max: 16,
            options: `-c search_path=${schema}`,
          });
          store = createFactoryStore(pool, authorize, integrationGates);
          monitor = makeMonitor();
          assert.deepEqual(await monitor.consume("owner", sample.input), {
            ...committed,
            replayed: true,
          });
        },
      );
      await t.test(
        "same candidate recovery requires all independent and approved publication evidence",
        async () => {
          const good = await toMonitor("owner", issueId, null);
          await pool.query(
            "UPDATE factory_attempts SET status='blocked' WHERE \"taskId\"=$1 AND stage='verify'",
            [good.task.id],
          );
          assert.equal(
            (await monitor.consume("owner", good.input)).outcome,
            "blocked",
          );
          assert.equal(
            (await store.read("owner", good.task.id)).task.status,
            "blocked",
          );
          assert.ok(
            (
              await pool.query(
                "SELECT id FROM factory_monitor_incidents WHERE \"issueId\"=$1 AND status='open'",
                [issueId],
              )
            ).rows.length,
          );
          for (const tamper of [
            "sha",
            "session",
            "missing-verification-run",
          ] as const) {
            const invalid = await toMonitor("owner", issueId, null);
            if (tamper === "sha")
              await complete(invalid.runId, null, "2".repeat(40));
            if (tamper === "session")
              await pool.query(
                'UPDATE agent_runs SET "sessionId"=(SELECT "sessionId" FROM factory_attempts WHERE "taskId"=$2 AND stage=\'verify\') WHERE id=$1',
                [invalid.runId, invalid.task.id],
              );
            if (tamper === "missing-verification-run")
              await pool.query(
                'DELETE FROM agent_runs WHERE id=(SELECT "runId" FROM factory_attempts WHERE "taskId"=$1 AND stage=\'verify\')',
                [invalid.task.id],
              );
            assert.equal(
              (await monitor.consume("owner", invalid.input)).outcome,
              "blocked",
              tamper,
            );
          }
          const failedTask = (await store.read("owner", first.task.id)).task;
          const repair = await store.apply(
            "owner",
            binding(failedTask),
            randomUUID(),
            { action: "repair", reason: "Repair original monitor incident" },
          );
          assert.equal(repair.task.stage, "execute");
          assert.equal(repair.task.candidateId, null);
          assert.notEqual(repair.task.attemptId, failedTask.attemptId);
          assert.ok(
            repair.attempts.some(
              (a) => a.stage === "monitor" && a.status === "failed",
            ),
          );
          const recovered = await toMonitor("owner", issueId, null, repair);
          assert.equal(recovered.task.id, first.task.id);
          assert.equal(
            (await monitor.consume("owner", recovered.input)).outcome,
            "passed",
          );
          assert.equal(
            (await store.read("owner", recovered.task.id)).task.status,
            "passed",
          );
          const artifactReader = await pool.connect();
          try {
            const result = await store.read("owner", recovered.task.id);
            const refs = result.attempts.find(
              (a) => a.id === result.task.attemptId,
            )!.evidence;
            for (const ref of refs)
              await readFactoryArtifact(
                artifactReader,
                result.task,
                evidenceSchema.parse(ref),
              );
          } finally {
            artifactReader.release();
          }

          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM factory_monitor_incidents WHERE \"issueId\"=$1 AND status='open'",
                [issueId],
              )
            ).rows[0].n,
            0,
          );
          // #195 never closes or hides the actual issue.
          assert.equal(
            (
              await pool.query("SELECT status FROM issues WHERE id=$1", [
                issueId,
              ])
            ).rows[0].status,
            "todo",
          );
        },
      );
      await t.test(
        "passed monitor opens a clean fenced cycle and actual monitorGate rejects old evidence before a fresh failure/repair",
        async () => {
          const before = await store.read("owner", first.task.id);
          assert.equal(before.task.status, "passed");
          const previous = before.attempts.find(
            (a) => a.id === before.task.attemptId,
          )!;
          const eventId = randomUUID();
          const responses = await Promise.all(
            Array.from({ length: 10 }, () =>
              handleFactory(store, {
                userId: "owner",
                method: "POST",
                taskId: before.task.id,
                origin: "http://isolated.invalid",
                url: `http://isolated.invalid/api/factory/tasks/${before.task.id}`,
                body: {
                  binding: binding(before.task),
                  eventId,
                  action: "retry",
                  reason: "Next authorized monitor observation",
                },
              }),
            ),
          );
          assert.ok(responses.every((r) => r.status === 200));
          assert.equal(
            new Set(
              responses.map((r) => (r.body as FactorySnapshot).task.attemptId),
            ).size,
            1,
          );
          const cycle = await store.read("owner", first.task.id);
          assert.equal(cycle.task.stage, "monitor");
          assert.equal(cycle.task.status, "pending");
          assert.equal(cycle.task.candidateId, before.task.candidateId);
          assert.equal(cycle.task.revision, before.task.revision + 1);
          assert.notEqual(cycle.task.attemptId, before.task.attemptId);
          const fresh = cycle.attempts.find(
            (a) => a.id === cycle.task.attemptId,
          )!;
          assert.equal(fresh.runId, null);
          assert.equal(fresh.sessionId, null);
          assert.deepEqual(fresh.output, {});
          assert.deepEqual(fresh.evidence, []);
          assert.deepEqual(
            JSON.parse(
              JSON.stringify(cycle.attempts.find((a) => a.id === previous.id)),
            ),
            JSON.parse(JSON.stringify(previous)),
          );
          await rejects(
            () =>
              store.apply("owner", binding(cycle.task), randomUUID(), {
                action: "finish",
                status: "passed",
                reason: "Old evidence must not pass",
                evidence: previous.evidence.map((e) => evidenceSchema.parse(e)),
                output: previous.output,
              }),
            "factoryIndependentRunRequired",
          );
          await rejects(
            () =>
              store.apply("owner", binding(cycle.task), randomUUID(), {
                action: "bind_run",
                runId: previous.runId!,
              }),
            "factoryRunMismatch",
          );
          const live = await run("owner", issueId, 'acceptance');
          const bound = await store.apply(
            "owner",
            binding(cycle.task),
            randomUUID(),
            { action: "bind_run", runId: live },
          );
          await probeAndComplete(
            "owner",
            bound.task,
            live,
            "fresh controlled target fault",
          );
          const observed = await monitor.consume("owner", {
            binding: binding(bound.task),
            sourceEventId: await source("owner", issueId, live, "run_finished"),
          });
          assert.equal(observed.outcome, "failed");
          const failed = await store.read("owner", first.task.id);
          assert.equal(failed.task.status, "failed");
          const repaired = await store.apply(
            "owner",
            binding(failed.task),
            randomUUID(),
            {
              action: "repair",
              reason: "Repair after fresh monitor regression",
            },
          );
          assert.equal(repaired.task.stage, "execute");
          assert.equal(repaired.task.candidateId, null);
        },
      );
      await t.test(
        "Coordinator reconciliation consumes durable pending records without a new dispatch or wake",
        async () => {
          await toMonitor("owner", issueId, "new defect: database offline");
          const before = (
            await pool.query("SELECT count(*)::int AS n FROM agent_runs")
          ).rows[0].n;
          assert.ok((await monitor.reconcile("owner")).observed >= 1);
          assert.equal((await monitor.reconcile("owner")).observed, 0);
          assert.equal(
            (await pool.query("SELECT count(*)::int AS n FROM agent_runs"))
              .rows[0].n,
            before,
          );
        },
      );
      await t.test(
        "reuse across issues preserves the original mapping and existing issue deletion cascade",
        async () => {
          const originalIssue = await issue(
            "owner",
            "workspace:deletion-fixture",
          );
          const anotherIssue = await issue(
            "owner",
            "workspace:deletion-fixture",
          );
          const original = await toMonitor("owner", originalIssue);
          const another = await toMonitor("owner", anotherIssue);
          const a = await monitor.consume("owner", original.input);
          const b = await monitor.consume("owner", another.input);
          assert.equal(a.incidentId, b.incidentId);
          assert.equal(b.issueId, originalIssue);
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM issue_documents WHERE "issueId"=$1',
                [anotherIssue],
              )
            ).rows[0].n,
            0,
          );
          await pool.query("DELETE FROM issues WHERE id=$1", [originalIssue]);
          assert.equal(
            (
              await pool.query(
                'SELECT "incidentId" FROM factory_monitor_observations WHERE id=$1',
                [b.observationId],
              )
            ).rows[0].incidentId,
            null,
          );
          assert.equal(
            (await store.read("owner", another.task.id)).task.status,
            "failed",
          );
        },
      );
      await t.test(
        "actual 194 publication reader and target readback reject wrong target/environment/SHA/operation/reference",
        async () => {
          for (const fault of [
            "wrong-target",
            "wrong-environment",
            "wrong-sha",
            "wrong-operation",
          ]) {
            const sample = await toMonitor("owner", issueId, fault);
            const actual = await publicationFor("owner", sample.task);
            assert.equal(actual.verifiedTarget.kind, "local-artifact");
            assert.match(actual.candidate.environment, /^device:/);
            assert.equal(actual.targetEnvironment, targetEnvironment);
            const history = await store.read("owner", sample.task.id);
            const proof = history.attempts.find(
              (a) => a.id === sample.task.attemptId,
            )!.output.monitorProof as {
              audit: { observedReference: string; exitCode: number };
            };
            assert.notEqual(proof.audit.observedReference, actual.reference);
            assert.notEqual(proof.audit.exitCode, 0);
            assert.equal(
              (await monitor.consume("owner", sample.input)).outcome,
              "failed",
              fault,
            );
          }
        },
      );
      await t.test(
        "publication timing, uncertain status and actual approval revocation block recovery",
        async () => {
          for (const fault of ["time", "uncertain", "revoked"] as const) {
            const sample = await toMonitor("owner", issueId, null);
            const actual = await publicationFor("owner", sample.task);
            if (fault === "time")
              await pool.query(
                `UPDATE factory_attempts SET "finishedAt"=clock_timestamp()+interval '1 hour' WHERE "taskId"=$1 AND stage='publish'`,
                [sample.task.id],
              );
            if (fault === "uncertain")
              await pool.query(
                `UPDATE factory_publications SET status='uncertain' WHERE id=$1`,
                [actual.publicationId],
              );
            if (fault === "revoked") {
              const actor = {
                userId: "owner",
                sessionId: (await ensureOwner("owner")).sessionId,
              };
              await createFactoryApprovals(pool, authorize, store).revoke(
                actor,
                {
                  binding: binding(sample.task),
                  eventId: randomUUID(),
                  approvalId: actual.approvalId,
                },
              );
            }
            assert.equal(
              (await monitor.consume("owner", sample.input)).outcome,
              "blocked",
              fault,
            );
          }
        },
      );
      await t.test(
        "local artifact recovery cannot close an incident qualified as a cloud target",
        async () => {
          const sample = await toMonitor(
            "owner",
            issueId,
            "controlled artifact fault",
          );
          const failed = await monitor.consume("owner", sample.input);
          const cloudId = randomUUID();
          const cloud = monitorFingerprint({
            userId: "owner",
            workspaceKey: "workspace:a",
            repository,
            environment: targetEnvironment,
            target: JSON.stringify(["preview-deployment", publicationTarget]),
            component: "backend-health",
            check: "registered-target-readback-v1",
            failure: "content-mismatch",
          });
          await pool.query(
            `INSERT INTO factory_monitor_incidents (id,"userId","workspaceKey",fingerprint,"checkKey","issueId","taskId","candidateId",status,occurrences) SELECT $1,"userId","workspaceKey",$2,$3,"issueId","taskId","candidateId",'open',1 FROM factory_monitor_incidents WHERE id=$4`,
            [cloudId, cloud.fingerprint, cloud.checkKey, failed.incidentId],
          );
          const recovered = await toMonitor("owner", issueId, null);
          assert.equal(
            (await monitor.consume("owner", recovered.input)).outcome,
            "passed",
          );
          assert.equal(
            (
              await pool.query(
                "SELECT status FROM factory_monitor_incidents WHERE id=$1",
                [cloudId],
              )
            ).rows[0].status,
            "open",
          );
          assert.equal(
            (
              await pool.query(
                "SELECT status FROM factory_monitor_incidents WHERE id=$1",
                [failed.incidentId],
              )
            ).rows[0].status,
            "recovered",
          );
        },
      );
      await t.test(
        "same-run raw probe evidence is mandatory and cached probe replay stays immutable",
        async () => {
          const sample = await toMonitor("owner", issueId, null);
          const before = await store.read("owner", sample.task.id);
          const original = before.attempts.find(
            (a) => a.id === sample.task.attemptId,
          )!.output;
          await pool.query(
            `UPDATE agent_runs SET status='running',"finishedAt"=NULL WHERE id=$1`,
            [sample.runId],
          );
          const replay = await Promise.all(
            Array.from({ length: 10 }, () =>
              monitor.probeRun("owner", sample.runId),
            ),
          );
          assert.equal(new Set(replay.map((a) => a!.requestId)).size, 1);
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM run_chunks WHERE "runId"=$1 AND seq=0',
                [sample.runId],
              )
            ).rows[0].n,
            1,
          );
          await pool.query(
            `UPDATE agent_runs SET status='succeeded',"finishedAt"=clock_timestamp() WHERE id=$1`,
            [sample.runId],
          );
          await pool.query(
            `UPDATE run_chunks SET chunk=jsonb_set(chunk,'{stdout}','"tampered"') WHERE "runId"=$1 AND seq=0`,
            [sample.runId],
          );
          assert.equal(
            (await monitor.consume("owner", sample.input)).outcome,
            "blocked",
          );
          assert.deepEqual(
            (await store.read("owner", sample.task.id)).attempts.find(
              (a) => a.id === sample.task.attemptId,
            )!.output.monitorProof,
            original.monitorProof,
          );
        },
      );
      await t.test(
        "V2 production publisher/reader/normal dispatch/probe: actual HTTP fixture health and alias failure, replay and recovery",
        async () => {
          const productionIssue = await issue();
          const sample = await toMonitor(
            "owner",
            productionIssue,
            null,
            undefined,
            true,
          );
          const receipt = await publicationFor("owner", sample.task);
          assert.equal(receipt.version, 2);
          assert.equal(receipt.action, "deploy_production");
          assert.equal(receipt.verifiedTarget.kind, "production-deployment");
          assert.ok(receipt.verifiedTarget.provider);
          const posts = cloud.posts();
          assert.equal(
            (await monitor.consume("owner", sample.input)).outcome,
            "passed",
          );
          const f = await ensureOwner("owner");
          const cycle = async (fault: string | null) => {
            const previous = await store.read("owner", sample.task.id);
            const next = await store.apply(
              "owner",
              binding(previous.task),
              randomUUID(),
              {
                action: "retry",
                reason: "Next V2 bound production observation",
              },
            );
            const dispatch = createFactoryDispatch(
              pool,
              store,
              (tx, owner, input) =>
                insertRunOnce(factoryDispatchDatabase(tx), owner, input, {
                  deviceId: f.deviceId,
                  baseBranch: "main",
                  prompt: "Explicit provider protocol fixture",
                }),
            );
            const bound = await dispatch("owner", {
              binding: binding(next.task),
              agentId: f.agentId,
              deviceRepoId: f.repoId,
            });
            const assignment = await createFactoryCheckClaim(pool, authorize)(
              "owner",
              f.deviceId,
              bound.runId,
              new Date(Date.now() + 60000).toISOString(),
            );
            assert.equal(assignment.policy.readOnly, true);
            await pool.query(
              'UPDATE agent_runs SET "sessionId"=$2 WHERE id=$1',
              [bound.runId, `session:${bound.runId}`],
            );
            const audit = await probeAndComplete(
              "owner",
              bound.task,
              bound.runId,
              fault,
            );
            assert.equal(audit.version, 2);
            assert.equal(
              audit.provider?.bindingHash,
              receipt.verifiedTarget.provider!.bindingHash,
            );
            const input = {
              binding: binding(bound.task),
              sourceEventId: await source(
                "owner",
                productionIssue,
                bound.runId,
                "run_finished",
              ),
            };
            return {
              input,
              audit,
              result: await monitor.consume("owner", input),
            };
          };
          for (const fault of ["cloud-health", "cloud-alias"]) {
            const failed = await cycle(fault);
            assert.equal(
              failed.result.outcome,
              fault === "cloud-health" ? "failed" : "blocked",
            );
            assert.equal(failed.result.issueId, productionIssue);
            for (let delivery = 0; delivery < 10; delivery++) {
              const replay = await monitor.consume("owner", failed.input);
              assert.equal(replay.incidentId, failed.result.incidentId);
              assert.equal(replay.replayed, true);
            }
            const recovered = await cycle(null);
            assert.equal(recovered.result.outcome, "passed");
            if (fault === "cloud-health")
              assert.equal(
                (
                  await pool.query(
                    "SELECT status FROM factory_monitor_incidents WHERE id=$1",
                    [failed.result.incidentId],
                  )
                ).rows[0].status,
                "recovered",
              );
          }
          assert.equal(
            cloud.posts(),
            posts,
            "probe and recovery must never create another deployment",
          );
        },
      );
      if (process.env.FACTORY_MONITOR_EVIDENCE_DIR) {
        await mkdir(process.env.FACTORY_MONITOR_EVIDENCE_DIR, {
          recursive: true,
        });
        await writeFile(
          join(
            process.env.FACTORY_MONITOR_EVIDENCE_DIR,
            "actual-local-probes.json",
          ),
          JSON.stringify(
            {
              sha,
              recordedAt: new Date().toISOString(),
              environment:
                "isolated Docker PG17 + actual Node child/file target",
              actualValidators: [193, 194, 195],
              fixtureIdentities: [
                "OAuth identity",
                "Harness/review conclusions",
              ],
              realHarnessAcceptance: false,
              actualProbes,
            },
            null,
            2,
          ),
        );
      }
      t.diagnostic(
        JSON.stringify({
          environment: "isolated local Docker postgres:17",
          schema,
          agentId,
          originalIssueId: issueId,
          taskId: first.task.id,
          runId: first.runId,
          sourceEventId: first.input.sourceEventId,
          candidateId: first.task.candidateId,
          actualValidators: [193, 194, 195],
          fixtureIdentities: ["OAuth identity", "Harness/review conclusions"],
          realHarnessAcceptance: false,
        }),
      );
    } finally {
      await cloud.close();
      await rm(targetRoot, { recursive: true, force: true });
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
