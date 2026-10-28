// Isolated PG suite only. All model transport, image bytes and native actors
// are fixtures; registered tool/step/runtime/store/decision code is real.
import assert from "node:assert/strict";
import { mock, type TestContext } from "node:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
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
    failedReview: () => Promise<{ snapshot: FactorySnapshot; runId: string }>;
    png: string;
    sha: string;
    modelInvoke: NonNullable<FactoryCheckRecoveryDependencies["invoke"]>;
    callCount: () => number;
    chooseRetry: () => void;
    latestRequest: () => unknown;
  },
) {
  const { db } = fixture,
    currentTx = new AsyncLocalStorage<PoolClient>();
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
    "MIKKA_ISSUE_TOOLS_ENABLED",
    "MIKKA_FACTORY_ROUTING_ENABLED",
    "MIKKA_FACTORY_LIFECYCLE_ENABLED",
  ] as const;
  const previous = flags.map((key) => process.env[key]);
  try {
    for (const key of flags) process.env[key] = "1";
    stub("../../lib/db/index.ts", {
      db: null,
      pool: db,
      withDatabaseClient: (tx: PoolClient, fn: () => Promise<unknown>) =>
        currentTx.run(tx, fn),
    });
    stub("../../lib/issue-access.ts", {
      requireUser: unused,
      requireIssueAccess: unused,
      issueForUser: async (user: string, issue: string) =>
        (
          await (currentTx.getStore() ?? db).query(
            'SELECT id FROM issues WHERE id=$1 AND "userId"=$2',
            [issue, user],
          )
        ).rows[0] ?? null,
    });
    stub("../../lib/agent-runs.ts", {
      addRunMessage: unused,
      queueRun: unused,
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
    stub("../../lib/issue-visibility.ts", { issueVisibility: unused });
    stub("../../lib/device-link.ts", { DEVICE_ONLINE_WINDOW_MS: 60000 });
    stub("../../lib/search/index.ts", { webSearch: unused });
    stub("../../lib/composio.ts", { runComposioAction: unused });
    stub("../../lib/pending-action-store.ts", { proposeAction: unused });
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
          { invoke: fixture.modelInvoke, collectImages },
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
    const tools = registry.coordinatorTools("owner", null, scope, {
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
