import assert from "node:assert/strict";
import test from "node:test";
import { maskFactoryNote } from "./note-mask";
import type { Masker } from '@/lib/secrets/mask';

test("note masker hides secret values in their encoded forms and token patterns", () => {
  const value = "e2b_synthetic_value_123";
  const secrets = [{ name: "E2B_API_KEY", value }];
  for (const form of [value, Buffer.from(value).toString("base64"), Buffer.from(value).toString("hex"), encodeURIComponent(value + "/")])
    assert.doesNotMatch(maskFactoryNote(`x ${form} y`, secrets), /e2b_synthetic|ZTJiX3N5bnRoZXRpY|6532625f/);
  assert.equal(maskFactoryNote("Bearer abc.def", []), "[REDACTED]");
  assert.equal(maskFactoryNote("E2B_API_KEY=e2b_live_xxx and GITHUB_TOKEN: abc", []), "E2B_API_KEY=[REDACTED] and GITHUB_TOKEN=[REDACTED]");
  assert.equal(maskFactoryNote("short ok", [{ name: "S", value: "short" }]), "short ok");
});

test("note masker hides uppercase hex and lowercase %xx spellings", () => {
  const value = "e2b/synth+value=123";
  const secrets = [{ name: "E2B_API_KEY", value }];
  const hex = Buffer.from(value).toString("hex").toUpperCase();
  const pct = encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
  assert.notEqual(pct, encodeURIComponent(value));
  assert.equal(maskFactoryNote(`a ${hex} b`, secrets), "a [secret] b");
  assert.equal(maskFactoryNote(`a ${pct} b`, secrets), "a [secret] b");
  // Mixed case within one string: %2f next to %2B, and alternating-case hex.
  const mixed = encodeURIComponent(value).replace("%2F", "%2f");
  assert.match(mixed, /%2f.*%2B/);
  assert.equal(maskFactoryNote(`a ${mixed} b`, secrets), "a [secret] b");
  const mixedHex = [...Buffer.from(value).toString("hex")].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join("");
  assert.equal(maskFactoryNote(`a ${mixedHex} b`, secrets), "a [secret] b");
  // Regex metacharacters in the value are matched literally.
  assert.equal(maskFactoryNote("a e2bXsynth+value=123 b", secrets), "a e2bXsynth+value=123 b");
});

test("control endpoint masks the human reason before the store sees it", async () => {
  const { handleFactory } = await import("./http");
  const seen: unknown[] = [];
  const store = { apply: async (_u: string, _b: unknown, _e: string, change: unknown) => (seen.push(change), { ok: true }) };
  const taskId = "00000000-0000-4000-8000-000000000001";
  const binding = { taskId, issueId: "00000000-0000-4000-8000-000000000002", attemptId: "00000000-0000-4000-8000-000000000003", revision: 1, candidateId: null };
  const res = await handleFactory(store as never, {
    userId: "owner", taskId, method: "POST", origin: "https://m.example", url: "https://m.example/api/factory/tasks/x",
    body: { binding, eventId: "00000000-0000-4000-8000-000000000004", action: "retry", reason: "retry with GITHUB_TOKEN=ghp_abcdefghijklmnop1234" },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(seen, [{ action: "retry", reason: "retry with GITHUB_TOKEN=[REDACTED]" }]);
});

test("a workspace masker masks a saved secret without an explicit list", () => {
  // The workspace's saved secret has no recognisable prefix, so only the
  // workspace masker can catch it — the built-in token patterns cannot.
  const value = "sup3rs3cr3t-db-password";
  const mask = ((text: string) => text.replaceAll(value, "[secret]")) as Masker;
  assert.equal(maskFactoryNote(`deploy failed: ${value}`, mask), "deploy failed: [secret]");
});

test("a workspace masker composes with the built-in pipeline instead of replacing it", () => {
  // A Masker never reads process.env, so the deployment's own E2B_API_KEY in its
  // base64 form is only matched by the built-in pass. If a supplied Masker
  // short-circuited the pipeline, this value would survive.
  const value = "deploy-only-e2b-key-value";
  process.env.E2B_API_KEY = value;
  try {
    const base64 = Buffer.from(value, "utf8").toString("base64");
    const identity = ((text: string) => text) as Masker;
    assert.equal(maskFactoryNote(`key ${base64}`, identity), "key [secret]", "the built-in server-secret pass still runs");
    // The NAME_KEY=value rule is also part of that pass.
    assert.equal(maskFactoryNote("E2B_API_KEY=" + value, identity), "E2B_API_KEY=[REDACTED]");
  } finally { delete process.env.E2B_API_KEY }
});
