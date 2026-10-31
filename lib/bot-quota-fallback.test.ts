import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { SubscriptionRefusal } from "@mikka/protocol/subscription";
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let policy = "stop",
  candidates: Record<string, string>[] = [];
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
mock.module(new URL("./execution-settings.ts", import.meta.url).href, {
  namedExports: {
    ExecutionSettings: class {
      async fallbacks() {
        return { whenQuotaExhausted: policy };
      }
      async botModels() {
        return candidates;
      }
      async bindingForBot(_scope: unknown, _bot: unknown, binding: string) {
        return binding;
      }
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
test("quota stop refuses; explicit switch selects only another account with the same model and route", async () => {
  const {freezeHostedModelSelection,resolveFrozenHostedModel}=await import("./subscription-model-snapshot");
  const deps = fixture();
  const runtime = await freezeHostedModelSelection(
    scope,
    { harness: "ai_sdk", model: null },
    { type: "subscription", bindingId: id(3) },
    deps,
  );
  policy = "stop";
  calls.length = 0;
  await assert.rejects(resolveFrozenHostedModel(scope, runtime, deps), {
    code: "quota_exhausted",
  });
  assert.deepEqual(calls, [id(3)]);
  policy = "switchAccount";
  candidates = [
    {
      bindingId: id(7),
      connectionId: id(8),
      modelId: "different-model",
      route: "claude_cpa",
    },
    {
      bindingId: id(5),
      connectionId: id(6),
      modelId: "chosen-model",
      route: "claude_cpa",
    },
  ];
  calls.length = 0;
  assert.equal(
    (
      (await resolveFrozenHostedModel(scope, runtime, deps)) as {
        modelId: string;
      }
    ).modelId,
    "chosen-model",
  );
  assert.deepEqual(calls, [id(3), id(5)]);
  candidates = [];
  await assert.rejects(resolveFrozenHostedModel(scope, runtime, deps), {
    code: "quota_exhausted",
  });
  const unavailable = fixture("account_unavailable");
  calls.length = 0;
  await assert.rejects(resolveFrozenHostedModel(scope, runtime, unavailable), {
    code: "account_unavailable",
  });
  assert.deepEqual(calls, [id(3)]);
});
