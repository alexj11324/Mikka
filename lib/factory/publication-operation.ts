import { z } from "zod";
import {
  bindingSchema,
  candidateSchema,
  FactoryError,
} from "./approval-contract";
import { publicationAction } from "./approval-contract";
import { digest } from "./evidence";
import { verifiedFactoryDecision } from "./policy-authorization";

const baseAuthorization = z
  .object({
    approvalId: z.uuid(),
    ownerId: z.string().min(1),
    expiresAt: z.iso.datetime(),
    binding: bindingSchema,
    eventId: z.uuid(),
    action: publicationAction,
    target: z.string().min(1),
    targetEnvironment: z.string().min(1),
  })
  .strict();
const authorization = z.union([
  baseAuthorization
    .extend({
      policy: z
        .object({
          credentialId: z.string().min(1),
          issuer: z.string().min(1),
          policyId: z.string().min(1),
          policyRevision: z.string().min(1),
          scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
          decisionDigest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    })
    .strict(),
  // Historical receipts only. New Factory grants use the existing policy proof.
  baseAuthorization.extend({ humanSessionId: z.string().min(1) }).strict(),
]);
export function publicationPolicyBinding(value: unknown) {
  const d = verifiedFactoryDecision.parse(value);
  return {
    credentialId: d.credentialId,
    issuer: d.issuer,
    policyId: d.policyId,
    policyRevision: d.policyRevision,
    scopeDigest: d.scopeDigest,
    decisionDigest: digest(d),
  };
}
export interface PublicationInput {
  idempotencyKey: string;
  candidate: z.infer<typeof candidateSchema>;
  authorization?: z.infer<typeof authorization>;
  /** Trusted service hook under task/permission locks, immediately before POST. */
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
