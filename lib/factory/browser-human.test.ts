import assert from "node:assert/strict";
import test from "node:test";
import { factoryBrowserHuman } from "./browser-human";
import { approvalRequest, publicationRequest } from "./approval-contract";
test("strict human-session boundary rejects worker bearer/JSON identity and client receipts", async () => {
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

test("native human headers never use an ambient cookie to rescue delegated credentials", async () => {
  for (const prefix of ["mkp_", "mka_", "mkr_"]) {
    const result = await factoryBrowserHuman(
      new Request("https://fixture.invalid", {
        headers: { authorization: `Bearer ${prefix}${"x".repeat(43)}`, cookie: "synthetic" },
      }),
      async () => { throw new Error("delegated credentials must not reach session authentication"); },
    );
    assert.equal(result, null);
  }
  const native = new Request("https://fixture.invalid", {
    headers: { authorization: `Bearer ${"native-session-fixture".padEnd(43, "x")}`, cookie: "synthetic" },
  });
  const verified = { user: { id: "person" }, session: { id: "live-session" } };
  assert.deepEqual(await factoryBrowserHuman(native, async headers => {
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("authorization"), native.headers.get("authorization"));
    return verified;
  }), { userId: "person", sessionId: "live-session" });
  assert.equal(await factoryBrowserHuman(native, async () => null), null);
});
