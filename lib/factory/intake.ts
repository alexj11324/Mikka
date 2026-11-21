import { z } from "zod";
import { taskBriefGuidance } from "../coordinator/issue-input";
import { routeSchema, bindingSchema, changeSchema } from "./contract";

export const intakeSchema = routeSchema
  .omit({ issueId: true, eventId: true })
  .extend({
    sourceEventId: z.uuid().transform((value) => value.toLowerCase()),
    title: z.string().trim().min(1).max(200),
    body: z.string().max(50_000).default("").describe(taskBriefGuidance),
  })
  .strict();
export const resolveInput = z
  .object({
    binding: bindingSchema,
    eventId: z.uuid(),
    change: changeSchema.options[1],
  })
  .strict();
export type IntakeInput = z.infer<typeof intakeSchema>;
export type ResolveInput = z.infer<typeof resolveInput>;
/** One source request creates one issue. Replays keep the original frozen body. */
export async function intakeRequest(
  input: z.infer<typeof intakeSchema>,
  deps: {
    source: (id: string) => Promise<unknown>;
    create: (
      body: { title: string; body: string },
      key: string,
    ) => Promise<{ id?: string; error?: string }>;
    route: (input: unknown) => Promise<unknown>;
  },
) {
  const parsed = intakeSchema.parse(input);
  await deps.source(parsed.sourceEventId);
  const { title, body, ...route } = parsed;
  const issue = await deps.create(
    { title, body },
    `factory-intake:${parsed.sourceEventId}`,
  );
  if (!issue.id) return issue;
  // The existing issue receipt survives interruption here; retry reuses the issue.
  return deps.route({
    ...route,
    issueId: issue.id,
    eventId: parsed.sourceEventId,
  });
}

export const stopInput = z
  .object({
    binding: bindingSchema,
    eventId: z.uuid().describe("A new UUID for this cancel or revoke request. Do not use the task route eventId or an ID from a different action. Reuse this UUID only when retrying this exact request with the same binding, action, and reason."),
    action: z.enum(["cancel", "revoke"]),
    reason: z.string().trim().min(1).max(4000),
  })
  .strict();
export type StopInput = z.infer<typeof stopInput>;
