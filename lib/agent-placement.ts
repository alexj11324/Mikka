// Where an agent runs. An agent may pin a device, a harness and a model, or
// leave any of them on "auto" (null). Auto is resolved once, when a run is
// queued, and the result is stored on the run, so the daemon always gets a
// concrete harness and the run history shows what actually ran.

import { SUPPORTED_HARNESSES, type SupportedHarness as AgentHarness } from './db/schema'

/** Auto picks the first installed harness in this order. */
const HARNESS_PREFERENCE: readonly AgentHarness[] = SUPPORTED_HARNESSES

export interface PlacementDevice {
  id: string
  online: boolean
  enabled: boolean
  lastSeenAt: Date | null
  harnesses: { harness: string; installed: boolean }[]
}

export interface AgentPlacementChoice {
  /** null: auto. */
  deviceId: string | null
  harness: AgentHarness | null
  model: string | null
}

export type PlacementResult =
  | { ok: true; deviceId: string; harness: AgentHarness; model: string | null }
  | { ok: false; reason: 'noDevice' | 'deviceUnavailable' | 'harnessMissing' }

function installed(device: PlacementDevice, harness: AgentHarness): boolean {
  return device.harnesses.some(info => info.harness === harness && info.installed)
}

function pickHarness(device: PlacementDevice, wanted: AgentHarness | null): AgentHarness | null {
  if (wanted) return installed(device, wanted) ? wanted : null
  return HARNESS_PREFERENCE.find(harness => installed(device, harness)) ?? null
}

/**
 * Resolves an agent's choice against the person's devices.
 *
 * `requiredDeviceId` is the device a run must use because its repository
 * lives there; it wins over auto and must agree with a pinned device. Auto
 * device prefers online, enabled devices that have the harness, most
 * recently seen first. Auto model stays null: the harness CLI's own default.
 */
export function resolveAgentPlacement(
  choice: AgentPlacementChoice,
  devices: readonly PlacementDevice[],
  requiredDeviceId?: string,
): PlacementResult {
  if (requiredDeviceId && choice.deviceId && choice.deviceId !== requiredDeviceId) {
    return { ok: false, reason: 'deviceUnavailable' }
  }
  const pinned = requiredDeviceId ?? choice.deviceId
  if (pinned) {
    const device = devices.find(item => item.id === pinned)
    if (!device || !device.enabled) return { ok: false, reason: 'deviceUnavailable' }
    const harness = pickHarness(device, choice.harness)
    if (!harness) return { ok: false, reason: 'harnessMissing' }
    return { ok: true, deviceId: device.id, harness, model: choice.model }
  }
  const candidates = devices
    .filter(device => device.enabled)
    .map(device => ({ device, harness: pickHarness(device, choice.harness) }))
    .filter((item): item is { device: PlacementDevice; harness: AgentHarness } => item.harness !== null)
    .sort((a, b) =>
      Number(b.device.online) - Number(a.device.online) ||
      (b.device.lastSeenAt?.getTime() ?? 0) - (a.device.lastSeenAt?.getTime() ?? 0))
  const best = candidates[0]
  if (!best) return { ok: false, reason: devices.some(device => device.enabled) ? 'harnessMissing' : 'noDevice' }
  return { ok: true, deviceId: best.device.id, harness: best.harness, model: choice.model }
}

/**
 * Model names offered in the picker. They are the aliases each CLI itself
 * accepts; any other name can still be typed in as a custom model.
 */
export const SUGGESTED_MODELS: Record<AgentHarness, readonly string[]> = {
  claude_code: ['opus', 'sonnet', 'haiku'],
  codex: ['gpt-5-codex', 'gpt-5'],
}

/** What one harness on one device reported it accepts; absent lists come from older daemons. */
export interface ReportedHarnessOptions {
  models?: { value: string; efforts: string[] }[]
  permissionModes?: string[]
}

/**
 * A pinned permission mode or effort must be one the device's own harness
 * reported: the mode from the CLI's help, the effort from the pinned model's
 * levels. Either needs a pinned device and harness (and, for effort, a model),
 * exactly as the editor offers them; null always passes (the CLI default).
 */
export function runtimeOptionsError(
  reported: ReportedHarnessOptions | null,
  choice: { model: string | null; effort: string | null; permissionMode: string | null },
): 'agentPermissionModeInvalid' | 'agentEffortInvalid' | null {
  if (choice.permissionMode !== null && !(reported?.permissionModes ?? []).includes(choice.permissionMode)) return 'agentPermissionModeInvalid'
  if (choice.effort !== null) {
    const model = choice.model === null ? undefined : reported?.models?.find(item => item.value === choice.model)
    if (!model?.efforts.includes(choice.effort)) return 'agentEffortInvalid'
  }
  return null
}
