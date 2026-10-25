import { createHash } from "node:crypto";
/** A deterministic UUID for one operation on one persisted entity, never a new queue. */
export function factoryEventId(operation: string, entityId: string): string {
  const hex = createHash("sha1")
    .update(JSON.stringify(["mikka-factory-v1", operation, entityId]))
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
