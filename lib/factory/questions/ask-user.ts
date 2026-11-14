import { z } from "zod";
import { FactoryError } from "../contract";
import { maskFactoryNote } from "../note-mask";
import { PENDING_QUESTION_STATUSES } from "./schema";

export { PENDING_QUESTION_STATUSES };

/** Claude Code AskUserQuestion `header` is a short chip label (max 12 chars). */
const HEADERS: Record<string, string> = { context: "Context", decision: "Decision", permission: "Permission", external: "External" };

type QuestionView = {
  id: string; kind: string; question: string; context?: string | null; options: string[] | null;
  status: string; taskId: string; originRunId: string; continuationRunId?: string | null;
  reference: unknown; createdAt?: Date | string;
  answerId?: string | null; answerSource?: string | null; answer?: unknown;
};

/** One pending Factory question in AskUserQuestion shape plus Mikka metadata.
 * The question text is kept as asked (`originalText`), with secrets masked; options become
 * `{label, description, value}` with an empty description (Factory stores labels only).
 * `value` is the option's stable identifier: it currently equals `label` and
 * switches to a real option id if options get one later. */
export function toAskUserQuestion(q: QuestionView) {
  const stored = q.answerSource === "human" && q.answerId && q.continuationRunId
    ? z.object({ source: z.literal("human"), input: z.object({ answerId: z.literal(q.answerId), text: z.string().min(1) }) }).safeParse(q.answer)
    : undefined;
  return {
    ...(stored?.success ? { recordedAnswer: maskFactoryNote(stored.data.input.text) } : {}),
    questionId: q.id,
    taskId: q.taskId,
    runId: q.originRunId,
    status: q.status,
    type: q.kind,
    // Same human/model text as the ledger notes: masked before it leaves the server.
    originalText: maskFactoryNote(q.question),
    question: maskFactoryNote(q.question),
    header: HEADERS[q.kind] ?? q.kind.slice(0, 12),
    options: (q.options ?? []).map((label) => ({ label, description: "", value: label })),
    multiSelect: false,
    reference: q.reference,
  };
}

const query = z.union([
  z.object({ taskId: z.uuid(), runId: z.undefined() }),
  z.object({ runId: z.uuid(), taskId: z.undefined() }),
  z.object({ taskId: z.undefined(), runId: z.undefined() }),
]);

export async function handleFactoryQuestionList(
  service: { pending(userId: string, runId?: string, readScope?: "bot" | "user"): Promise<unknown[]>; list(userId: string, taskId: string, readScope?: "bot" | "user", view?: "history" | "pending"): Promise<unknown[]> },
  request: { actor: { userId: string } | null; authorization: string | null; method: string; url: string },
) {
  if (!request.actor || request.authorization) return { status: 401, body: { error: "authRequired" } };
  if (request.method !== "GET") return { status: 405, body: { error: "methodNotAllowed" } };
  const params = new URL(request.url).searchParams;
  const parsed = query.safeParse({ taskId: params.get("taskId") ?? undefined, runId: params.get("runId") ?? undefined });
  if (!parsed.success) return { status: 422, body: { error: "factoryInvalid" } };
  const { taskId, runId } = parsed.data;
  try {
    // This authenticated collection is user-wide; model/runtime readers keep their default Bot scope.
    const rows = (taskId ? await service.list(request.actor.userId, taskId.toLowerCase(), "user", "pending") : await service.pending(request.actor.userId, runId?.toLowerCase(), "user")) as QuestionView[];
    // runId (origin or continuation) is filtered in SQL by `pending`, before its 50-row cap.
    const questions = rows
      .filter((q) => (PENDING_QUESTION_STATUSES as readonly string[]).includes(q.status))
      .map(toAskUserQuestion);
    return { status: 200, body: { questions } };
  } catch (error) {
    if (!(error instanceof FactoryError)) throw error;
    return { status: error.code === "factoryNotFound" ? 404 : error.code === "factoryInvalid" ? 422 : 409, body: { error: error.code } };
  }
}
