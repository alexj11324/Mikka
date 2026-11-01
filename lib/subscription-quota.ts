import { quotaWindowSchema } from "@mikka/protocol";
import { z } from "zod";

/** A subscription is out of quota while an account-wide window is fully used and has not reset. */
export function quotaExhausted(quota: unknown, now = Date.now()) {
  const parsed = z.object({ windows: z.array(quotaWindowSchema) }).safeParse(quota);
  if (!parsed.success) return false;
  return parsed.data.windows.some(
    (window) =>
      !window.model &&
      window.used >= 1 &&
      (!window.resetsAt || !(Date.parse(window.resetsAt) <= now)),
  );
}

/** When the soonest used-up account-wide window resets, or null when none says. */
export function quotaResetsAt(quota: unknown, now = Date.now()): string | null {
  const parsed = z.object({ windows: z.array(quotaWindowSchema) }).safeParse(quota);
  if (!parsed.success) return null;
  const times = parsed.data.windows
    .filter((window) => !window.model && window.used >= 1 && window.resetsAt && Date.parse(window.resetsAt) > now)
    .map((window) => window.resetsAt!)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return times[0] ?? null;
}
