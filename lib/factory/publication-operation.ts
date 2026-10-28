import { z } from "zod";
import {
  bindingSchema,
  candidateSchema,
  FactoryError,
} from "./approval-contract";
import { digest } from "./evidence";

const authorization = z
  .object({
    approvalId: z.uuid(),
    ownerId: z.string().min(1),
    humanSessionId: z.string().min(1),
    expiresAt: z.iso.datetime(),
    binding: bindingSchema,
    eventId: z.uuid(),
    action: z.enum(["deploy_preview", "deploy_production", "merge"]),
    target: z.string().min(1),
    targetEnvironment: z.string().min(1),
  })
  .strict();
export interface PublicationInput {
  idempotencyKey: string;
  candidate: z.infer<typeof candidateSchema>;
  authorization?: z.infer<typeof authorization>;
  /** Trusted service hook under the task/session locks, immediately before POST. */
  beforeCreate?: () => Promise<void>;
}
export function publicationBindingHash(input: PublicationInput) {
  const a = authorization.safeParse(input.authorization);
  if (
    !a.success ||
    !a.data.binding.candidateId ||
    !z.uuid().safeParse(input.idempotencyKey).success ||
    !candidateSchema.safeParse(input.candidate).success
  )
    throw new FactoryError("factoryPublicationBindingRequired");
  return digest({
    publicationId: input.idempotencyKey,
    candidate: input.candidate,
    authorization: a.data,
  });
}
/** Trusted adapter checkpoint, never accepted from a browser/tool response. */
export class PublicationDeferred extends FactoryError {
  constructor(
    public publicationId: string,
    public state: "pending" | "uncertain",
    public checkpoint: unknown = null,
  ) {
    super(
      state === "pending"
        ? "factoryPublicationPending"
        : "factoryPublicationUncertain",
    );
  }
}
