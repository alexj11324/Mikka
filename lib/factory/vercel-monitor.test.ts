import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  createVercelMonitorProbe,
  configuredVercelMonitorProbes,
  FACTORY_HEALTH_PATH,
  MIKKA_PRODUCTION_ORIGIN,
} from "./vercel-monitor";
import { MIKKA_VERCEL, vercelTarget } from "./vercel-publication";
import type { MonitorPublication } from "./monitor-probe";

function receipt(
  environment: "preview" | "production" = "production",
): MonitorPublication {
  const publicationId = randomUUID();
  const target = vercelTarget({ ...MIKKA_VERCEL, environment });
  return {
    version: 2,
    publicationId,
    approvalId: randomUUID(),
    taskId: randomUUID(),
    issueId: randomUUID(),
    candidateId: randomUUID(),
    candidate: {
      sha: "a".repeat(40),
      repository: MIKKA_VERCEL.repository,
      environment: `device:${randomUUID()}`,
      scope: "Explicit HTTP protocol fixture",
    },
    action:
      environment === "production" ? "deploy_production" : "deploy_preview",
    target,
    targetEnvironment: environment,
    publishedAt: new Date(Date.now() - 1000).toISOString(),
    reference: "https://mikka-probe-fixture.vercel.app",
    verifiedTarget: {
      kind:
        environment === "production"
          ? "production-deployment"
          : "preview-deployment",
      operationId: "dpl_fixture",
      target,
      environment,
      repository: MIKKA_VERCEL.repository,
      sha: "a".repeat(40),
      reference: "https://mikka-probe-fixture.vercel.app",
      observedAt: new Date(Date.now() - 1000).toISOString(),
      provider: {
        version: 2,
        name: "vercel",
        teamId: MIKKA_VERCEL.teamId,
        projectId: MIKKA_VERCEL.projectId,
        deploymentId: "dpl_fixture",
        environment,
        publicationId,
        bindingHash: "b".repeat(64),
      },
    },
  };
}

test("Vercel monitor actual loopback HTTP protocol substitute (not provider acceptance)", async (t) => {
  let input = receipt();
  let deploymentMutation: (
    value: Record<string, any>,
    alias: boolean,
  ) => void = () => {};
  let projectMutation: (value: Record<string, any>) => void = () => {};
  let healthStatus = 200,
    healthService = "mikka",
    delay = 0,
    oversized = false,
    redirect = false,
    providerStatus = 200;
  let calls: { method: string; path: string; authorization?: string }[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://fixture.invalid").pathname;
    calls.push({
      method: req.method!,
      path,
      authorization: req.headers.authorization,
    });
    const respond = () => {
      if (path.startsWith("/api/") && providerStatus !== 200) {
        res.writeHead(
          providerStatus,
          providerStatus === 302 ? { location: "/redirect-target" } : {},
        );
        res.end("Provider fixture failure; never persist raw response");
        return;
      }
      if (path.startsWith("/api/v9/projects/")) {
        const p: Record<string, any> = {
          id: MIKKA_VERCEL.projectId,
          name: MIKKA_VERCEL.projectName,
          accountId: MIKKA_VERCEL.teamId,
          link: { type: "github", repoId: MIKKA_VERCEL.repoId },
        };
        projectMutation(p);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(p));
        return;
      }
      if (path.startsWith("/api/v13/deployments/")) {
        const d: Record<string, any> = {
          id: "dpl_fixture",
          projectId: MIKKA_VERCEL.projectId,
          ownerId: MIKKA_VERCEL.teamId,
          target:
            input.targetEnvironment === "production" ? "production" : null,
          readyState: "READY",
          aliasAssigned: true,
          url: "mikka-probe-fixture.vercel.app",
          gitSource: {
            type: "github",
            repoId: MIKKA_VERCEL.repoId,
            sha: input.candidate.sha,
          },
          meta: {
            githubCommitSha: input.candidate.sha,
            factoryPublicationId: input.publicationId,
            factoryBindingHash: input.verifiedTarget.provider!.bindingHash,
          },
        };
        deploymentMutation(d, path.endsWith("app.aspectlylabs.com"));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(d));
        return;
      }
      if (path.startsWith("/health/")) {
        if (redirect) {
          res.writeHead(302, { location: "/redirect-target" });
          res.end();
          return;
        }
        res.writeHead(healthStatus, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            service: healthService,
            ...(oversized ? { padding: "x".repeat(150000) } : {}),
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    };
    if (delay) {
      const timer = setTimeout(respond, delay);
      res.on("close", () => clearTimeout(timer));
    } else respond();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const testOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const reset = () => {
    input = receipt();
    deploymentMutation = () => {};
    projectMutation = () => {};
    healthStatus = 200;
    healthService = "mikka";
    delay = 0;
    oversized = false;
    redirect = false;
    providerStatus = 200;
    calls = [];
  };
  const execute = (timeoutMs = 3000) =>
    createVercelMonitorProbe(
      input.targetEnvironment as "preview" | "production",
      () => "fixture-only-token",
      { testOrigin, timeoutMs },
    ).execute(input);
  try {
    await t.test(
      "production binds real git source, fixed alias before/after and application liveness without forwarding credentials",
      async () => {
        reset();
        const result = await execute();
        assert.equal(result.exitCode, 0);
        assert.equal(result.observedSha, input.candidate.sha);
        assert.equal(result.errorCode, null);
        assert.deepEqual(result.provider, input.verifiedTarget.provider);
        assert.deepEqual(result.health, {
          path: FACTORY_HEALTH_PATH,
          immutableStatus: 200,
          immutableBodyValid: true,
          aliasBodyValid: true,
          aliasOrigin: MIKKA_PRODUCTION_ORIGIN,
          aliasBefore: "dpl_fixture",
          aliasAfter: "dpl_fixture",
          aliasStatus: 200,
        });
        assert.equal(
          calls.filter((c) => c.path.endsWith("app.aspectlylabs.com")).length,
          2,
        );
        assert.ok(
          calls
            .filter((c) => c.path.startsWith("/api/"))
            .every((c) => c.authorization === "Bearer fixture-only-token"),
        );
        assert.ok(
          calls
            .filter((c) => c.path.startsWith("/health/"))
            .every((c) => c.authorization === undefined),
        );
        assert.ok(calls.every((c) => c.method === "GET"));
        assert.ok(!JSON.stringify(result).includes("fixture-only-token"));
      },
    );
    await t.test(
      "preview uses immutable health only and never pretends to be production",
      async () => {
        reset();
        input = receipt("preview");
        const result = await execute();
        assert.equal(result.exitCode, 0);
        assert.equal(result.health?.aliasOrigin, null);
        assert.equal(result.health?.aliasStatus, null);
        assert.equal(
          calls.filter((c) => c.path.includes("app.aspectlylabs.com")).length,
          0,
        );
        const rejected = await createVercelMonitorProbe(
          "production",
          () => "fixture-only-token",
          { testOrigin },
        ).execute(input);
        assert.equal(rejected.errorCode, "receipt-identity-mismatch");
      },
    );
    const mutations: [string, (d: Record<string, any>) => void][] = [
      [
        "wrong git SHA",
        (d) => {
          d.gitSource.sha = "c".repeat(40);
        },
      ],
      [
        "metadata SHA without real source",
        (d) => {
          delete d.gitSource;
        },
      ],
      [
        "wrong team",
        (d) => {
          d.ownerId = "team_other";
        },
      ],
      [
        "wrong project",
        (d) => {
          d.projectId = "prj_other";
        },
      ],
      [
        "wrong environment",
        (d) => {
          d.target = null;
        },
      ],
      [
        "wrong repository",
        (d) => {
          d.gitSource.repoId = "99";
        },
      ],
      [
        "wrong publication",
        (d) => {
          d.meta.factoryPublicationId = randomUUID();
        },
      ],
      [
        "wrong binding hash",
        (d) => {
          d.meta.factoryBindingHash = "c".repeat(64);
        },
      ],
      [
        "wrong operation",
        (d) => {
          d.id = "dpl_other";
        },
      ],
      [
        "wrong reference",
        (d) => {
          d.url = "another.vercel.app";
        },
      ],
      [
        "pending deployment",
        (d) => {
          d.readyState = "BUILDING";
        },
      ],
      [
        "unassigned aliases",
        (d) => {
          d.aliasAssigned = false;
        },
      ],
    ];
    for (const [name, mutation] of mutations)
      await t.test(name, async () => {
        reset();
        deploymentMutation = mutation;
        const result = await execute();
        assert.equal(result.exitCode, 1);
        assert.equal(result.errorCode, "deployment-identity-mismatch");
        assert.ok(calls.every((c) => c.method === "GET"));
        assert.equal(
          calls.filter((c) => c.path.startsWith("/health/")).length,
          0,
        );
      });
    await t.test(
      "project GitHub link mismatch fails before health",
      async () => {
        reset();
        projectMutation = (p) => {
          p.link.repoId = "99";
        };
        const result = await execute();
        assert.equal(result.errorCode, "project-identity-mismatch");
      },
    );
    await t.test(
      "moving production alias is observed and cannot pass",
      async () => {
        reset();
        let aliasReads = 0;
        deploymentMutation = (d, alias) => {
          if (alias && ++aliasReads === 2) d.id = "dpl_replacement";
        };
        const result = await execute();
        assert.equal(result.exitCode, 1);
        assert.equal(result.errorCode, "deployment-identity-mismatch");
        assert.equal(result.health?.aliasBefore, "dpl_fixture");
        assert.equal(result.health?.aliasAfter, "dpl_replacement");
      },
    );
    await t.test("health HTTP failure is sanitized, not recovery", async () => {
      reset();
      healthStatus = 503;
      const result = await execute();
      assert.equal(result.exitCode, 1);
      assert.equal(result.errorCode, "health-http-503");
      assert.equal(result.health?.immutableStatus, 503);
      assert.equal(result.health?.aliasStatus, 503);
      assert.equal(result.health?.aliasBefore, "dpl_fixture");
      assert.equal(result.health?.aliasAfter, "dpl_fixture");
      assert.ok(calls.at(-1)?.path.endsWith("app.aspectlylabs.com"));
    });
    await t.test(
      "a moved alias overrides an observed application failure",
      async () => {
        reset();
        healthStatus = 503;
        let aliasReads = 0;
        deploymentMutation = (d, alias) => {
          if (alias && ++aliasReads === 2) d.id = "dpl_replacement";
        };
        const result = await execute();
        assert.equal(result.health?.immutableStatus, 503);
        assert.equal(result.health?.aliasAfter, "dpl_replacement");
        assert.equal(result.errorCode, "deployment-identity-mismatch");
        assert.equal(result.exitCode, 1);
      },
    );
    await t.test(
      "preview rechecks immutable identity even after health failure",
      async () => {
        reset();
        input = receipt("preview");
        healthStatus = 503;
        const result = await execute();
        assert.equal(result.errorCode, "health-http-503");
        assert.equal(
          calls.filter((c) => c.path.endsWith("dpl_fixture")).length,
          2,
        );
        assert.ok(calls.at(-1)?.path.endsWith("dpl_fixture"));
      },
    );
    await t.test(
      "wrong service does not prove application health",
      async () => {
        reset();
        healthService = "another-app";
        assert.equal((await execute()).errorCode, "health-invalid");
      },
    );
    await t.test("health redirects are never followed", async () => {
      reset();
      redirect = true;
      const result = await execute();
      assert.equal(result.exitCode, 1);
      assert.equal(result.errorCode, "probe-transport-error");
      assert.equal(
        calls.filter((c) => c.path === "/redirect-target").length,
        0,
      );
    });
    await t.test(
      "response bodies and total request lifetime are bounded",
      async () => {
        reset();
        oversized = true;
        assert.equal((await execute()).errorCode, "response-too-large");
        reset();
        delay = 100;
        const result = await execute(20);
        assert.equal(result.errorCode, "probe-timeout");
        assert.equal(result.timedOut, true);
      },
    );
    await t.test(
      "receipt mismatch and missing runtime credential cause no external call",
      async () => {
        reset();
        input.verifiedTarget.provider!.bindingHash = "invalid";
        assert.equal((await execute()).errorCode, "receipt-identity-mismatch");
        assert.equal(calls.length, 0);
        reset();
        assert.equal(
          (
            await createVercelMonitorProbe("production", () => undefined, {
              testOrigin,
            }).execute(input)
          ).errorCode,
          "credential-unavailable",
        );
        assert.equal(calls.length, 0);
      },
    );
    await t.test(
      "provider authorization failures and redirects stay closed without application checks",
      async () => {
        for (const status of [401, 403, 302]) {
          reset();
          providerStatus = status;
          const result = await execute();
          assert.equal(result.exitCode, 1);
          assert.equal(
            result.errorCode,
            status === 302
              ? "probe-transport-error"
              : `provider-http-${status}`,
          );
          assert.equal(calls.length, 1);
          assert.ok(
            !JSON.stringify(result).includes("Provider fixture failure"),
          );
        }
      },
    );
    await t.test(
      "legacy receipt and non-HTTPS application destination are rejected before network",
      async () => {
        reset();
        const legacy = {
          ...input,
          version: 1,
        } as unknown as MonitorPublication;
        assert.equal(
          (
            await createVercelMonitorProbe(
              "production",
              () => "fixture-only-token",
              { testOrigin },
            ).execute(legacy)
          ).errorCode,
          "receipt-identity-mismatch",
        );
        input.reference = "http://127.0.0.1:9";
        input.verifiedTarget.reference = input.reference;
        assert.equal((await execute()).errorCode, "receipt-identity-mismatch");
        assert.equal(calls.length, 0);
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("runtime registration follows configured publication and stays constrained to existing project resources", () => {
  assert.deepEqual(configuredVercelMonitorProbes({}), []);
  assert.throws(() =>
    configuredVercelMonitorProbes({ FACTORY_VERCEL_MONITOR: "1" }),
  );
  assert.throws(() =>
    configuredVercelMonitorProbes({
      FACTORY_VERCEL_MONITOR: "1",
      FACTORY_VERCEL_PUBLICATION: "1",
    }),
  );
  const env = {
    FACTORY_VERCEL_PUBLICATION: "1",
    VERCEL_TOKEN: "fixture-only-token",
  };
  // A configured publication must not strand its read-only monitor behind a
  // second default-off rollout flag. Explicit operator stop still takes effect.
  assert.equal(configuredVercelMonitorProbes(env).length, 1);
  assert.equal(configuredVercelMonitorProbes({ ...env, FACTORY_VERCEL_MONITOR: "1" }).length, 1);
  assert.deepEqual(configuredVercelMonitorProbes({ ...env, FACTORY_VERCEL_MONITOR: "0" }), []);
  assert.deepEqual(configuredVercelMonitorProbes({ VERCEL_TOKEN: env.VERCEL_TOKEN }), []);
  assert.throws(() => configuredVercelMonitorProbes({ FACTORY_VERCEL_PUBLICATION: "1" }));
  const adapters = configuredVercelMonitorProbes({
    ...env,
    FACTORY_VERCEL_PRODUCTION: "1",
  });
  assert.deepEqual(
    adapters.map((a) => a.environment),
    ["preview", "production"],
  );
  assert.throws(() =>
    createVercelMonitorProbe("production", () => "fixture", {
      testOrigin: "https://untrusted.example",
    }),
  );
});
