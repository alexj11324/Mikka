import { NextResponse } from "next/server";
import { auth } from "@/lib/api-auth";
import { factoryRouteEnabled, handleFactoryRoute } from "@/lib/factory/route-http";
import { issueMutationsEnabled } from "@/lib/coordinator/issue-tools-enabled";

export const dynamic = "force-dynamic";
/** POST /api/factory/tasks/route: non-LLM routing (BE-10b); contract in lib/factory/route-http.ts. */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  const result = await handleFactoryRoute(
    async () => {
      const { factoryRuntimeForBot } = await import("@/lib/factory/runtime");
      const { store } = factoryRuntimeForBot(null);
      return (userId, input) => store.route(userId, input);
    },
    {
      userId: session?.user?.id ?? null,
      origin: request.headers.get("origin"),
      url: request.url,
      body: await request.json().catch(() => null),
      enabled: factoryRouteEnabled(issueMutationsEnabled()),
    },
  );
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "private, no-store" } });
}
