import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { factoryQuestions } from "@/lib/factory/server";
import { factoryBrowserHuman } from "@/lib/factory/browser-human";
import { handleFactoryQuestion } from "@/lib/factory/questions/http";

export const dynamic = "force-dynamic";
async function respond(
  request: Request,
  context: { params: Promise<{ questionId: string }> },
) {
  const actor = await factoryBrowserHuman(request, (headers) =>
    auth.api.getSession({ headers, query: { disableCookieCache: true } }),
  );
  const { questionId } = await context.params;
  const result = await handleFactoryQuestion(factoryQuestions, {
    actor,
    authorization: request.headers.get("authorization"),
    method: request.method,
    questionId,
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
