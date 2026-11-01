import { harnessForModel, type HarnessInfo } from "@mikka/protocol/harness";

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

/**
 * The Agent that runs a thread's model (orchestration.md §3): GPT/OpenAI on
 * Codex, every other model on Claude Code. A model slot ("opus", "default")
 * or a model an Agent reported names a model only within that Agent, so it
 * keeps the rule's Agent.
 */
export function agentFor(model: string, ruleHarness: string, slotOf: (harness: string) => boolean): string {
  return slotOf(ruleHarness) ? ruleHarness : harnessForModel(model);
}

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
  // The rule's Agent knows this model: its default slot, a slot of it, or a model it reported on this device.
  const slotOn = (candidates: readonly ExecutionDevice[]) => (harness: string) =>
    candidates.some((d) => d.harnesses.some((h) => h.harness === harness && (h.defaultModelSlot === rule.model ||
      h.modelSlots?.some((s) => s.slot === rule.model) || h.models?.includes(rule.model))));
  if (rule.place === "cloud")
    return { place: "cloud", harness: agentFor(rule.model, rule.harness, slotOn(devices)), model: rule.model };
  const device = devices.find((d) => d.id === rule.place);
  const agent = agentFor(rule.model, rule.harness, slotOn(device ? [device] : []));
  if (!device?.online || !device.enabled) {
    if (fallbacks.whenDeviceOffline === "cloud")
      return {
        place: "cloud",
        harness: agent,
        model:
          device?.harnesses
            .find((h) => h.harness === agent)
            ?.modelSlots?.find((s) => s.slot === rule.model)?.model ??
          rule.model,
      };
    return { waitFor: rule.place };
  }
  const harness = device.harnesses.find(
    (h) => h.installed && h.harness === agent,
  );
  if (!harness) throw new Error("agentHarnessMissing");
  // The persisted slot is interpreted by this install, never by a server constant.
  const slot = harness.modelSlots?.find((s) => s.slot === rule.model);
  const model = slot?.model ?? rule.model;
  if (harness.modelSlots?.some((s) => s.slot === rule.model) && !slot?.model)
    throw new Error("executionModelUnknown");
  return { place: device.id, harness: agent, model };
}
