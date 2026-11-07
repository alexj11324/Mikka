import assert from "node:assert/strict";
import test from "node:test";
import { factoryBrowserHuman, factoryBrowserSession } from "./browser-human";
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

test("the workspace adapter receives the original verified session and hidden principal", async () => {
  const provenance = Symbol("verified-session-principal")
  const user = Object.defineProperty({ id: "fixture-owner" }, provenance, { value: { kind: "session", sessionId: "fixture-session" } })
  const session = { user, session: { id: "fixture-session" } }
  const result = await factoryBrowserSession(new Request("https://fixture.invalid", { headers: { cookie: "fixture-session=verified" } }), async () => session)
  assert.equal(result, session)
  assert.equal(result?.user, user)
  assert.equal(Object.getOwnPropertyDescriptor(result!.user, provenance)?.enumerable, false)
  assert.deepEqual(Object.getOwnPropertyDescriptor(result!.user, provenance)?.value, { kind: "session", sessionId: "fixture-session" })
})
