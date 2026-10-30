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
});
