import assert from "node:assert/strict";
import { before, mock, test } from "node:test";
import { randomUUID } from "node:crypto";
import { asSchema } from "ai";
import { makeSnapshot } from "../agent-kit/definition";
import { DEFAULT_AGENT_DEFINITION } from "../agent-kit/builtin";
import type { AgentExecution } from "../agent-kit/store";
/** The person's Coordinator: an ordinary bot row, marked as the Coordinator. */
const COORDINATOR_BOT = '00000000-0000-4000-8000-0000000c0de1'

const calls: unknown[][] = [];
mock.module("@/workflows/coordinator/steps", {
  namedExports: {
    recoverFactoryCheck: async (...args: unknown[]) => {
      calls.push(args);
      return { status: "synthetic-only" };
    },
  },
});
mock.module("@/workflows/coordinator/agent-kit-steps", {
  namedExports: {
    beforeAgentTool: async () => {},
    afterAgentTool: async () => {},
  },
});
mock.module("@/lib/composio-actions", {
  namedExports: {
    createComposioAITools: () => ({}),
    createGoogleAITools: () => ({}),
  },
});
let registry: typeof import("@/workflows/coordinator/tools");
before(async () => {
  registry = await import("@/workflows/coordinator/tools");
});

test("actual recovery tool accepts only binding and carries the actual SDK context identity", async () => {
  const keys = [
    "MIKKA_ISSUE_TOOLS_ENABLED",
    "MIKKA_FACTORY_ROUTING_ENABLED",
    "MIKKA_FACTORY_LIFECYCLE_ENABLED",
  ] as const;
  const old = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) process.env[key] = "1";
    const execution: AgentExecution = {
      id: randomUUID(),
      status: "running",
      snapshot: makeSnapshot(
        randomUUID(),
        1,
        { ...DEFAULT_AGENT_DEFINITION, tools: ["recover_factory_check"] },
        "Frozen host",
        { harness: "ai_sdk", model: "synthetic-vision-model" },
      ),
    };
    const input = {
      binding: {
        taskId: randomUUID(),
        issueId: randomUUID(),
        attemptId: randomUUID(),
        revision: 4,
        candidateId: randomUUID(),
      },
    };
    const scope = { holder: "host", turnId: "turn", callId: "native-call" },
      context = { toolCallId: "sdk-owned-call", messages: [], context: {} };
    const tools = registry.coordinatorTools("owner", "bot", scope, {
      execution,
    });
    assert.deepEqual(Object.keys(tools), ["recover_factory_check"]);
    assert.equal(
      (
        await asSchema(tools.recover_factory_check.inputSchema).validate!({
          ...input,
          vision: "verified",
          permissions: "allow",
        })
      ).success,
      false,
    );
    await tools.recover_factory_check.execute!(input, context);
    assert.deepEqual(calls.at(-1), [
      "owner",
      input,
      "sdk-owned-call",
      scope,
      "bot",
    ]);
  } finally {
    keys.forEach((key, i) => {
      if (old[i] === undefined) delete process.env[key];
      else process.env[key] = old[i];
    });
  }
});

test("registration does not widen a frozen grant or enable default-off recovery", () => {
  const keys = [
    "MIKKA_ISSUE_TOOLS_ENABLED",
    "MIKKA_FACTORY_ROUTING_ENABLED",
    "MIKKA_FACTORY_LIFECYCLE_ENABLED",
  ] as const;
  const old = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) process.env[key] = "1";
    const execution: AgentExecution = {
      id: randomUUID(),
      status: "running",
      snapshot: makeSnapshot(
        randomUUID(),
        1,
        { ...DEFAULT_AGENT_DEFINITION, tools: ["get_issue"] },
        "Frozen host",
        { harness: "ai_sdk", model: "synthetic" },
      ),
    };
    assert.deepEqual(
      Object.keys(
        registry.coordinatorTools("owner", COORDINATOR_BOT, undefined, { coordinator: true,  execution }),
      ),
      ["get_issue"],
    );
    process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = "0";
    assert.equal(
      registry.createCoordinatorRegistry("owner", COORDINATOR_BOT, undefined, { coordinator: true }).recover_factory_check,
      undefined,
    );
  } finally {
    keys.forEach((key, i) => {
      if (old[i] === undefined) delete process.env[key];
      else process.env[key] = old[i];
    });
  }
});
