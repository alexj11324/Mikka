import { z } from "zod";
import { routeSchema, bindingSchema, changeSchema } from "./contract";

export const intakeSchema = routeSchema
  .omit({ issueId: true, eventId: true })
  .extend({
    sourceEventId: z.uuid().transform((value) => value.toLowerCase()),
    title: z.string().trim().min(1).max(200),
    body: z.string().max(50_000).default(""),
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
    eventId: z.uuid(),
    action: z.enum(["cancel", "revoke"]),
    reason: z.string().trim().min(1).max(4000),
  })
  .strict();
export type StopInput = z.infer<typeof stopInput>;
