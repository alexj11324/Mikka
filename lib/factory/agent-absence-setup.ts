import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function factoryAgentSetupOnly(env: Record<string, string | undefined>) {
  const mode = env.FACTORY_AGENT_SETUP_ONLY;
  if (mode === undefined) return false;
  assert.equal(mode, "1", "Unknown Factory agent setup mode");
  assert.notEqual(
    env.FACTORY_PHYSICAL_ABSENCE_AUTHORIZED,
    "1",
    "Setup-only cannot enable physical absence execution",
  );
  return true;
}

interface ReservedIds {
  agentId: string;
  runId: string;
}
interface Prepared {
  agent: { id: string; userId: string };
  run: { id: string; userId: string; agentId: string; issueId: string };
  taskId: string;
  attemptId: string;
  fixtureRegistry?: { schema: string; registeredCount: number; rows: { table: string; pk: Record<string, unknown>; rowHash: string }[]; effectsComplete: boolean; approvalEligible: boolean; executedDeletion: boolean };
}
interface SetupOptions {
  schema: string;
  databaseUrl: string;
  ownerId: string;
  issueId: string;
  ids?: ReservedIds;
  prepare: (ids: Readonly<ReservedIds>) => Promise<Prepared>;
}

// This writes only an unapprovable setup receipt. There is deliberately no
// deletion callback, resume function, authorization token or approval document.
export async function pauseFactoryAgentSetup(options: SetupOptions) {
  assert.match(options.schema, /^factory_192_[a-f0-9]{32}$/);
  assert.ok(typeof options.ownerId === "string" && options.ownerId.length > 0);
  assert.match(options.issueId, uuid);
  const url = new URL(options.databaseUrl);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(["/mikka_e2e", "/factory193"].includes(url.pathname));
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  const ids = Object.freeze({
    ...(options.ids ?? { agentId: randomUUID(), runId: randomUUID() }),
  });
  assert.match(ids.agentId, uuid);
  assert.match(ids.runId, uuid);
  assert.notEqual(ids.agentId, ids.runId);
  const directory = await mkdtemp(join(tmpdir(), "factory-agent-setup-"));
  const reserved = {
    version: 1,
    mode: "setup-only",
    caseName: "deleted agent cascades its run and blocks reconciliation",
    schema: options.schema,
    database: {
      host: url.hostname,
      port: url.port || "5432",
      name: url.pathname.slice(1),
    },
    ownerId: options.ownerId,
    issueId: options.issueId,
    reservedIds: ids,
    executedDeletion: false,
    approvalEligible: false,
    effectsComplete: false,
  };
  // Persist identifiers before fixture creation; partial setup remains traceable.
  await writeFile(
    join(directory, "reserved.json"),
    JSON.stringify(reserved, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  const receiptPath = join(directory, "blocked-receipt.json");
  const blockers = [
    "Original migration user-trigger/rule side effects are not modeled.",
    "Per-operation NO ACTION dependency closure is not implemented.",
    "Candidate PKs are not a complete effects inventory; no approval or resume is provided.",
  ];
  try {
    const prepared = await options.prepare(ids);
    assert.deepEqual(
      prepared.agent,
      { id: ids.agentId, userId: options.ownerId },
      "agent readback does not match reserved owner/PK",
    );
    assert.deepEqual(
      prepared.run,
      {
        id: ids.runId,
        userId: options.ownerId,
        agentId: ids.agentId,
        issueId: options.issueId,
      },
      "run readback does not match reserved owner/links",
    );
    assert.match(prepared.taskId, uuid);
    assert.match(prepared.attemptId, uuid);
    if (prepared.fixtureRegistry) {
      const registry = prepared.fixtureRegistry;
      assert.equal(registry.schema, options.schema); assert.equal(registry.registeredCount, registry.rows.length);
      assert.equal(registry.effectsComplete, false); assert.equal(registry.approvalEligible, false); assert.equal(registry.executedDeletion, false);
      for (const [table, id] of [['agents', ids.agentId], ['agent_runs', ids.runId], ['factory_tasks', prepared.taskId], ['factory_attempts', prepared.attemptId]])
        assert.equal(registry.rows.filter(r => r.table === table && r.pk.id === id).length, 1, 'prepared PK absent from full fixture register');
    }
    const receipt = {
      ...reserved,
      status: "blocked" as const,
      setupComplete: true,
      blockers,
      candidateRows: [
        { table: "agents", pk: { id: ids.agentId }, role: "requested-root" },
        {
          table: "agent_runs",
          pk: { id: ids.runId },
          role: "known-cascade-candidate",
        },
      ],
      context: { taskId: prepared.taskId, attemptId: prepared.attemptId },
      candidateCount: 2,
      fixtureRegistry: prepared.fixtureRegistry,
    };
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    return { receiptPath, receipt };
  } catch {
    await writeFile(
      receiptPath,
      JSON.stringify(
        {
          ...reserved,
          status: "blocked",
          setupComplete: false,
          blockers,
          failure: "Fixture preparation or exact readback was not confirmed.",
        },
        null,
        2,
      ),
      { mode: 0o600, flag: "wx" },
    );
    throw new Error(
      `Factory setup-only incomplete; retained blocked receipt: ${receiptPath}`,
    );
  }
}
