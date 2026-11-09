// Isolated PG suite only. All model transport, image bytes and native actors
// are fixtures; registered tool/step/runtime/store/decision code is real.
import assert from "node:assert/strict";
import { mock, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { FactorySnapshot } from "../../lib/factory/store";
import type { FactoryCheckRecoveryDependencies } from "../../lib/factory/check-recovery";
import { factoryBinding } from "../../lib/factory/dispatch";
import { makeSnapshot } from "../../lib/agent-kit/definition";
import { DEFAULT_AGENT_DEFINITION } from "../../lib/agent-kit/builtin";
import { NativeCoordinatorError } from "../../lib/coordinator/native-store";
import type { AgentExecution } from "../../lib/agent-kit/store";

export async function exerciseFactoryRecoveryEntry(
  t: TestContext,
  fixture: {
    db: Pool;
    /** The person's Coordinator bot row, which the review's factory task belongs to. */
    botId: string;
    failedReview: () => Promise<{ snapshot: FactorySnapshot; runId: string }>;
    png: string;
    sha: string;
    modelInvoke: NonNullable<FactoryCheckRecoveryDependencies["invoke"]>;
    callCount: () => number;
    chooseRetry: () => void;
    latestRequest: () => unknown;
  },
) {
  const { db } = fixture;
  const { pool: applicationPool } = await import("../../lib/db");
  const { workspacePool } = await import("../../lib/workspace-db");
  assert.equal(applicationPool.options.connectionString, db.options.connectionString,
    "registered recovery uses the caller's real isolated APP request scope");
  assert.equal(workspacePool.options.connectionString, db.options.connectionString,
    "registered recovery uses the same real isolated Workspace authority");
  let revoked = false,
    guardCalls = 0,
    runtimeCalls = 0;
  const unused = async () => {
    throw Error("Unexpected offline fixture operation");
  };
  const handles: { restore: () => void }[] = [];
  const stub = (path: string, namedExports: Record<string, unknown>) =>
    handles.push(
      mock.module(new URL(path, import.meta.url).href, { namedExports }),
    );
  const flags = [
    "MIKKA_FACTORY_ROUTING_ENABLED",
    "MIKKA_FACTORY_LIFECYCLE_ENABLED",
  ] as const;
  const previous = flags.map((key) => process.env[key]);
  try {
    for (const key of flags) process.env[key] = "1";
    // The registered entry uses real APP scope, the Workspace membership lease,
    // and canonical full-reader task visibility. Only unrelated host/transport
    // boundaries below are isolated from this offline fixture.
    stub("../../lib/agent-runs.ts", {
      addRunMessage: unused,
      queueRun: unused,
      queueFactoryRun: unused,
      readRun: unused,
      requestRunStop: unused,
      visibleRuns: unused,
    });
    stub("../../lib/coordinator/native.ts", {
      nativeCoordinatorEnabled: () => false,
      nativeCoordinatorStore: {
        assertToolActive: async (
          user: string,
          holder: string,
          turn: string,
          call: string,
        ) => {
          guardCalls++;
          assert.deepEqual(
            [user, holder, turn, call],
            ["owner", "fixture-holder", "fixture-turn", "fixture-native-call"],
          );
          if (revoked)
            throw new NativeCoordinatorError(
              409,
              "coordinatorExpiredOrLeaseLost",
            );
        },
      },
    });
    stub("../../lib/coordinator/store.ts", { editMemory: unused });
    stub("../../lib/device-link.ts", { DEVICE_ONLINE_WINDOW_MS: 60000 });
    stub("../../lib/search/index.ts", { webSearch: unused });
    stub("../../lib/composio.ts", { runComposioAction: unused });
    // Recovery exercises its real entry/runtime, never unrelated GitHub issue reads.
    stub("../../lib/github/user-access.ts", { readAuthorizedIssue: unused });
    stub("../../lib/pending-action-store.ts", { proposeAction: unused, writeAccountAction: unused, proposeRepositoryPush: unused });
    stub("../../lib/telegram/client.ts", { postTelegramText: unused });
    stub("../../lib/attention/store.ts", {
      recordDecision: unused,
      settleTurn: unused,
    });
    stub("../../lib/composio-actions.ts", {
      createComposioAITools: () => ({}),
      createGoogleAITools: () => ({}),
    });
    stub("../../workflows/coordinator/agent-kit-steps.ts", {
      beforeAgentTool: async () => {},
      afterAgentTool: async () => {},
    });
    const actual = await import("../../lib/factory/runtime");
    let collectImages: FactoryCheckRecoveryDependencies["collectImages"];
    stub("../../lib/factory/runtime.ts", {
      ...actual,
      factoryRuntimeForBot: (botId: string | null) => {
        runtimeCalls++;
        return actual.factoryRuntimeForBot(
          botId,
          undefined,
          undefined,
          undefined,
          undefined,
          { invoke: (...args) => {
            assert.equal(applicationPool.totalCount - applicationPool.idleCount, 0,
              "registered recovery releases its actual APP client before invoking the model");
            return fixture.modelInvoke(...args);
          }, collectImages },
        );
      },
    });
    const registry = await import("../../workflows/coordinator/tools");
    const scope = {
      holder: "fixture-holder",
      turnId: "fixture-turn",
      callId: "fixture-native-call",
    };
    const execution: AgentExecution = {
      id: randomUUID(),
      status: "running",
      snapshot: makeSnapshot(
        randomUUID(),
        1,
        { ...DEFAULT_AGENT_DEFINITION, tools: ["recover_factory_check"] },
        "Synthetic offline host",
        { harness: "ai_sdk", model: "synthetic-planning-fixture" },
      ),
    };
    const tools = registry.coordinatorTools("owner", fixture.botId, scope, { coordinator: true, 
      execution,
    });
    assert.deepEqual(Object.keys(tools), ["recover_factory_check"]);
    const call = {
      toolCallId: "fixture-sdk-context",
      messages: [],
      context: {},
    };
    for (const mode of ["text", "image", "missing-image"] as const)
      await t.test(
        "registered recovery entry -> actual step/runtime/decision: " + mode,
        async () => {
          const { snapshot, runId } = await fixture.failedReview(),
            input = { binding: factoryBinding(snapshot.task) },
            count = fixture.callCount();
          fixture.chooseRetry();
          collectImages = async (tx, observation) => {
            assert.equal(observation.run.id, runId);
            if (mode !== "image")
              return { requiresVisual: mode === "missing-image", images: [] };
            const {
              rows: [run],
            } = await tx.query(
              'SELECT "finishedAt" FROM agent_runs WHERE id=$1',
              [runId],
            );
            return {
              requiresVisual: true,
              images: [
                {
                  image: { dataUrl: fixture.png, detail: "high" },
                  artifact: "synthetic-entry-image:" + runId,
                  runId,
                  sessionId: observation.run.sessionId,
                  candidateId: observation.candidate.id,
                  sha: fixture.sha,
                  observedAt: run.finishedAt.toISOString(),
                },
              ],
            };
          };
          const result = (await tools.recover_factory_check.execute!(
            input,
            call,
          )) as any;
          if (mode === "missing-image") {
            assert.equal(result.pending, true);
            assert.equal(result.reason, "visual_evidence_unavailable");
            assert.equal(fixture.callCount(), count);
            return;
          }
          assert.equal(result.task.stage, "review");
          assert.equal(result.task.status, "pending");
          assert.equal(result.task.candidateId, snapshot.task.candidateId);
          const receipt = result.attempts.find(
            (a: any) => a.id === result.task.attemptId,
          ).output.recovery;
          assert.equal(receipt.sdkToolCallId, call.toolCallId);
          assert.equal(
            receipt.execution.vision,
            mode === "image" ? "image-input-submitted" : "no-image-input",
          );
          assert.equal(fixture.callCount(), count + 1);
          const request = fixture.latestRequest() as any;
          assert.equal(
            request.input[0].content.filter(
              (part: any) => part.type === "input_image",
            ).length,
            mode === "image" ? 1 : 0,
          );
          assert.deepEqual(
            await tools.recover_factory_check.execute!(input, {
              ...call,
              toolCallId: "fixture-replay-context",
            }),
            result,
          );
          assert.equal(fixture.callCount(), count + 1);
        },
      );
    await t.test(
      "registered recovery rejects suspended Workspace membership without model or task effects",
      async () => {
        const { snapshot } = await fixture.failedReview();
        const count = fixture.callCount();
        const { rows: [bot] } = await db.query<{ workspaceId: string }>(
          'SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2',
          [fixture.botId, "owner"],
        );
        assert.ok(bot?.workspaceId);
        const taskState = async () => (await db.query(
          'SELECT to_jsonb(t) AS value FROM factory_tasks t WHERE id=$1',
          [snapshot.task.id],
        )).rows[0].value;
        const before = await taskState();
        await db.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2',
          [bot.workspaceId, "owner"]);
        try {
          assert.deepEqual(await tools.recover_factory_check.execute!(
            { binding: factoryBinding(snapshot.task) }, call,
          ), { error: "factoryNotFound" });
          assert.equal(fixture.callCount(), count);
          assert.deepEqual(await taskState(), before);
        } finally {
          await db.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2',
            [bot.workspaceId, "owner"]);
        }
      },
    );
    await t.test(
      "real recovery step rechecks native scope before resolving runtime or model",
      async () => {
        const { snapshot } = await fixture.failedReview(),
          before = runtimeCalls,
          count = fixture.callCount(),
          guards = guardCalls;
        revoked = true;
        try {
          await assert.rejects(
            tools.recover_factory_check.execute!(
              { binding: factoryBinding(snapshot.task) },
              call,
            ) as Promise<unknown>,
            /coordinatorExpiredOrLeaseLost/,
          );
        } finally {
          revoked = false;
        }
        assert.equal(guardCalls, guards + 1);
        assert.equal(runtimeCalls, before);
        assert.equal(fixture.callCount(), count);
      },
    );
  } finally {
    for (const handle of handles.reverse()) handle.restore();
    flags.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
  }
}
