import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { handleFactoryList } from "@/lib/factory/http";
import { factoryStore } from "@/lib/factory/server";

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
