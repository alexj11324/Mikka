import { humanQuestionAnswerSchema } from "./contract";
import { FactoryError } from "../contract";
import type { createFactoryQuestions } from "./store";

export async function handleFactoryQuestion(
  service: ReturnType<typeof createFactoryQuestions>,
  request: {
    actor: { userId: string; sessionId: string } | null;
    authorization: string | null;
    method: string;
    questionId: string;
    origin: string | null;
    url: string;
    body?: unknown;
  },
) {
  if (!request.actor || request.authorization)
    return { status: 401, body: { error: "authRequired" } };
  try {
    if (request.method === "GET")
      return {
        status: 200,
        body: await service.read(request.actor.userId, request.questionId),
      };
    if (request.method !== "POST")
      return { status: 405, body: { error: "methodNotAllowed" } };
    try {
      if (new URL(request.origin ?? "").origin !== new URL(request.url).origin)
        throw new Error("origin");
    } catch {
      return { status: 403, body: { error: "originRejected" } };
    }
    const parsed = humanQuestionAnswerSchema.safeParse(request.body);
    if (
      !parsed.success ||
      parsed.data.reference.questionId !== request.questionId
    )
      return { status: 422, body: { error: "factoryInvalid" } };
    return {
      status: 200,
      body: await service.answer(
        { source: "human", ...request.actor },
        parsed.data,
      ),
    };
  } catch (error) {
    if (!(error instanceof FactoryError)) throw error;
    return {
      status:
        error.code === "factoryNotFound"
          ? 404
          : error.code === "factoryInvalid"
            ? 422
            : 409,
      body: { error: error.code },
    };
  }
}
