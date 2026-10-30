import assert from "node:assert/strict";
import test from "node:test";
import { maskFactoryNote } from "./note-mask";

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
