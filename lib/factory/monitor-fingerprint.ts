import { createHash } from "node:crypto";

/** Only the digest leaves this function. Never persist or echo raw failure output. */
export function normalizeMonitorFailure(value: string): string {
  return value
    .slice(0, 20_000)
    .replace(/https?:\/\/[^\s)]+/gi, "<url>")
    .replace(
      /(?:bearer\s+|(?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi,
      "<secret>",
    )
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "<email>")
    .replace(/\b[a-f0-9]{8}-[a-f0-9-]{27,}\b/gi, "<id>")
    .replace(/\b[a-f0-9]{32,}\b/gi, "<hash>")
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?\b/g, "<time>")
    .replace(/\bHTTP\s+([45]\d{2})\b/gi, "HTTP_STATUS_$1")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function monitorFingerprint(input: {
  userId: string;
  workspaceKey: string;
  repository: string;
  environment: string;
  component: string;
  check: string;
  failure: string;
}) {
  const checkKey = digest([
    "factory-monitor-v1",
    input.userId,
    input.workspaceKey,
    input.repository,
    input.environment,
    input.component,
    input.check,
  ]);
  return {
    checkKey,
    fingerprint: digest([checkKey, normalizeMonitorFailure(input.failure)]),
  };
}
