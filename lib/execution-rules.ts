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
export const DEFAULT_EXECUTION_RULE: ExecutionRule = {
  id: "default",
  label: null,
  place: "auto",
  harness: "auto",
  model: "auto",
  position: 2147483647,
};
export type ExecutionResolution =
  { place: string; harness: string; model?: string } | { waitFor: string };

/** The default is a fixed virtual row: it cannot be edited, reordered or deleted. */
export function resolveExecution(
  issueLabels: readonly string[],
  rules: readonly ExecutionRule[],
  devices: readonly ExecutionDevice[],
): ExecutionResolution {
  const rule =
    [...rules]
      .filter((r) => r.label !== null)
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .find((r) => issueLabels.includes(r.label!)) ?? DEFAULT_EXECUTION_RULE;
  const choose = (device: ExecutionDevice) =>
    device.harnesses.find(
      (h) =>
        h.installed && (rule.harness === "auto" || h.harness === rule.harness),
    )?.harness;
  const model = rule.model === "auto" ? {} : { model: rule.model };
  if (rule.place !== "auto" && rule.place !== "cloud") {
    const device = devices.find((d) => d.id === rule.place);
    if (!device?.online || !device.enabled) return { waitFor: rule.place };
    const harness = choose(device);
    if (!harness) throw new Error("agentHarnessMissing");
    return { place: device.id, harness, ...model };
  }
  if (rule.place === "auto") {
    for (const device of devices) {
      if (!device.online || !device.enabled) continue;
      const harness = choose(device);
      if (harness) return { place: device.id, harness, ...model };
    }
  }
  return { place: "cloud", harness: rule.harness, ...model };
}
