import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { z } from "zod";
import { documentSchema, PolicyError } from "./contract";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
export const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const payloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaceId: z.uuid(),
  version: z.number().int().positive(),
  document: documentSchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const signedPolicySchema = z.strictObject({
  payload: payloadSchema,
  keyId: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export type SignedPolicy = z.infer<typeof signedPolicySchema>;
/** Derived signing key is domain separated; no new credential or persisted secret. Rotation requires republishing enrolled policies. */
export function policySigner(secret: string) {
  if (secret.length < 32)
    throw new PolicyError("policySigningUnavailable", 503);
  const seed = createHash("sha256")
    .update(`mikka-policy-signing-v1\0${secret}`)
    .digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  const keyId = createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
  return {
    publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
    keyId,
    sign(
      workspaceId: string,
      version: number,
      document: z.infer<typeof documentSchema>,
    ): SignedPolicy {
      const payload = payloadSchema.parse({
        schemaVersion: 1,
        workspaceId,
        version,
        document,
        hash: digest(document),
      });
      return {
        payload,
        keyId,
        signature: sign(
          null,
          Buffer.from(canonical(payload)),
          privateKey,
        ).toString("base64url"),
      };
    },
    verify(input: unknown): SignedPolicy {
      const parsed = signedPolicySchema.safeParse(input);
      if (
        !parsed.success ||
        parsed.data.keyId !== keyId ||
        parsed.data.payload.hash !== digest(parsed.data.payload.document) ||
        !verify(
          null,
          Buffer.from(canonical(parsed.data.payload)),
          publicKey,
          Buffer.from(parsed.data.signature, "base64url"),
        )
      )
        throw new PolicyError("policySignatureInvalid", 403);
      return parsed.data;
    },
  };
}
export type PolicySigner = ReturnType<typeof policySigner>;
