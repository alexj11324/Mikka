import assert from "node:assert/strict";
import test from "node:test";
import { maskFactoryNote } from "./note-mask";
import { FactoryError } from "./contract";
import { factoryListStatus, handleFactoryList, type FactoryStore } from "./http";
import { redactFactoryCheckText } from "./checks";

const issueId = "00000000-0000-4000-8000-000000000000";
const throwing = (error: unknown) =>
  ({ listForIssue: async () => { throw error; } }) as unknown as FactoryStore;

test("list contract is exactly 401/422/404/503", async () => {
  assert.equal(factoryListStatus("factoryNotFound"), 404);
  assert.equal(factoryListStatus("factoryInvalid"), 422);
  assert.equal(factoryListStatus("factoryStale"), 503);
  assert.deepEqual(await handleFactoryList(throwing(new FactoryError("factoryNotFound")), { userId: null, issueId }), { status: 401, body: { error: "authRequired" } });
  assert.deepEqual(await handleFactoryList(throwing(new FactoryError("factoryNotFound")), { userId: "u", issueId: "x" }), { status: 422, body: { error: "factoryInvalid" } });
  assert.deepEqual(await handleFactoryList(throwing(new FactoryError("factoryNotFound")), { userId: "u", issueId }), { status: 404, body: { error: "factoryNotFound" } });
});

test("a database error is 503 without detail, never a 500", async () => {
  const dbError = Object.assign(new Error('relation "factory_tasks" does not exist at 10.0.0.5 password=hunter2'), { code: "42P01" });
  const result = await handleFactoryList(throwing(dbError), { userId: "u", issueId });
  assert.deepEqual(result, { status: 503, body: { error: "factoryUnavailable" } });
  assert.doesNotMatch(JSON.stringify(result), /hunter2|42P01|factory_tasks/);
});

test("list reason uses the factory text masker", () => {
  assert.equal(redactFactoryCheckText("token ghp_abcdefghijklmnop leaked"), "token [REDACTED] leaked");
});

// Fabricated at runtime so no token-shaped literal sits in the repository.
const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const fakeJwt = `${b64url({ alg: "ES256", typ: "JWT" })}.${b64url({ aud: "fixture", iss: "fixture" })}.${"Ab_cD-ef".repeat(8)}`;
const fakeInstallation = ["ghs", "1234567", fakeJwt].join("_");

test("check text masks an installation token and a JWT whole (shared credential patterns)", () => {
  const masked = redactFactoryCheckText(`gh: Token: ${fakeInstallation} and jwt ${fakeJwt} done`);
  assert.equal(masked, "gh: Token=[REDACTED] and jwt [REDACTED] done");
  for (const part of fakeJwt.split(".")) assert.ok(!masked.includes(part), "no JWT segment remains");
});

test("list reason masks key=value secrets and env secret values", () => {
  assert.doesNotMatch(maskFactoryNote("E2B_API_KEY=e2b_live_xxx"), /e2b_live_xxx/);
  assert.doesNotMatch(maskFactoryNote("leaked e2b_synthetic_value_1", [{ name: "E2B_API_KEY", value: "e2b_synthetic_value_1" }]), /e2b_synthetic/);
});
