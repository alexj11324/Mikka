import assert from "node:assert/strict";
import test from "node:test";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { generatePolicyText } from "./generate-text";

for (const change of ["published", "revoked", "versionUpdated"]) {
  test(`compaction retry rechecks policy after ${change}, without SDK hidden sends`, async () => {
    let gates = 0,
      calls = 0,
      current = false;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls++;
        current = true;
        throw new APICallError({
          message: "Synthetic retryable failure",
          url: "https://fixture.invalid",
          requestBodyValues: {},
          statusCode: 503,
          isRetryable: true,
        });
      },
    });
    const admit = async () => {
      gates++;
      if (current) throw new Error(change);
    };
    await assert.rejects(
      generatePolicyText(admit, { model, prompt: "synthetic", maxRetries: 9 }),
      /Synthetic/,
    );
    assert.equal(calls, 1);
    await assert.rejects(
      generatePolicyText(admit, { model, prompt: "synthetic" }),
      new RegExp(change),
    );
    assert.equal(gates, 2);
    assert.equal(calls, 1);
  });
}
