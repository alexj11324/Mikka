import type { HarnessInfo } from "@mikka/protocol/harness";

export interface ExecutionRule {
  id: string;
  label: string | null;
  place: string;
  harness: string;
  model: string;
  position: number;
}
export interface ExecutionDevice {
  id: string;
  online: boolean;
  enabled: boolean;
  harnesses: HarnessInfo[];
}
export type ExecutionFallbacks = {
  whenDeviceOffline: "wait" | "cloud";
  whenQuotaExhausted: "stop" | "switchAccount";
};
export const DEFAULT_EXECUTION_FALLBACKS: ExecutionFallbacks = {
  whenDeviceOffline: "wait",
  whenQuotaExhausted: "stop",
};
export type ExecutionResolution =
  { place: string; harness: string; model: string } | { waitFor: string };

export function resolveExecution(
  issueLabels: readonly string[],
  rules: readonly ExecutionRule[],
  devices: readonly ExecutionDevice[],
  fallbacks: ExecutionFallbacks = DEFAULT_EXECUTION_FALLBACKS,
): ExecutionResolution {
  const rule =
    [...rules]
      .filter((r) => r.label !== null)
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .find((r) => issueLabels.includes(r.label!)) ??
    rules.find((r) => r.label === null);
  if (!rule) throw new Error("executionModelUnknown");
  if ([rule.place, rule.harness, rule.model].some((v) => !v || v === "auto"))
    throw new Error("executionAutoNotAllowed");
  if (rule.place === "cloud")
    return { place: "cloud", harness: rule.harness, model: rule.model };
  const device = devices.find((d) => d.id === rule.place);
  if (!device?.online || !device.enabled) {
    if (fallbacks.whenDeviceOffline === "cloud")
      return {
        place: "cloud",
        harness: rule.harness,
        model:
          device?.harnesses
            .find((h) => h.harness === rule.harness)
            ?.modelSlots?.find((s) => s.slot === rule.model)?.model ??
          rule.model,
      };
    return { waitFor: rule.place };
  }
  const harness = device.harnesses.find(
    (h) => h.installed && h.harness === rule.harness,
  );
  if (!harness) throw new Error("agentHarnessMissing");
  // The persisted slot is interpreted by this install, never by a server constant.
  const slot = harness.modelSlots?.find((s) => s.slot === rule.model);
  const model = slot?.model ?? rule.model;
  if (harness.modelSlots?.some((s) => s.slot === rule.model) && !slot?.model)
    throw new Error("executionModelUnknown");
  return { place: device.id, harness: rule.harness, model };
}
