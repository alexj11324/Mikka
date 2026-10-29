import { z } from "zod";
import { bindingSchema } from "./contract";

export const factoryDispatchSchema = z
  .object({
    binding: bindingSchema,
    agentId: z.uuid(),
    deviceRepoId: z.uuid(),
    note: z.string().trim().max(10000).optional(),
  })
  .strict();
export type FactoryDispatchInput = z.infer<typeof factoryDispatchSchema>;
