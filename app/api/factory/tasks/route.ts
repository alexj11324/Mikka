import { factoryWorkspaceReader } from '@/lib/factory/workspace-reader';
import { taskReaderScope } from '@/lib/task-workspace';
import { factoryWorkspaceResponse } from '@/lib/factory/workspace-http';
import { actAs } from "@/lib/acting-user";
import { NextResponse } from "next/server";
import { z } from "zod";
import { issueForUser } from "@/lib/issue-access";
import { singleFlight } from "@/lib/single-flight";
import { auth } from "@/lib/api-auth";
import { handleFactoryList } from "@/lib/factory/http";
import { factoryHumanStore } from "@/lib/factory/server";
import { factoryDispatchEnabled, handleFactoryDispatch } from "@/lib/factory/dispatch-http";
import { issueMutationsEnabled } from "@/lib/coordinator/issue-tools-enabled";
import { factoryDispatchSchema } from '@/lib/factory/dispatch';

export const dynamic = "force-dynamic";
/** GET /api/factory/tasks?issueId=...: session-owned task discovery, no writes. */
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  const scoped = () => factoryWorkspaceResponse(session?.user?.id, async () => {
    const issueId = new URL(request.url).searchParams.get("issueId");
    const userId = session?.user?.id ?? null;
    // The list holds only this user's own tasks of this issue. Each request checks
    // its own access to the issue, then identical concurrent requests share one read.
    const reader = userId ? await factoryWorkspaceReader(userId) : null;
    const workspaceId = reader ? taskReaderScope(reader).workspaceId : undefined;
    const readable = reader && workspaceId && issueId && z.uuid().safeParse(issueId).success && Boolean(await issueForUser(reader, issueId, false));
    const list = () => handleFactoryList(factoryHumanStore, { userId, issueId });
    const result = readable ? await singleFlight(["/api/factory/tasks", userId, workspaceId, issueId], list) : await list();
    // A successful store read reauthorized the bound issue inside this exact
    // Workspace lease. Its live channel uses that same immutable tenant.
    const liveWorkspaceId = result.status === 200 ? workspaceId ?? null : null;
    return NextResponse.json(result.status === 200 ? { ...(result.body as Record<string, unknown>), liveWorkspaceId } : result.body, {
      status: result.status,
      headers: { "Cache-Control": "private, no-store" },
    });
  });
  return session?.user ? actAs(session.user, scoped) : scoped();
}
/**
 * POST /api/factory/tasks: dispatch the current attempt of a routed task
 * without an LLM. Body: { binding, agentId, deviceRepoId, note? }.
 * 201 new run, 200 idempotent replay of the same attempt (keyed on the binding;
 * same binding + different body/note -> 409 factoryReplayMismatch).
 */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  const scoped = () => factoryWorkspaceResponse(session?.user?.id, async () => {
    const result = await handleFactoryDispatch(
      async () => {
        const { factoryLifecycleEnabled, factoryRuntimeForBot } = await import("@/lib/factory/runtime");
        if (!factoryLifecycleEnabled()) throw new (await import("@/lib/factory/contract")).FactoryError("factoryLifecycleUnavailable");
        return async (userId, raw) => {
          const parsed = factoryDispatchSchema.safeParse(raw);
          if (!parsed.success) throw new (await import('@/lib/factory/contract')).FactoryError('factoryInvalid');
          const { task } = await factoryHumanStore.read(userId, parsed.data.binding.taskId);
          return factoryRuntimeForBot(task.botId).dispatch(userId, parsed.data);
        };
      },
      {
        userId: session?.user?.id ?? null,
        origin: request.headers.get("origin"),
        url: request.url,
        body: await request.json().catch(() => null),
        enabled: factoryDispatchEnabled(issueMutationsEnabled()),
      },
    );
    return NextResponse.json(result.body, {
      status: result.status,
      headers: { "Cache-Control": "private, no-store" },
    });
  });
  return session?.user ? actAs(session.user, scoped) : scoped();
}
