import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { vercelProtocolFixture } from "../../tests/helpers/factory-vercel";
import {
  createVercelPublicationAdapter,
  createVercelClient,
  configuredVercelPublicationAdapters,
  MIKKA_VERCEL,
  vercelTarget,
} from "./vercel-publication";
import {
  PublicationDeferred,
  publicationBindingHash,
  type PublicationInput,
} from "./publication-operation";
import {
  assertPublicationTarget,
  publicationAdapterReceipt,
} from "./publication-receipt";
import { FactoryError } from "./approval-contract";

function input(
  environment: "preview" | "production" = "preview",
): PublicationInput {
  return {
    idempotencyKey: randomUUID(),
    candidate: {
      sha: "a".repeat(40),
      repository: MIKKA_VERCEL.repository,
      environment: `device:${randomUUID()}`,
      scope: "backend adapter contract",
    },
    authorization: {
      approvalId: randomUUID(),
      ownerId: "synthetic-owner",
      humanSessionId: "synthetic-human-session",
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      binding: {
        taskId: randomUUID(),
        issueId: randomUUID(),
        attemptId: randomUUID(),
        revision: 8,
        candidateId: randomUUID(),
      },
      eventId: randomUUID(),
      action:
        environment === "production" ? "deploy_production" : "deploy_preview",
      target: vercelTarget({ ...MIKKA_VERCEL, environment }),
      targetEnvironment: environment,
    },
  };
}
const deferred = async (
  fn: () => Promise<unknown>,
  state: "pending" | "uncertain",
) => {
  try {
    await fn();
    assert.fail("must not succeed");
  } catch (e) {
    assert.ok(e instanceof PublicationDeferred);
    assert.equal(e.state, state);
    return e;
  }
};

for (const environment of ["preview", "production"] as const)
  test(`real HTTP protocol substitute: ${environment} exact SHA and provider receipt`, async () => {
    const f = await vercelProtocolFixture();
    try {
      const adapter = createVercelPublicationAdapter(
          { ...MIKKA_VERCEL, environment },
          f.client,
        ),
        i = input(environment);
      const r = publicationAdapterReceipt.parse(await adapter.execute(i)),
        post = f.requests.find((x) => x.method === "POST")!.body;
      assert.deepEqual(
        Object.keys(post).sort(),
        [
          "gitSource",
          "meta",
          "name",
          "project",
          ...(environment === "production" ? ["target"] : []),
        ].sort(),
      );
      assert.deepEqual(post.gitSource, {
        type: "github",
        repoId: MIKKA_VERCEL.repoId,
        ref: i.candidate.sha,
        sha: i.candidate.sha,
      });
      assert.equal(
        post.target,
        environment === "production" ? "production" : undefined,
      );
      assert.deepEqual(post.meta, {
        factoryPublicationId: i.idempotencyKey,
        factoryBindingHash: publicationBindingHash(i),
      });
      assert.equal(
        JSON.stringify(post).includes("synthetic-human-session"),
        false,
      );
      assertPublicationTarget(
        r,
        i.candidate,
        i.authorization!.action,
        i.authorization!.target,
        environment,
        i.idempotencyKey,
      );
      assert.equal(r.verifiedTarget.kind, `${environment}-deployment`);
      assert.equal(f.posts(), 1);
      const readback = await adapter.reconcile!(i, null);
      assert.deepEqual(
        { ...readback.verifiedTarget, observedAt: r.verifiedTarget.observedAt },
        r.verifiedTarget,
      );
      assert.equal(f.posts(), 1);
    } finally {
      await f.close();
    }
  });
test("queued operation is checkpointed; reconciliation only reads, preserves expiry/session/fence binding", async () => {
  const f = await vercelProtocolFixture();
  try {
    f.state.readyState = "BUILDING";
    const a = createVercelPublicationAdapter(
        { ...MIKKA_VERCEL, environment: "preview" },
        f.client,
      ),
      i = input();
    const e = await deferred(() => a.execute(i), "pending");
    const d = [...f.deployments.values()][0];
    d.readyState = "READY";
    const r = await a.reconcile!(i, e.checkpoint);
    assert.equal(r.verifiedTarget.operationId, d.id);
    assert.equal(f.posts(), 1);
    for (const altered of [
      {
        ...i,
        authorization: {
          ...i.authorization!,
          expiresAt: new Date(Date.now() + 1000).toISOString(),
        },
      },
      {
        ...i,
        authorization: { ...i.authorization!, humanSessionId: "another" },
      },
      {
        ...i,
        authorization: {
          ...i.authorization!,
          binding: { ...i.authorization!.binding, revision: 9 },
        },
      },
    ])
      await assert.rejects(
        () => a.reconcile!(altered, e.checkpoint),
        /factoryVercelIdentityMismatch/,
      );
    assert.equal(f.posts(), 1);
  } finally {
    await f.close();
  }
});
test("accepted POST with lost response recovers through metadata lookup without a second POST", async () => {
  const f = await vercelProtocolFixture();
  try {
    f.state.dropCreateResponse = true;
    const a = createVercelPublicationAdapter(
        { ...MIKKA_VERCEL, environment: "preview" },
        f.client,
      ),
      i = input();
    await assert.rejects(() => a.execute(i), /factoryVercelTransportUncertain/);
    assert.equal(f.deployments.size, 1);
    const r = await a.reconcile!(i, null);
    assert.equal(r.verifiedTarget.sha, i.candidate.sha);
    assert.equal(f.posts(), 1);
    f.deployments.set("dpl_duplicate", {
      ...[...f.deployments.values()][0],
      id: "dpl_duplicate",
    });
    await deferred(() => a.reconcile!(i, null), "uncertain");
    assert.equal(f.posts(), 1);
  } finally {
    await f.close();
  }
});
test("readback rejects wrong project/team/SHA/environment/repository/meta/URL and terminal failures", async () => {
  const f = await vercelProtocolFixture();
  try {
    const a = createVercelPublicationAdapter(
        { ...MIKKA_VERCEL, environment: "preview" },
        f.client,
      ),
      i = input();
    await a.execute(i);
    const d = [...f.deployments.values()][0],
      base = structuredClone(d);
    for (const patch of [
      { projectId: "prj_wrong" },
      { ownerId: "team_wrong" },
      { gitSource: { ...d.gitSource, sha: "b".repeat(40) } },
      { target: "production" },
      { gitSource: { ...d.gitSource, repoId: "1" } },
      { gitSource: undefined },
      { gitSource: { type: "github", repoId: MIKKA_VERCEL.repoId } },
      { gitSource: { type: "github", sha: i.candidate.sha } },
      { meta: { ...d.meta, factoryBindingHash: "f".repeat(64) } },
      { customEnvironment: { id: "env_custom" } },
      { url: "mikka-git-main-mikka-dev.vercel.app" },
      { url: "evil.example" },
    ]) {
      Object.assign(d, base, patch);
      await assert.rejects(
        () => a.reconcile!(i, null),
        /factoryVercelIdentityMismatch|factoryPublicationUncertain/,
      );
      delete d.customEnvironment;
    }
    Object.assign(d, base, { readyState: "ERROR" });
    await deferred(() => a.reconcile!(i, null), "uncertain");
    assert.equal(f.posts(), 1);
  } finally {
    await f.close();
  }
});
test("no match stays uncertain, grant mismatch and missing token make no provider write", async () => {
  const f = await vercelProtocolFixture();
  try {
    const a = createVercelPublicationAdapter(
        { ...MIKKA_VERCEL, environment: "preview" },
        f.client,
      ),
      i = input();
    await deferred(() => a.reconcile!(i, null), "uncertain");
    await assert.rejects(
      () =>
        a.execute({
          ...i,
          authorization: { ...i.authorization!, action: "deploy_production" },
        }),
      /factoryVercelIdentityMismatch/,
    );
    f.state.project.link.repoId = 1;
    await assert.rejects(() => a.execute(i), /factoryVercelIdentityMismatch/);
    assert.equal(f.posts(), 0);
    assert.deepEqual(configuredVercelPublicationAdapters({}), []);
    assert.throws(
      () =>
        configuredVercelPublicationAdapters({
          FACTORY_VERCEL_PUBLICATION: "1",
        }),
      /factoryVercelCredentialUnavailable/,
    );
    await assert.rejects(
      () => createVercelClient(() => undefined).request("/v9/projects/x"),
      /factoryVercelCredentialUnavailable/,
    );
  } finally {
    await f.close();
  }
});
test("preflight expiry and trusted live-grant hook prevent the create POST", async () => {
  const f = await vercelProtocolFixture();
  try {
    const a = createVercelPublicationAdapter(
        { ...MIKKA_VERCEL, environment: "production" },
        f.client,
      ),
      i = input("production");
    f.state.projectDelayMs = 100;
    i.authorization!.expiresAt = new Date(Date.now() + 30).toISOString();
    await assert.rejects(() => a.execute(i), /factoryApprovalInvalid/);
    assert.equal(f.posts(), 0);
    i.authorization!.expiresAt = new Date(Date.now() + 600000).toISOString();
    let checked = false;
    i.beforeCreate = async () => {
      checked = true;
      throw new FactoryError("factoryHumanRequired");
    };
    await assert.rejects(() => a.execute(i), /factoryHumanRequired/);
    assert.equal(checked, true);
    assert.equal(f.posts(), 0);
  } finally {
    await f.close();
  }
});
test("transport rejects invalid JSON and HTTP failure; receipt cannot relabel production as preview", async () => {
  for (const response of [
    new Response("secret response", { status: 401 }),
    new Response("not json", { status: 200 }),
  ]) {
    const c = createVercelClient(() => "fixture", {
      fetch: async () => response,
    });
    await assert.rejects(
      () => c.request("/test"),
      (e: unknown) =>
        e instanceof FactoryError && !e.message.includes("secret response"),
    );
  }
  assert.throws(
    () =>
      createVercelClient(() => "fixture", {
        testOrigin: "https://evil.example",
      }),
    /factoryVercelOriginInvalid/,
  );
  const f = await vercelProtocolFixture();
  try {
    const i = input("production"),
      a = createVercelPublicationAdapter(
        { ...MIKKA_VERCEL, environment: "production" },
        f.client,
      ),
      r = await a.execute(i);
    assert.throws(
      () =>
        assertPublicationTarget(
          {
            ...r,
            verifiedTarget: { ...r.verifiedTarget, kind: "preview-deployment" },
          },
          i.candidate,
          "deploy_preview",
          i.authorization!.target,
          "production",
          i.idempotencyKey,
        ),
      /factoryPublicationReceiptMismatch/,
    );
    const d = [...f.deployments.values()][0];
    d.aliasAssigned = false;
    await deferred(() => a.reconcile!(i, null), "pending");
  } finally {
    await f.close();
  }
});
