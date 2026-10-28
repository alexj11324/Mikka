import assert from "node:assert/strict";
import test from "node:test";
import { factoryBrowserHuman } from "./browser-human";
import { approvalRequest, publicationRequest } from "./approval-contract";
test("strict browser-only human boundary rejects worker bearer/JSON identity and client receipts", async () => {
  assert.equal(
    await factoryBrowserHuman(
      new Request("https://fixture.invalid", {
        headers: {
          authorization: "Bearer synthetic-worker",
          cookie: "synthetic",
        },
      }),
      async () => {
        throw Error("must not authenticate delegated token");
      },
    ),
    null,
  );
  assert.equal(
    await factoryBrowserHuman(
      new Request("https://fixture.invalid"),
      async () => null,
    ),
    null,
  );
  assert.equal(
    approvalRequest.safeParse({ actor: { userId: "owner" } }).success,
    false,
  );
  assert.equal(
    publicationRequest.safeParse({
      receipt: { reference: "https://forged.invalid" },
    }).success,
    false,
  );
});
