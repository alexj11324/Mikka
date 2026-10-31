import { NextResponse } from "next/server";
import { auth } from "@/lib/api-auth";
import { handleFactory } from "@/lib/factory/http";
import { factoryStore } from "@/lib/factory/server";

export const dynamic = "force-dynamic";
async function respond(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  const { taskId } = await context.params;
  const result = await handleFactory(factoryStore, {
    userId: session?.user?.id ?? null,
    method: request.method,
    taskId,
    origin: request.headers.get("origin"),
    url: request.url,
    body:
      request.method === "POST"
        ? await request.json().catch(() => null)
        : undefined,
  });
  return NextResponse.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
export const GET = respond;
export const POST = respond;
