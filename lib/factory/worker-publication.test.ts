import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mock, test } from "node:test";
import type { FactoryApprovalStore } from "./approval-dependencies";
import type { FactoryDecisionScope } from "./policy-authorization";

// Authentication transport substitute only. The backend run authority's real
// token/run/lease SQL is tested separately with disposable PostgreSQL.
const owner = "synthetic-transport-owner",
  runId = randomUUID(),
  issueId = randomUUID(),
  botId = randomUUID();
const token = "mkw_synthetic_unissued_token";
let verifiedCalls = 0;
mock.module("@/lib/mcp/worker", {
  namedExports: {
    verifyRunToken: async (_request: Request, bearer: string) => {
      verifiedCalls++;
      return bearer === token
        ? { token, extra: { userId: owner, runId, issueId, botId } }
        : undefined;
    },
    workerRun: (auth: {
      extra: { userId: string; runId: string; issueId: string; botId: string };
    }) => ({
      id: auth.extra.runId,
      userId: auth.extra.userId,
      issueId: auth.extra.issueId,
      botId: auth.extra.botId,
    }),
  },
});
type FactoryBuilder =
  typeof import("./worker-publication").factoryPublicationForWorker;
const publicationModule = import("./worker-publication");
let storeCreations = 0;
const task = {
  id: randomUUID(),
  userId: owner,
  issueId,
  attemptId: randomUUID(),
  candidateId: randomUUID(),
  revision: 8,
  stage: "approval",
  status: "pending",
};
const store: FactoryApprovalStore = {
  lockTask: async (_tx, userId, taskId) => {
    assert.equal(userId, owner);
    assert.equal(taskId, task.id);
    return task;
  },
  apply: async () => {
    throw Error("not invoked");
  },
};
const deps = {
  pool: {} as Parameters<FactoryBuilder>[1]["pool"],
  authorize: async () => true,
  createStore: (
    _gates: unknown,
    identity: { id: string; userId: string; botId: string | null },
  ) => {
    storeCreations++;
    assert.equal(identity.id, runId);
    assert.equal(identity.userId, owner);
    assert.equal(identity.botId, botId);
    return store;
  },
  host: { reviewKey: () => undefined, policy: async () => null },
};
test("worker backend rejects absent/invalid existing run-token authentication before constructing a publication service", async () => {
  const { factoryPublicationForWorker } = await publicationModule;
  for (const headers of [
    new Headers(),
    new Headers({ authorization: "Bearer synthetic-bad-token" }),
  ])
    await assert.rejects(
      () =>
        factoryPublicationForWorker(
          new Request("https://fixture.invalid", { headers }),
          deps,
        ),
      /factoryPolicyPrincipalUnavailable/,
    );
  assert.equal(storeCreations, 0);
});
test("authenticated transport alone selects owner/run/Bot; model JSON cannot select actor, run or policy", async () => {
  const { factoryPublicationForWorker } = await publicationModule;
  const runtime = await factoryPublicationForWorker(
    new Request("https://fixture.invalid", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        ownerId: "forged",
        runId: randomUUID(),
        policy: { decision: "allow" },
      }),
    }),
    deps,
  );
  assert.equal(runtime.actor.userId, owner);
  assert.equal(storeCreations, 1);
  assert.equal(verifiedCalls, 2);
  const scope: FactoryDecisionScope = {
    ownerId: owner,
    binding: {
      taskId: task.id,
      issueId,
      attemptId: task.attemptId,
      candidateId: task.candidateId,
      revision: 8,
    },
    candidate: {
      sha: "a".repeat(40),
      repository: "fixture/Factory194",
      environment: "synthetic",
      scope: "fixture",
    },
    action: "deploy_preview",
    target: "synthetic-local",
    targetEnvironment: "local-fixture",
    evidenceDigest: "b".repeat(64),
    visualEvidenceDigests: [],
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  let captured: unknown[] = [];
  const tx = {
    query: async (_sql: string, values: unknown[]) => {
      captured = values;
      return { rows: [] };
    },
  } as unknown as Parameters<typeof runtime.authority.verify>[0];
  await assert.rejects(
    () => runtime.authority.verify(tx, randomUUID(), scope),
    /factoryPolicyDecisionRevoked/,
  );
  assert.equal(captured[0], runId);
  assert.equal(captured[1], owner);
  assert.equal(captured[3], createHash("sha256").update(token).digest("hex"));
});
test("an earlier authenticated worker cannot read Factory evidence/ledger after current token/STOP/lease guard rejects", async () => {
  const { factoryPublicationForWorker } = await publicationModule;
  let live = true,
    ledgerReads = 0;
  const tx = {
    query: async (sql: string) => {
      if (sql.startsWith("SELECT r.*"))
        return { rows: live ? [{ id: runId }] : [] };
      if (
        sql.includes("FROM factory_approvals") ||
        sql.includes("FROM factory_publications")
      )
        ledgerReads++;
      return { rows: [] };
    },
    release: () => {},
  };
  const runtime = await factoryPublicationForWorker(
    new Request("https://fixture.invalid", {
      headers: { authorization: `Bearer ${token}` },
    }),
    {
      ...deps,
      pool: {
        connect: async () => tx,
      } as unknown as Parameters<FactoryBuilder>[1]["pool"],
    },
  );
  assert.deepEqual(
    (await runtime.approvals.ledger(runtime.actor, task.id)).approvals,
    [],
  );
  const before = ledgerReads;
  live = false;
  await assert.rejects(
    () => runtime.approvals.ledger(runtime.actor, task.id),
    /factoryPolicyDecisionRevoked/,
  );
  assert.equal(ledgerReads, before);
});
