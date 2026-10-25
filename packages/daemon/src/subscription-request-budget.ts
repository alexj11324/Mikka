// Optional operator-owned acceptance budget. Never supplied by a model/request.
// Reservations are durable before transport: errors/uncertain outcomes consume
// a slot. The files stay outside the native container and survive daemon restart.
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { NativeBrokerRequest, RunAssignment } from "@mikka/protocol";
export const subscriptionRequestBudget = z
  .object({
    id: z.uuid(),
    ownerId: z.string().min(1).max(128),
    workspaceId: z.uuid(),
    consumerId: z.uuid(),
    deviceId: z.uuid(),
    route: z.enum(["claude_code_cli", "codex_cli"]),
    modelId: z.string().min(1).max(128),
    expiresAt: z.iso.datetime(),
    maxRequests: z.literal(2),
    maxOutputTokens: z.literal(256),
  })
  .strict();
export type SubscriptionRequestBudget = z.infer<
  typeof subscriptionRequestBudget
>;
const refused = () => new Error("subscription_request_budget_refused");
function createDurable(file: string, value: string, dir: string) {
  const fd = openSync(file, "wx", 0o600);
  try {
    writeSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const parent = openSync(dir, "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
export function createSubscriptionRequestBudget(
  root: string,
  input: SubscriptionRequestBudget,
  now = () => Date.now(),
) {
  const policy = subscriptionRequestBudget.parse(input),
    expires = Date.parse(policy.expiresAt);
  if (expires <= now() || expires > now() + 3600000) throw refused();
  const dir = join(root, "native-request-budgets", policy.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const digest = createHash("sha256")
      .update(JSON.stringify(policy))
      .digest("hex"),
    manifest = join(dir, "manifest");
  try {
    createDurable(manifest, digest, dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw refused();
  }
  if (readFileSync(manifest, "utf8") !== digest) throw refused();
  return (
    assignment: RunAssignment,
    request: NativeBrokerRequest,
  ): NativeBrokerRequest => {
    const binding = assignment.subscriptionBinding;
    if (
      now() >= expires ||
      !binding ||
      assignment.deviceId !== policy.deviceId ||
      binding.ownerId !== policy.ownerId ||
      binding.workspaceId !== policy.workspaceId ||
      binding.consumerId !== policy.consumerId ||
      binding.route !== policy.route ||
      assignment.model !== policy.modelId
    )
      throw refused();
    const expected =
      policy.route === "claude_code_cli"
        ? ["/v1/messages", "/v1/messages?beta=true"]
        : ["/responses"];
    if (
      !expected.includes(request.path) ||
      !request.body ||
      typeof request.body !== "object" ||
      Array.isArray(request.body)
    )
      throw refused();
    const body = { ...request.body } as Record<string, unknown>;
    if (body.model !== policy.modelId) throw refused();
    const field =
      policy.route === "claude_code_cli" ? "max_tokens" : "max_output_tokens";
    if (
      body[field] !== undefined &&
      (!Number.isSafeInteger(body[field]) || (body[field] as number) < 1)
    )
      throw refused();
    body[field] = Math.min(
      (body[field] as number | undefined) ?? policy.maxOutputTokens,
      policy.maxOutputTokens,
    );
    // Never reopen a reservation, even after transport failure or process crash.
    for (let index = 0; index < policy.maxRequests; index++) {
      const slot = join(dir, `request-${index}`);
      if (existsSync(slot)) continue;
      try {
        createDurable(slot, assignment.runId, dir);
        return { ...request, body };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw refused();
      }
    }
    throw refused();
  };
}
