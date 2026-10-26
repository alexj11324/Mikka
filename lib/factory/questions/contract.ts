import { createHash } from "node:crypto";
import { z } from "zod";
import type { QuestionKind, QuestionStatus } from "./schema";
import { factoryEventId } from "../event-id";

export * from "./schema";

export function legacyQuestionId(runId: string): string {
  return factoryEventId("execution-question", z.uuid().parse(runId));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

/** Hash canonical parsed data, including authenticated actor/source, not transport key order. */
export function questionFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function orchestratorMayAnswer(kind: QuestionKind): boolean {
  return kind === "context";
}

export function questionClosed(status: QuestionStatus): boolean {
  return ["resolved", "blocked", "cancelled", "expired", "superseded"].includes(
    status,
  );
}
