import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FactoryError } from "./approval-contract";
import {
  createLocalPublicationAdapter,
  configuredLocalPublicationAdapters,
} from "./local-publication";
import {
  assertPublicationTarget,
  publicationAdapterReceipt,
} from "./publication-receipt";

test("explicit loopback wiring rejects cloud/production and incomplete configuration", () => {
  assert.deepEqual(configuredLocalPublicationAdapters({}), []);
  const env = {
    NODE_ENV: "development",
    BETTER_AUTH_URL: "http://127.0.0.1:3000",
    FACTORY_PUBLICATION_MODE: "local-artifact",
    FACTORY_LOCAL_PUBLICATION_ROOT: "/tmp/factory-local-test",
    FACTORY_LOCAL_PUBLICATION_TARGET: "local-controlled-acceptance",
    FACTORY_LOCAL_PUBLICATION_REPOSITORY: "fixture/Mikka",
    FACTORY_LOCAL_PUBLICATION_ENVIRONMENT: "local-acceptance",
    FACTORY_LOCAL_PUBLICATION_CANDIDATE_ENVIRONMENT: "device:fixture-device",
  };
  assert.equal(configuredLocalPublicationAdapters(env).length, 1);
  for (const extra of [
    { NODE_ENV: "production" },
    { VERCEL: "1" },
    { VERCEL_ENV: "preview" },
    { BETTER_AUTH_URL: "https://app.aspectlylabs.com" },
    { FACTORY_PUBLICATION_MODE: "cloud" },
    { FACTORY_LOCAL_PUBLICATION_ENVIRONMENT: "production" },
    { FACTORY_LOCAL_PUBLICATION_ROOT: "" },
  ])
    assert.throws(
      () => configuredLocalPublicationAdapters({ ...env, ...extra }),
      FactoryError,
    );
});

test("real nonproduction target write/readback, exact SHA/repository/environment, immutable receipt and no path input", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-local-adapter-"));
  const adapter = createLocalPublicationAdapter({
    root,
    target: "local-controlled-acceptance",
    repository: "fixture/Mikka",
    environment: "local-acceptance",
    candidateEnvironment: "device:fixture-device",
  });
  const input = {
    idempotencyKey: randomUUID(),
    candidate: {
      sha: "a".repeat(40),
      repository: "fixture/Mikka",
      environment: "device:fixture-device",
      scope: "fixed backend acceptance",
    },
  };
  try {
    for (const candidate of [
      { ...input.candidate, sha: "main" },
      { ...input.candidate, repository: "other/repo" },
      { ...input.candidate, environment: "production" },
    ])
      await assert.rejects(
        () => adapter.execute({ ...input, candidate }),
        FactoryError,
      );
    await assert.rejects(
      () => adapter.execute({ ...input, idempotencyKey: "../escape" }),
      FactoryError,
    );
    assert.deepEqual(await readdir(root), []);
    const receipt = await adapter.execute(input);
    assert.equal((await adapter.execute(input)).reference, receipt.reference);
    assert.equal((await readdir(root)).length, 1);
    const observed = JSON.parse(
      await readFile(join(root, `${input.idempotencyKey}.json`), "utf8"),
    );
    assert.deepEqual(observed, {
      target: adapter.target,
      targetEnvironment: adapter.environment,
      ...input,
    });
    assert.match(
      receipt.reference,
      /^local-artifact:[\w-]+:sha256:[a-f0-9]{64}$/,
    );
    assertPublicationTarget(
      receipt,
      input.candidate,
      adapter.action,
      adapter.target,
      adapter.environment,
    );
    assert.equal(
      publicationAdapterReceipt.safeParse({
        reference: "unverified request id",
      }).success,
      false,
    );
    assert.throws(
      () =>
        assertPublicationTarget(
          {
            ...receipt,
            verifiedTarget: { ...receipt.verifiedTarget!, sha: "b".repeat(40) },
          },
          input.candidate,
          adapter.action,
          adapter.target,
          adapter.environment,
        ),
      FactoryError,
    );
    assert.throws(
      () =>
        assertPublicationTarget(
          {
            ...receipt,
            verifiedTarget: {
              ...receipt.verifiedTarget!,
              target: "other-target",
            },
          },
          input.candidate,
          adapter.action,
          adapter.target,
          adapter.environment,
        ),
      FactoryError,
    );
    assert.throws(
      () =>
        assertPublicationTarget(
          {
            ...receipt,
            verifiedTarget: {
              ...receipt.verifiedTarget!,
              environment: "production",
            },
          },
          input.candidate,
          adapter.action,
          adapter.target,
          adapter.environment,
        ),
      FactoryError,
    );
    await assert.rejects(
      () =>
        adapter.execute({
          ...input,
          candidate: { ...input.candidate, scope: "changed" },
        }),
      FactoryError,
    );
    await writeFile(join(root, `${input.idempotencyKey}.json`), "corrupt");
    await assert.rejects(() => adapter.execute(input), FactoryError);
  } finally {
    console.info("Factory194 retained artifact directory", root);
  }
});
