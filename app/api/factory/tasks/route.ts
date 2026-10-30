import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { handleFactoryList } from "@/lib/factory/http";
import { factoryStore } from "@/lib/factory/server";
import { handleFactoryDispatch } from "@/lib/factory/dispatch-http";
import { issueMutationsEnabled } from "@/lib/coordinator/issue-tools-enabled";

export const dynamic = "force-dynamic";
/** GET /api/factory/tasks?issueId=...: session-owned task discovery, no writes. */
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  const result = await handleFactoryList(factoryStore, {
    userId: session?.user?.id ?? null,
    issueId: new URL(request.url).searchParams.get("issueId"),
  });
  return NextResponse.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
/**
 * POST /api/factory/tasks: dispatch the current attempt of a routed task
 * without an LLM. Body: { binding, agentId, deviceRepoId, note? }.
 * 201 new run, 200 idempotent replay of the same attempt.
 */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  const result = await handleFactoryDispatch(
    async () => {
      const { factoryLifecycleEnabled, factoryRuntimeForBot } = await import("@/lib/factory/runtime");
      if (!factoryLifecycleEnabled()) throw new (await import("@/lib/factory/contract")).FactoryError("factoryLifecycleUnavailable");
      return factoryRuntimeForBot(null).dispatch;
    },
    {
      userId: session?.user?.id ?? null,
      origin: request.headers.get("origin"),
      url: request.url,
      body: await request.json().catch(() => null),
      enabled:
        issueMutationsEnabled() &&
        process.env.MIKKA_FACTORY_ROUTING_ENABLED === "1" &&
        process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED === "1",
    },
  );
  return NextResponse.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
