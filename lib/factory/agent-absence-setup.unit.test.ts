import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  factoryAgentSetupOnly,
  pauseFactoryAgentSetup,
} from "./agent-absence-setup";

const options = () => ({
  schema: `factory_192_${randomUUID().replaceAll("-", "")}`,
  databaseUrl: "postgres://fixture:private-value@127.0.0.1:5432/mikka_e2e",
  ownerId: "synthetic-owner",
  issueId: randomUUID(),
});
const prepared = (
  o: ReturnType<typeof options>,
  ids: { agentId: string; runId: string },
) => {
  const taskId = randomUUID(), attemptId = randomUUID();
  return {
  agent: { id: ids.agentId, userId: o.ownerId },
  run: {
    id: ids.runId,
    userId: o.ownerId,
    agentId: ids.agentId,
    issueId: o.issueId,
  },
  taskId,
  attemptId,
  fixtureRegistry: {
    schema: o.schema, registeredCount: 4, effectsComplete: false, approvalEligible: false, executedDeletion: false,
    rows: [["agents", ids.agentId], ["agent_runs", ids.runId], ["factory_tasks", taskId], ["factory_attempts", attemptId]].map(([table, id]) => ({ table, pk: { id }, rowHash: "a".repeat(64) })),
  },
};
};

test("setup mode rejects mixed physical execution and never treats legacy authorization as setup", () => {
  assert.equal(factoryAgentSetupOnly({}), false);
  assert.equal(
    factoryAgentSetupOnly({ FACTORY_PHYSICAL_ABSENCE_AUTHORIZED: "1" }),
    false,
  );
  assert.equal(factoryAgentSetupOnly({ FACTORY_AGENT_SETUP_ONLY: "1" }), true);
  assert.throws(() => factoryAgentSetupOnly({ FACTORY_AGENT_SETUP_ONLY: "0" }));
  assert.throws(() =>
    factoryAgentSetupOnly({
      FACTORY_AGENT_SETUP_ONLY: "1",
      FACTORY_PHYSICAL_ABSENCE_AUTHORIZED: "1",
    }),
  );
});
test("reserved IDs produce private retained blocked candidates without credential or approval material", async () => {
  const o = options(),
    ids = { agentId: randomUUID(), runId: randomUUID() };
  let calls = 0;
  const result = await pauseFactoryAgentSetup({
    ...o,
    ids,
    prepare: async (actual) => {
      calls++;
      assert.deepEqual(actual, ids);
      assert.ok(Object.isFrozen(actual));
      return prepared(o, actual);
    },
  });
  assert.equal(calls, 1);
  const receipt = JSON.parse(await readFile(result.receiptPath, "utf8"));
  const reserved = JSON.parse(
    await readFile(join(dirname(result.receiptPath), "reserved.json"), "utf8"),
  );
  assert.deepEqual(reserved.reservedIds, ids);
  assert.equal(receipt.status, "blocked");
  assert.equal(receipt.setupComplete, true);
  assert.equal(receipt.approvalEligible, false);
  assert.equal(receipt.effectsComplete, false);
  assert.equal(receipt.executedDeletion, false);
  assert.deepEqual(
    receipt.candidateRows.map((r: { pk: { id: string } }) => r.pk.id),
    [ids.agentId, ids.runId],
  );
  assert.equal(receipt.candidateCount, 2);
  assert.match(receipt.blockers.join(" "), /NO ACTION/);
  assert.ok(!JSON.stringify(receipt).includes("private-value"));
  assert.equal((await stat(result.receiptPath)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(result.receiptPath))).mode & 0o777, 0o700);
});
test("partial preparation retains reserved IDs and an incomplete receipt", async () => {
  const o = options(),
    ids = { agentId: randomUUID(), runId: randomUUID() };
  // Read the path from the thrown error without exposing the original DB error.
  try {
    await pauseFactoryAgentSetup({
      ...o,
      ids,
      prepare: async () => {
        throw new Error("private DB error");
      },
    });
    assert.fail("expected rejection");
  } catch (error) {
    const message = (error as Error).message;
    assert.ok(!message.includes("private DB error"));
    const path = message.split("retained blocked receipt: ")[1];
    assert.ok(path);
    const receipt = JSON.parse(await readFile(path, "utf8"));
    assert.equal(receipt.setupComplete, false);
    assert.equal(receipt.status, "blocked");
    assert.equal(receipt.approvalEligible, false);
    assert.deepEqual(receipt.reservedIds, ids);
  }
});
test("foreign owner and linked run readbacks fail closed", async () => {
  for (const field of ["owner", "agent", "issue", "run", "missing-register", "missing-pk"]) {
    const o = options();
    await assert.rejects(
      () =>
        pauseFactoryAgentSetup({
          ...o,
          prepare: async (ids) => {
            const row = prepared(o, ids);
            if (field === "owner") row.agent.userId = "foreign";
            if (field === "agent") row.run.agentId = randomUUID();
            if (field === "issue") row.run.issueId = randomUUID();
            if (field === "run") row.run.id = randomUUID();
            if (field === "missing-register") Reflect.deleteProperty(row, "fixtureRegistry");
            if (field === "missing-pk") { row.fixtureRegistry.rows.pop(); row.fixtureRegistry.registeredCount--; }
            return row;
          },
        }),
      /setup-only incomplete/,
    );
  }
});
test("invalid scope and reserved identifiers reject before preparing fixtures", async () => {
  const o = options();
  let calls = 0;
  for (const change of [
    { schema: "public" },
    { databaseUrl: "postgres://127.0.0.1/production" },
    { databaseUrl: "postgres://remote/mikka_e2e" },
    { ids: { agentId: "bad", runId: randomUUID() } },
    { ids: { agentId: o.issueId, runId: o.issueId } },
  ]) {
    await assert.rejects(() =>
      pauseFactoryAgentSetup({
        ...o,
        ...change,
        prepare: async (ids) => {
          calls++;
          return prepared(o, ids);
        },
      }),
    );
  }
  assert.equal(calls, 0);
});
