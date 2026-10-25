import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  admitModel,
  documentSchema,
  endpointSchema,
  resolvePolicy,
  type PolicyDocument,
} from "./contract";
import { policySigner } from "./signing";
import { AGENT_ROUTE, modelFetch } from "./model";
const workspaceId = randomUUID();
const doc = (): PolicyDocument => ({
  schemaVersion: 1,
  state: "enforce",
  offlineTtlSeconds: 60,
  layers: [
    {
      scope: "workspace",
      id: workspaceId,
      ceiling: { git_push: "deny", network: "ask" },
      networkAllow: ["github.com"],
      models: [AGENT_ROUTE],
    },
    {
      scope: "user",
      id: "person",
      defaults: { git_push: "allow", network: "allow" },
      networkAllow: [],
    },
  ],
});
test("lower defaults never erase ceilings, explicit empty network and model lists deny", () => {
  const resolved = resolvePolicy(doc(), { workspaceId, userId: "person" });
  assert.equal(resolved.policy.permissions.git_push, "deny");
  assert.equal(resolved.policy.permissions.network, "ask");
  assert.deepEqual(resolved.policy.networkAllow, []);
  assert.equal(admitModel(resolved, AGENT_ROUTE).model, AGENT_ROUTE.model);
  const empty = doc();
  empty.layers[1].models = [];
  assert.throws(
    () =>
      admitModel(
        resolvePolicy(empty, { workspaceId, userId: "person" }),
        AGENT_ROUTE,
      ),
    /modelRouteDenied/,
  );
  assert.throws(
    () =>
      resolvePolicy(
        { ...doc(), state: "revoked" },
        { workspaceId, userId: "person" },
      ),
    /policyRevoked/,
  );
});
test("strict fields, schema version, scope, TTL and canonical HTTPS endpoint", () => {
  for (const value of [
    { ...doc(), surprise: true },
    { ...doc(), schemaVersion: 2 },
    { ...doc(), offlineTtlSeconds: 0 },
  ])
    assert.equal(documentSchema.safeParse(value).success, false);
  assert.throws(
    () => resolvePolicy(doc(), { workspaceId: randomUUID(), userId: "person" }),
    /policyScopeMismatch/,
  );
  for (const endpoint of [
    "http://model.test/v1",
    "https://u:p@model.test/v1",
    "https://model.test/v1?x=y",
    "https://model.test/v1#x",
    "https://model.test:8443/v1",
    "https://model.test/%2e%2e/v1",
  ])
    assert.equal(endpointSchema.safeParse(endpoint).success, false);
  assert.equal(
    endpointSchema.parse("https://OPENCODE.ai/zen/go/v1/chat/completions"),
    AGENT_ROUTE.endpoint,
  );
});
test("signature, unknown fields, tampering and key rotation fail closed", () => {
  const signer = policySigner("test-only-secret-long-enough-0000000000");
  const signed = signer.sign(workspaceId, 1, doc());
  assert.equal(signer.verify(signed).payload.hash, signed.payload.hash);
  assert.throws(
    () =>
      signer.verify({ ...signed, payload: { ...signed.payload, version: 2 } }),
    /policySignatureInvalid/,
  );
  assert.throws(
    () => signer.verify({ ...signed, unknown: true }),
    /policySignatureInvalid/,
  );
  assert.throws(
    () =>
      policySigner("different-test-only-secret-0000000000000").verify(signed),
    /policySignatureInvalid/,
  );
});
test("every HTTP attempt rechecks policy, endpoint, model aliases, redirect and cancellation", async () => {
  let checks = 0,
    sends = 0,
    revoked = false;
  const guarded = modelFetch(
    async () => {
      checks++;
      if (revoked) throw new Error("revoked");
    },
    AGENT_ROUTE,
    async (_input, init) => {
      sends++;
      assert.equal(init?.redirect, "error");
      return Response.json({ ok: true });
    },
  );
  const init = {
    method: "POST",
    body: JSON.stringify({ model: AGENT_ROUTE.model }),
  };
  await guarded(AGENT_ROUTE.endpoint, init);
  assert.equal(sends, 1);
  revoked = true;
  await assert.rejects(guarded(AGENT_ROUTE.endpoint, init), /revoked/);
  await assert.rejects(
    guarded("https://proxy.example/v1", init),
    /modelEndpointMismatch/,
  );
  await assert.rejects(
    guarded(AGENT_ROUTE.endpoint, {
      ...init,
      body: JSON.stringify({ model: "alias" }),
    }),
    /modelAliasDenied/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    guarded(AGENT_ROUTE.endpoint, { ...init, signal: controller.signal }),
    /abort/i,
  );
  assert.equal(checks, 2);
  assert.equal(sends, 1);
});
