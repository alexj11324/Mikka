import { NextResponse } from "next/server";
import { auth } from "@/lib/api-auth";
import { handleFactoryList } from "@/lib/factory/http";
import { factoryHumanStore } from "@/lib/factory/server";
import { factoryDispatchEnabled, handleFactoryDispatch } from "@/lib/factory/dispatch-http";
import { issueMutationsEnabled } from "@/lib/coordinator/issue-tools-enabled";
import { factoryDispatchSchema } from '@/lib/factory/dispatch';
import { pool } from '@/lib/db';
import { workspacePool } from '@/lib/workspace-db';
import { factoryIssueLiveScope } from '@/lib/live/factory';

export const dynamic = "force-dynamic";
/** GET /api/factory/tasks?issueId=...: session-owned task discovery, no writes. */
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  const issueId = new URL(request.url).searchParams.get("issueId");
  const result = await handleFactoryList(factoryHumanStore, {
    userId: session?.user?.id ?? null,
    issueId,
  });
  let liveWorkspaceId: string | null = null;
  if (result.status === 200 && session?.user && issueId) {
    try { liveWorkspaceId = (await factoryIssueLiveScope(pool, workspacePool, issueId, session.user.id))?.workspaceId ?? null; }
    catch { console.warn('[live] Factory list scope unavailable'); }
  }
  return NextResponse.json(result.status === 200 ? { ...(result.body as Record<string, unknown>), liveWorkspaceId } : result.body, {
    status: result.status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
/**
 * POST /api/factory/tasks: dispatch the current attempt of a routed task
 * without an LLM. Body: { binding, agentId, deviceRepoId, note? }.
 * 201 new run, 200 idempotent replay of the same attempt (keyed on the binding;
 * same binding + different body/note -> 409 factoryReplayMismatch).
 */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
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
}
