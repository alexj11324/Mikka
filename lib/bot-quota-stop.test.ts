import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { SubscriptionRefusal } from "@mikka/protocol/subscription";
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const calls: string[] = [];
mock.module(new URL("./db/index.ts", import.meta.url).href, {
  namedExports: { pool: {} },
});
mock.module(new URL("./abuse/resolve.ts", import.meta.url).href, {
  namedExports: {
    resolveDefaultHostedModel: async () => {
      throw Error("must not use paid fallback");
    },
  },
});
mock.module(new URL("./model-admission/runtime.ts", import.meta.url).href, {
  namedExports: {
    assertSubscriptionModelTransport: async (scope: { ownerId: string; workspaceId: string }, model: string, route: string) => {
      assert.equal(scope.ownerId, "alice");
      assert.equal(scope.workspaceId, id(2));
      assert.equal(model, "chosen-model");
      assert.equal(route, "claude_cpa");
    },
  },
});

const scope = { ownerId: "alice", botId: id(1), workspaceId: id(2) };
function fixture(reason = "quota_exhausted") {
  const binding = (key: string) => ({
    id: key,
    ownerId: "alice",
    consumerId: id(1),
    workspaceId: id(2),
    connectionId: key === id(3) ? id(4) : id(6),
    connectionRevision: 1,
    modelId: "chosen-model",
    route: "claude_cpa",
  });
  const service = {
    repository: {
      binding: async (_owner: string, key: string) => binding(key),
      connection: async (_owner: string, key: string) => ({
        id: key,
        ownerId: "alice",
        workspaceId: id(2),
        epoch: 1,
        state: "connected",
      }),
    },
    model: async (use: { bindingId: string }) => {
      calls.push(use.bindingId);
      if (use.bindingId === id(3))
        throw new SubscriptionRefusal(reason as "quota_exhausted");
      return {
        specificationVersion: "v4",
        modelId: "chosen-model",
        doStream: async () => ({}),
      };
    },
  };
  return { service: () => service as never, workspace: async () => {} };
}
test("a frozen subscription that runs out stops the turn; it never switches account or model mid-turn", async () => {
  const {freezeHostedModelSelection,resolveFrozenHostedModel}=await import("./subscription-model-snapshot");
  const deps = fixture();
  const runtime = await freezeHostedModelSelection(
    scope,
    { harness: "ai_sdk", model: null },
    { type: "subscription", bindingId: id(3) },
    deps,
  );
  calls.length = 0;
  await assert.rejects(resolveFrozenHostedModel(scope, runtime, deps), {
    code: "quota_exhausted",
  });
  assert.deepEqual(calls, [id(3)]);
  const unavailable = fixture("account_unavailable");
  calls.length = 0;
  await assert.rejects(resolveFrozenHostedModel(scope, runtime, unavailable), {
    code: "account_unavailable",
  });
  assert.deepEqual(calls, [id(3)]);
});
