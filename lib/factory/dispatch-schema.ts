import { z } from "zod";
import { bindingSchema } from "./contract";
import { agentProfileReferenceSchema } from "./agent-profile-reference";

export const factoryDispatchSchema = z
  .object({
    binding: bindingSchema,
    profileId: agentProfileReferenceSchema.optional(),
    agentId: z.uuid().transform(value => value.toLowerCase()),
    deviceRepoId: z.uuid().transform(value => value.toLowerCase()),
    note: z.string().trim().max(10000).optional(),
  })
  .strict();
export type FactoryDispatchInput = z.infer<typeof factoryDispatchSchema>;
