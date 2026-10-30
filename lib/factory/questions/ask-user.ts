import { z } from "zod";
import { FactoryError } from "../contract";
import type { createFactoryQuestions } from "./store";

/** Statuses a user can still act on (same set as `pending`). */
export const PENDING_QUESTION_STATUSES = ["open", "waiting_user", "resuming", "blocked"] as const;

/** Claude Code AskUserQuestion `header` is a short chip label (max 12 chars). */
const HEADERS: Record<string, string> = { context: "Context", decision: "Decision", permission: "Permission", external: "External" };

type QuestionView = {
  id: string; kind: string; question: string; context?: string | null; options: string[] | null;
  status: string; taskId: string; originRunId: string; continuationRunId?: string | null;
  reference: unknown; createdAt?: Date | string;
};

/** One pending Factory question in AskUserQuestion shape plus Mikka metadata.
 * The question text is kept verbatim (`originalText`); options become
 * `{label, description}` with an empty description (Factory stores labels only). */
export function toAskUserQuestion(q: QuestionView) {
  return {
    questionId: q.id,
    taskId: q.taskId,
    runId: q.originRunId,
    status: q.status,
    type: q.kind,
    originalText: q.question,
    question: q.question,
    header: HEADERS[q.kind] ?? q.kind.slice(0, 12),
    options: (q.options ?? []).map((label) => ({ label, description: "" })),
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
  service: Pick<ReturnType<typeof createFactoryQuestions>, "pending" | "list">,
  request: { actor: { userId: string } | null; authorization: string | null; method: string; url: string },
) {
  if (!request.actor || request.authorization) return { status: 401, body: { error: "authRequired" } };
  if (request.method !== "GET") return { status: 405, body: { error: "methodNotAllowed" } };
  const params = new URL(request.url).searchParams;
  const parsed = query.safeParse({ taskId: params.get("taskId") ?? undefined, runId: params.get("runId") ?? undefined });
  if (!parsed.success) return { status: 422, body: { error: "factoryInvalid" } };
  const { taskId, runId } = parsed.data;
  try {
    const rows = (taskId ? await service.list(request.actor.userId, taskId.toLowerCase()) : await service.pending(request.actor.userId)) as QuestionView[];
    const run = runId?.toLowerCase();
    const questions = rows
      .filter((q) => (PENDING_QUESTION_STATUSES as readonly string[]).includes(q.status))
      .filter((q) => !run || q.originRunId === run || q.continuationRunId === run)
      .map(toAskUserQuestion);
    return { status: 200, body: { questions } };
  } catch (error) {
    if (!(error instanceof FactoryError)) throw error;
    return { status: error.code === "factoryNotFound" ? 404 : error.code === "factoryInvalid" ? 422 : 409, body: { error: error.code } };
  }
}
