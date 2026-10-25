import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { RunAssignment } from "@mikka/protocol";
import { createHostedBotRunner } from "../src/subscription-hosted-runner";
import { MemoryServer } from "../src/server-link";
import { createLogger } from "../src/log";
import { buildChildEnv } from "../src/env";
import { cleanupTempDirs, makeRepo, tempDir } from "./helpers";

afterEach(cleanupTempDirs);
for (const harness of ["codex", "claude_code"] as const) {
  it(`runs ${harness} through the existing adapter in a private Docker runtime and retains the owner session ledger`, async () => {
    const root = tempDir("mnh-");
    const stateDir = join(root, "adapters");
    mkdirSync(stateDir);
    const runId = randomUUID();
    const consumerId = randomUUID();
    const bindingId = randomUUID();
    const workspaceId = randomUUID();
    const deviceId = randomUUID();
    let connected = true;
    const context = vi.fn(async () => {
      if (!connected) throw new Error("revoked");
      return {
        route:
          harness === "codex"
            ? ("codex_cli" as const)
            : ("claude_code_cli" as const),
        modelId: "fixture-model",
        revision: 2,
        accountId: "fixture-account",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
    });
    const link = Object.assign(new MemoryServer(deviceId).link(), {
      nativeContext: context,
      nativeRequest: vi.fn(async () => {
        throw new Error("fixture CLI must not call provider");
      }),
    });
    const binary = resolve(
      import.meta.dirname,
      "fakes",
      harness === "codex"
        ? "fake-codex-subscription.mjs"
        : "fake-claude-subscription.mjs",
    );
    chmodSync(binary, 0o700);
    const runner = await createHostedBotRunner({
      stateDir,
      link,
      binaries: { [harness]: binary },
    });
    const assignment = {
      runId,
      deviceId,
      issueId: randomUUID(),
      repoId: randomUUID(),
      baseBranch: "main",
      harness,
      prompt: "hello",
      model: "fixture-model",
      subscriptionBinding: {
        bindingId,
        ownerId: "fixture-owner",
        workspaceId,
        consumerId,
        route: harness === "codex" ? "codex_cli" : "claude_code_cli",
      },
    } as RunAssignment;
    const options = {
      runId,
      cwd: await makeRepo(),
      prompt: "PROBE_GIT",
      model: "fixture-model",
      env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: tempDir() } }),
      log: createLogger({ level: "silent" }),
    };
    await expect(runner.start({...assignment,requireSessionResume:true}, options)).rejects.toThrow()
    expect(context).not.toHaveBeenCalled()
    const before = readFileSync(join(options.cwd, ".git", "config"), "utf8");
    const session = await runner.start(assignment, options);
    const events = [];
    for await (const event of session.events()) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "exit", outcome: "succeeded" });
    expect(JSON.stringify(events)).not.toContain(
      "mikka-native-broker-placeholder",
    );
    const ledger = join(stateDir, "native-ledgers", runId + ".json");
    expect(JSON.parse(readFileSync(ledger, "utf8"))).toMatchObject({
      scope: { ownerId: "fixture-owner", bindingId },
      sessionId: session.sessionId,
    });
    expect(
      existsSync(join(stateDir, "runs", runId, "runtime-git", ".git")),
    ).toBe(true);
    connected = false;
    await expect(runner.start(assignment, options)).rejects.toThrow("revoked");
    const verify = await runner.command(
      options.cwd,
      'test -z "$E2B_API_KEY$INFISICAL_CLIENT_SECRET" && ! (printf blocked > .git/guard) 2>/dev/null && printf allowed > project-probe',
      false,
      10000,
    );
    expect(verify.exitCode).toBe(0);
    expect(verify.timedOut).toBe(false);
    expect(verify.timing.runMs).toBeLessThan(10000);
    expect(readFileSync(join(options.cwd, "project-probe"), "utf8")).toBe(
      "allowed",
    );
    expect(readFileSync(join(options.cwd, ".git", "config"), "utf8")).toBe(
      before,
    );
  }, 45000);
}
