import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { afterEach, expect, it } from "vitest";
import type { RunAssignment } from "@mikka/protocol";
import {
  createSubscriptionRequestBudget,
  type SubscriptionRequestBudget,
} from "../src/subscription-request-budget";
import { createNativeSubscriptionBroker } from "../src/subscription-native-broker";
import { cleanupTempDirs, tempDir } from "./helpers";
afterEach(cleanupTempDirs);
function fixture() {
  const policy: SubscriptionRequestBudget = {
    id: randomUUID(),
    ownerId: "owner",
    workspaceId: randomUUID(),
    consumerId: randomUUID(),
    deviceId: randomUUID(),
    route: "claude_code_cli",
    modelId: "synthetic-model",
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    maxRequests: 2,
    maxOutputTokens: 256,
  };
  const assignment = {
    deviceId: policy.deviceId,
    runId: randomUUID(),
    model: policy.modelId,
    harness: "claude_code",
    subscriptionBinding: {
      bindingId: randomUUID(),
      ownerId: policy.ownerId,
      workspaceId: policy.workspaceId,
      consumerId: policy.consumerId,
      route: policy.route,
    },
  } as RunAssignment;
  return {
    policy,
    assignment,
    payload: {
      path: "/v1/messages",
      headers: {},
      body: {
        model: policy.modelId,
        max_tokens: 8192,
        messages: [{ role: "user", content: "synthetic" }],
      },
    },
  };
}
it("caps before transport and persists reservations across restart and competing instances", () => {
  const { policy, assignment, payload } = fixture(),
    root = tempDir();
  const first = createSubscriptionRequestBudget(root, policy),
    second = createSubscriptionRequestBudget(root, policy);
  expect(first(assignment, payload).body).toMatchObject({ max_tokens: 256 });
  expect(payload.body.max_tokens).toBe(8192);
  expect(
    second({ ...assignment, runId: randomUUID() }, payload).body,
  ).toMatchObject({ max_tokens: 256 });
  expect(() =>
    createSubscriptionRequestBudget(root, policy)(assignment, payload),
  ).toThrow("budget_refused");
  expect(() =>
    createSubscriptionRequestBudget(root, { ...policy, modelId: "different" }),
  ).toThrow("budget_refused");
});
it("rejects scope changes, expiry and malformed limits without consuming legitimate allowance", () => {
  const { policy, assignment, payload } = fixture();
  let time = Date.now();
  const reserve = createSubscriptionRequestBudget(
    tempDir(),
    policy,
    () => time,
  );
  for (const patch of [
    { deviceId: randomUUID() },
    { model: "different" },
    {
      subscriptionBinding: {
        ...assignment.subscriptionBinding!,
        ownerId: "foreign",
      },
    },
  ])
    expect(() => reserve({ ...assignment, ...patch }, payload)).toThrow();
  for (const max_tokens of [-1, 0, 1.5, "256", null])
    expect(() =>
      reserve(assignment, {
        ...payload,
        body: { ...payload.body, max_tokens },
      }),
    ).toThrow();
  expect(
    reserve(assignment, {
      ...payload,
      body: { model: policy.modelId, max_tokens: 12 },
    }).body,
  ).toMatchObject({ max_tokens: 12 });
  time = Date.parse(policy.expiresAt);
  expect(() => reserve(assignment, payload)).toThrow();
});
it("bounds Codex Responses and refuses a different provider path", () => {
  const f = fixture();
  f.policy.route = "codex_cli";
  f.assignment.subscriptionBinding!.route = "codex_cli";
  const reserve = createSubscriptionRequestBudget(tempDir(), f.policy);
  expect(() => reserve(f.assignment, f.payload)).toThrow();
  expect(
    reserve(f.assignment, {
      path: "/responses",
      headers: {},
      body: { model: f.policy.modelId },
    }).body,
  ).toEqual({ model: f.policy.modelId, max_output_tokens: 256 });
});
it("actual socket transport forwards two capped requests and refuses third without upstream call", async () => {
  const { policy, assignment, payload } = fixture(),
    root = tempDir(),
    reserve = createSubscriptionRequestBudget(root, policy);
  let calls = 0;
  const broker = await createNativeSubscriptionBroker({
    root,
    revision: 1,
    check: async () => {},
    worker: {
      nativeRequest: async (_revision, p) => {
        const bounded = reserve(assignment, p);
        expect(bounded.body).toMatchObject({ max_tokens: 256 });
        calls++;
        return {
          contentType: "application/json",
          body: new Response("{}").body!,
        };
      },
    },
  });
  const post = () =>
    new Promise<number>((resolve, reject) => {
      const req = request(
        { socketPath: broker.socket, path: payload.path, method: "POST" },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(payload.body));
    });
  try {
    expect(await post()).toBe(200);
    expect(await post()).toBe(200);
    expect(await post()).toBe(503);
    expect(calls).toBe(2);
  } finally {
    await broker.close();
  }
});
it("CLI and programmatic startup refuse budget in ordinary local mode", async () => {
  const { runCli } = await import("../src/cli"),
    { Daemon } = await import("../src/main"),
    { MemoryServer } = await import("../src/server-link");
  const output: string[] = [];
  expect(
    await runCli(
      ["daemon", "--subscription-request-budget", "/nonexistent-budget"],
      { out: (s) => output.push(s), err: (s) => output.push(s) },
    ),
  ).toBe(2);
  expect(output.join(" ")).toContain("requires hosted");
  expect(
    () =>
      new Daemon({
        dataDir: tempDir(),
        flavor: "dev",
        link: new MemoryServer(randomUUID()).link(),
        subscriptionRequestBudget: fixture().policy,
      }),
  ).toThrow("requires_hosted_mode");
});
