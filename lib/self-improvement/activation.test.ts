import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { PoolClient } from "pg";
import { BASELINE_ARTIFACT } from "./builtin-skill";
import { digest } from "./contract";
import { syntheticModelResult } from "./testing/evaluation-result-fixture";
import { SKILL_PATH } from "./regression";
import { canonicalSkill } from "./registry";
import {
  monitorProbePassed,
  monitorProbeFailed,
  type MonitorAudit,
} from "../factory/monitor-probe";
import {
  createSkillActivationAdapters,
  probeSkillActivation,
  readSkillApprovalEvidence,
  withdrawSkillApproval,
} from "./activation";
import { assertPublicationTarget } from "../factory/publication-receipt";
import {
  publicationBindingHash,
  type PublicationInput,
} from "../factory/publication-operation";

function fixture(environment = "preview") {
  const userId = "synthetic-owner",
    taskId = randomUUID(),
    candidateId = randomUUID(),
    issueId = randomUUID(),
    agentId = randomUUID(),
    repoId = randomUUID(),
    proposalId = randomUUID(),
    evaluationId = randomUUID();
  const markdown =
    "---\nname: Run report\n---\n\nCandidate report instructions.\n";
  const artifact = {
    ...BASELINE_ARTIFACT,
    versionId: candidateId,
    sha256: createHash("sha256").update(markdown).digest("hex"),
  };
  const metadata = {
    versionId: candidateId,
    userId,
    issueId,
    agentId,
    repoId,
    proposalId,
    factoryTaskId: taskId,
    candidateId,
    repository: "fixture/Mikka",
    commitSha: "a".repeat(40),
    path: SKILL_PATH,
    baselineVersionId: BASELINE_ARTIFACT.versionId,
    createdAt: new Date(),
  };
  const scope = {
    sourceCommit: "c".repeat(40),
    factoryTaskId: taskId,
    candidateId,
    issueId,
    agentId,
    repoId,
  };
  const result = syntheticModelResult({evaluationId,instanceId:randomUUID(),proposalId,candidateVersionId:candidateId,
    scope,instanceDigest:"5".repeat(64),baselineSha256:BASELINE_ARTIFACT.sha256,candidateSha256:artifact.sha256,evidenceDigest:"6".repeat(64)});
  const evaluation = {
    id: evaluationId,
    scope,
    result,
    digest: digest(result),
  };
  const task = {
    id: taskId,
    userId,
    issueId,
    candidateId,
    attemptId: randomUUID(),
    revision: 8,
    stage: "publish",
    status: "pending",
  };
  let lifecycle: Array<Record<string, unknown>> = [],
    before = 0,
    registered = true,
    passing = true,
    run: Record<string, unknown> | undefined;
  const input: PublicationInput = {
    idempotencyKey: randomUUID(),
    candidate: {
      repository: metadata.repository,
      sha: metadata.commitSha,
      environment: "device:fixture",
      scope: "Skill",
    },
    authorization: {
      approvalId: randomUUID(),
      ownerId: userId,
      humanSessionId: "human",
      expiresAt: "2026-10-28T00:00:00.000Z",
      binding: {
        taskId,
        issueId,
        candidateId,
        attemptId: task.attemptId,
        revision: task.revision,
      },
      eventId: randomUUID(),
      action: "activate_skill",
      target: "mikka-builtin:run-report",
      targetEnvironment: environment,
    },
    beforeCreate: async () => {
      before++;
    },
  };
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("INSERT INTO improvement_skill_lifecycle")) {
        const operation = sql.includes("'withdraw'") ? "withdraw" : "activate";
        if (
          !lifecycle.some(
            (row) =>
              row.publicationId === values[5] && row.operation === operation,
          )
        )
          lifecycle.push({
            id: values[0],
            userId: values[1],
            issueId: values[2],
            repoId: values[3],
            versionId: values[4],
            operation,
            publicationId: values[5],
            approvalId: values[6],
          });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("improvement_skill_lifecycle")) {
        if (sql.includes("operation='withdraw'"))
          return {
            rows: lifecycle.filter((row) => row.operation === "withdraw"),
          };
        if (sql.includes("JOIN factory_publications"))
          return {
            rows: lifecycle.filter(
              (row) =>
                row.operation === "activate" && row.approvalId === values[0],
            ),
          };
        if (sql.includes("ORDER BY")) return { rows: lifecycle.slice(-1) };
        return {
          rows: lifecycle.filter(
            (row) =>
              row.operation === "activate" && row.publicationId === values[0],
          ),
        };
      }
      if (sql.includes("FROM factory_tasks")) return { rows: [task] };
      if (sql.includes("FROM improvement_skill_versions"))
        return { rows: [{ artifact, markdown }] };
      if (sql.includes("FROM improvement_skill_candidates"))
        return { rows: [metadata] };
      if (sql.includes("FROM improvement_skill_evaluations"))
        return { rows: [evaluation] };
      if (sql.includes("FROM agent_runs")) return { rows: run ? [run] : [] };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const adapter = createSkillActivationAdapters({
    readRegisteredCandidate: async () => {
      if (!registered) throw Error("source revoked");
      return {
        artifact,
        markdown,
        metadata,
        skill: canonicalSkill(markdown),
      };
    },
    passingEvaluation: async () => {
      if (!passing) throw Error("not passing");
      return { evaluationId, digest: evaluation.digest, result };
    },
  }).find((a) => a.environment === environment)!;
  return {
    input,
    tx,
    adapter,
    task,
    metadata,
    artifact,
    evaluation,
    get before() {
      return before;
    },
    get lifecycle() {
      return lifecycle;
    },
    set registered(v: boolean) {
      registered = v;
    },
    set passing(v: boolean) {
      passing = v;
    },
    set run(value: Record<string, unknown> | undefined) {
      run = value;
    },
  };
}

for (const environment of ["preview", "production"])
  test(`activation uses held transaction and reads back exact raw digest in ${environment}`, async () => {
    const f = fixture(environment);
    const receipt = await f.adapter.execute(f.input, f.tx);
    assert.equal(f.before, 1);
    assert.equal(f.lifecycle.length, 1);
    assertPublicationTarget(
      receipt,
      f.input.candidate,
      "activate_skill",
      "mikka-builtin:run-report",
      environment,
      f.input.idempotencyKey,
      publicationBindingHash(f.input),
    );
    assert.equal(receipt.verifiedTarget.skill?.sha256, f.artifact.sha256);
    const replay = await f.adapter.reconcile!(f.input, null, f.tx);
    assert.equal(replay.reference, receipt.reference);
    assert.equal(f.lifecycle.length, 1);
    await withdrawSkillApproval(
      f.tx,
      f.task as never,
      f.input.authorization!.approvalId,
    );
    await withdrawSkillApproval(
      f.tx,
      f.task as never,
      f.input.authorization!.approvalId,
    );
    assert.equal(f.lifecycle.length, 2);
    await assert.rejects(
      f.adapter.execute(f.input, f.tx),
      /factorySkillActivation/,
    );
  });

test("activation fails before effect for absent transaction, stale binding, revoked source, failing comparison and missing final human fence", async () => {
  const f = fixture();
  await assert.rejects(f.adapter.execute(f.input), /factorySkillActivation/);
  f.input.authorization!.binding.revision++;
  await assert.rejects(
    f.adapter.execute(f.input, f.tx),
    /factorySkillActivation/,
  );
  f.input.authorization!.binding.revision--;
  f.registered = false;
  await assert.rejects(f.adapter.execute(f.input, f.tx), /source revoked/);
  f.registered = true;
  f.passing = false;
  await assert.rejects(f.adapter.execute(f.input, f.tx), /not passing/);
  f.passing = true;
  f.input.beforeCreate = undefined;
  await assert.rejects(
    f.adapter.execute(f.input, f.tx),
    /factorySkillActivation/,
  );
  assert.equal(f.lifecycle.length, 0);
});

test("approval evidence binds canonical bytes and immutable model assessment", async () => {
  const f = fixture();
  const manifest = await readSkillApprovalEvidence(f.tx, f.task as never);
  assert.equal(manifest?.markdown.includes("Candidate report"), true);
  assert.equal(manifest?.evaluation.digest, f.evaluation.digest);
  f.evaluation.result.passed = false;
  await assert.rejects(
    readSkillApprovalEvidence(f.tx, f.task as never),
    /factorySkillActivation/,
  );
});

test("monitor requires same-version post-publication host mount and sees failure and withdrawal", async () => {
  const f = fixture(),
    runId = randomUUID(),
    receipt = await f.adapter.execute(f.input, f.tx);
  const publication = {
    version: 2 as const,
    publicationId: f.input.idempotencyKey,
    approvalId: f.input.authorization!.approvalId,
    taskId: f.task.id,
    issueId: f.task.issueId,
    candidateId: f.task.candidateId,
    candidate: f.input.candidate,
    action: "activate_skill" as const,
    target: "mikka-builtin:run-report",
    targetEnvironment: "preview",
    publishedAt: new Date(Date.now() - 1000).toISOString(),
    ...receipt,
  };
  assert.equal(
    (await probeSkillActivation(f.tx, publication, runId, f.task.userId))
      .errorCode,
    "skill-mount-unverified",
  );
  const receiptId = randomUUID(),
    sessionId = "actual-session";
  const run = {
    issueId: f.task.issueId,
    purpose: "active",
    versionId: f.artifact.versionId,
    sha256: f.artifact.sha256,
    sessionId,
    mountSessionId: sessionId,
    receiptId,
    receipt: { id: receiptId, artifact: f.artifact },
    startedAt: new Date(),
    mountedAt: new Date(),
    status: "running",
  };
  f.run = run;
  assert.equal(
    (
      await probeSkillActivation(f.tx, publication, runId, f.task.userId, {
        verify: { status: "passed" },
      })
    ).errorCode,
    null,
  );
  assert.equal(
    (
      await probeSkillActivation(f.tx, publication, runId, f.task.userId, {
        verify: { status: "failed" },
      })
    ).errorCode,
    "skill-run-failed",
  );
  f.run = { ...run, sha256: "f".repeat(64) };
  assert.equal(
    (await probeSkillActivation(f.tx, publication, runId, f.task.userId))
      .errorCode,
    "skill-mount-unverified",
  );
  f.run = run;
  await withdrawSkillApproval(
    f.tx,
    f.task as never,
    f.input.authorization!.approvalId,
  );
  assert.equal(
    (await probeSkillActivation(f.tx, publication, runId, f.task.userId))
      .errorCode,
    "skill-withdrawn",
  );
});

test("Skill monitor outcome checks require exact proof and distinguish real failure from unknown mount", async () => {
  const f = fixture(),
    runId = randomUUID(),
    receipt = await f.adapter.execute(f.input, f.tx);
  const publication = {
    version: 2 as const,
    publicationId: f.input.idempotencyKey,
    approvalId: f.input.authorization!.approvalId,
    taskId: f.task.id,
    issueId: f.task.issueId,
    candidateId: f.task.candidateId,
    candidate: f.input.candidate,
    action: "activate_skill" as const,
    target: "mikka-builtin:run-report",
    targetEnvironment: "preview",
    publishedAt: new Date(Date.now() - 1000).toISOString(),
    ...receipt,
  };
  const receiptId = randomUUID(),
    sessionId = "actual-session";
  f.run = {
    issueId: f.task.issueId,
    purpose: "active",
    versionId: f.artifact.versionId,
    sha256: f.artifact.sha256,
    sessionId,
    mountSessionId: sessionId,
    receiptId,
    receipt: { id: receiptId, artifact: f.artifact },
    startedAt: new Date(),
    mountedAt: new Date(),
    status: "running",
  };
  const observed = await probeSkillActivation(
    f.tx,
    publication,
    runId,
    f.task.userId,
    { verify: { status: "passed" } },
  );
  const audit = { ...observed, runId } as unknown as MonitorAudit;
  assert.equal(monitorProbePassed(audit, publication), true);
  assert.equal(
    monitorProbePassed(
      { ...audit, skill: { ...audit.skill!, sha256: "f".repeat(64) } },
      publication,
    ),
    false,
  );
  assert.equal(
    monitorProbeFailed(
      { ...audit, errorCode: "skill-run-failed", exitCode: 1 },
      publication,
    ),
    true,
  );
  assert.equal(
    monitorProbeFailed(
      {
        ...audit,
        errorCode: "skill-mount-unverified",
        exitCode: 1,
        skill: { ...audit.skill!, mountReceiptId: null },
      },
      publication,
    ),
    false,
  );
});

test("historical CPU pass cannot stand in for a model assessment or rewrite the result ledger", async () => {
  const f=fixture();
  const legacy={passed:true,evaluationId:f.evaluation.id,proposalId:f.metadata.proposalId,candidateVersionId:f.metadata.versionId,scope:f.evaluation.scope};
  f.evaluation.result=legacy as never;f.evaluation.digest=digest(legacy);
  await assert.rejects(readSkillApprovalEvidence(f.tx,f.task as never),/factorySkillActivationEvidenceRequired/);
  assert.equal(f.lifecycle.length,0);
});
