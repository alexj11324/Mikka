import "server-only";
import { cloudComputerTasksEnabled } from "./cloud-computer-flag";
import type { Pool } from "pg";
import { pool } from "./db";
import { issueForUser } from "./issue-access";
import { readIssueMetadata } from "./issue-metadata";
import { DEFAULT_EXECUTION_FALLBACKS, resolveExecution, type ExecutionDevice, type ExecutionRule } from "./execution-rules";
import { ExecutionSettings, executionWorkspace } from "./execution-settings";
import { isDeviceOnline } from "@mikka/protocol/device";
import { ActionFailureError } from "./action-error";
import type { HarnessInfo } from "@mikka/protocol/harness";
import { autoScheduleOn } from "./device-auto-schedule";
import { defaultAgentCopy } from "./agent-copy";
import { harnessForModel } from "@mikka/protocol/harness";
import { HOSTED_CHOICE } from "./bot-model-menu-view";
import { COORDINATOR_MODEL } from "./coordinator/model";
import { ownE2BKeySql } from "./secrets/e2b-owner-sql";

type Query = Pick<Pool, "query">;
type DeviceRow = ExecutionDevice & { lastSeenAt: Date | null; deviceType?: string | null; autoSchedule?: boolean | null };
export type DeviceTarget = {
  place: string;
  harness: string;
  model?: string;
  agentId: string;
  pinnedDeviceId?: string;
};

/**
 * Cloud means the person's own E2B key (keys are personal) on the dispatching bot's own cloud
 * runtime (MVP: no Mikka-hosted sandboxes). The key is enough: a bot with no
 * runtime yet gets one when the run is dispatched (`ensureBotCloudRuntime`).
 * The kill switch and a workspace's 「电脑」 policy set to deny turn it off. A
 * run with no bot (the Coordinator) uses the owner's hidden Coordinator bot
 * (`ensureCoordinatorBot`) and never borrows another bot's runtime.
 */
export async function cloudReady(
  query: Query,
  scope: { ownerId: string; workspaceId: string; botId: string | null; harness: string },
) {
  if (!cloudComputerTasksEnabled() || process.env.MIKKA_BYOS_ENABLED !== "1") return false;
  const { rowCount } = await query.query(
    `SELECT 1 WHERE ${ownE2BKeySql('$3::text')}
        AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM bots b WHERE b.id=$2 AND b."workspaceId"=$1::uuid AND b."ownerId"=$3 AND b."archivedAt" IS NULL))
        AND NOT EXISTS (SELECT 1 FROM workspace_computer_policies p WHERE p."workspaceId"=$1::uuid AND p.permission='deny')`,
    [scope.workspaceId, scope.botId, scope.ownerId],
  );
  return Boolean(rowCount);
}

/**
 * The person's own online device for a run the cloud cannot take
 * (orchestration.md § 4): a server first, then the default rule's device, else
 * the most recently seen one. The rule's harness wins when the device has it;
 * otherwise its first installed harness.
 */
export async function fallbackDevice(
  query: Query,
  ownerId: string,
  devices: readonly DeviceRow[],
  rules: readonly ExecutionRule[] | null,
  harness: string | null,
): Promise<DeviceTarget | null> {
  const preferred = rules?.find((r) => r.label === null)?.place;
  // Only devices Mikka may pick on its own (允许调度 and 允许自动调度 on); servers first, then the default rule's device, then the most recent.
  const online = devices
    .filter((d) => d.online && d.enabled && autoScheduleOn(d))
    .sort((a, b) => Number(b.deviceType === "server") - Number(a.deviceType === "server") || Number(b.id === preferred) - Number(a.id === preferred));
  for (const device of online) {
    const installed = (device.harnesses ?? []).filter((h: HarnessInfo) => h.installed);
    const ordered = [...installed].sort((a, b) => Number(b.harness === harness) - Number(a.harness === harness));
    for (const info of ordered) {
      const agent = (
        await query.query(
          'SELECT id FROM agents WHERE "userId"=$1 AND "deviceId"=$2 AND harness=$3 ORDER BY "createdAt",id LIMIT 1',
          [ownerId, device.id, info.harness],
        )
      ).rows[0];
      if (agent)
        return {
          place: device.id,
          harness: info.harness,
          model: info.defaultModelSlot ?? info.models?.[0],
          agentId: agent.id,
        };
    }
  }
  return null;
}

/**
 * Where an issue's run executes (decision 2026-10-31-2200-run-machine-fallback):
 * a matching rule on an online device runs there; otherwise the workspace's own
 * E2B cloud, then the person's online device with 允许自动调度 on, else
 * `needsMachine` with the card of what the person can do. A rule whose device
 * is offline takes the same order; nothing waits on an offline device.
 */
export async function resolveIssueExecution(
  ownerId: string,
  botId: string | null,
  issueId: string,
  /** `cloud`: the person asked for the cloud. No rule device and no fallback computer; without a ready cloud, the card. */
  only?: "cloud",
) {
  const issue = await issueForUser(ownerId, issueId);
  if (!issue) throw new ActionFailureError("issueNotFound");
  const workspaceId = await executionWorkspace(ownerId, botId);
  const settings = new ExecutionSettings(pool);
  // No model and no device yet (a new person): nothing to run on, which is the card, not an error.
  const rules = await settings.list({ ownerId, workspaceId }).catch((error: unknown) => {
    if (error instanceof ActionFailureError && error.code === "executionModelUnknown") return null;
    throw error;
  });
  const devices = await ownDevices(ownerId);
  const labels = readIssueMetadata(issue.content).labels.map(
    (label) => label.name,
  );
  // 设备离线时 is gone: a rule whose device is offline follows the same order as
  // any other run (own E2B, then an auto-schedule device, else the card).
  const ruled = rules ? resolveExecution(labels, rules, devices, { ...DEFAULT_EXECUTION_FALLBACKS, whenDeviceOffline: "cloud" }) : null;
  // Asked for the cloud: a rule that names a computer is not followed (its harness and model are kept only for a cloud rule).
  const resolution = only === "cloud" && ruled && ("waitFor" in ruled || ruled.place !== "cloud") ? null : ruled;
  if (resolution && "waitFor" in resolution) throw new ActionFailureError("agentNoDevice");
  if (resolution && resolution.place !== "cloud") {
    const target = await deviceTarget(ownerId, resolution);
    return { ...target, workspaceId, issue, pinnedDeviceId: resolution.place };
  }
  // No rule: the thread's model by §2, run on the Agent for that model (§3).
  const chosen = resolution ?? await (async () => {
    const thread = await threadModel(settings, { ownerId, workspaceId }, botId);
    return { place: "cloud", harness: thread.harness ?? harnessForModel(thread.model), model: thread.model, subscription: thread.subscription || Boolean(thread.apiKey), apiKey: Boolean(thread.apiKey) };
  })();
  // Cloud, by rule or because nothing else matched. A device is the fallback.
  const harness = chosen.harness;
  const found = only === "cloud" ? null : await fallbackDevice(pool, ownerId, devices, rules, harness);
  // A subscription or API-key model on the same Agent goes to the device's run; otherwise the device's own default.
  const fallback = found && !resolution && "subscription" in chosen && chosen.subscription && found.harness === harness
    ? { ...found, model: chosen.model } : found;
  if (await cloudReady(pool, { ownerId, workspaceId, botId, harness }))
    return { place: "cloud" as const, harness, model: chosen.model, workspaceId, issue, ...("apiKey" in chosen && chosen.apiKey ? { apiKey: true as const } : {}), ...(fallback ? { fallback } : {}) };
  if (fallback) return { ...fallback, workspaceId, issue };
  return { needsMachine: true as const, workspaceId, issue, card: machineUnavailableCard() };
}

/**
 * A thread's model when no rule names one (orchestration.md §2): the same order
 * as the bot's chat, without saving anything. The bot's saved choice; else the
 * owner's subscription here (Claude first); else one a teammate shares with
 * 分享给团队成员; else Mikka 默认. `subscription` tells a device run it may pass
 * the model to its Agent.
 */
export async function threadModel(settings: ExecutionSettings, scope: { ownerId: string; workspaceId: string }, botId: string | null): Promise<{ model: string; subscription: boolean; apiKey?: boolean; harness?: "claude_code" | "codex" }> {
  const saved = (await pool.query('SELECT "bindingId","apiKeyId" FROM bot_model_choices WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"=$3',
    [scope.ownerId, scope.workspaceId, botId ?? "coordinator"])).rows[0];
  const keyWorkspace = botId ? scope.workspaceId : null;
  if (saved?.apiKeyId) {
    // A saved API-key model runs on its key's Agent while the key is still usable here.
    const { botApiKeyChoice, usableApiKeys } = await import("./model-api-keys");
    const choice = await botApiKeyChoice(pool, scope, botId);
    const usable = choice && (keyWorkspace
      ? (await usableApiKeys(pool, scope.ownerId, keyWorkspace)).some((key) => key.id === choice.keyId)
      : Boolean((await pool.query('SELECT 1 FROM model_api_keys WHERE id=$1 AND "ownerId"=$2', [choice.keyId, scope.ownerId])).rowCount));
    if (choice && usable) return { model: choice.model, subscription: false, apiKey: true, harness: choice.harness };
  } else if (saved && !saved.bindingId) return { model: COORDINATOR_MODEL, subscription: false };
  const available = await settings.botModels(scope);
  const binding = (saved?.bindingId && saved.bindingId !== HOSTED_CHOICE ? await settings.botBinding(scope, saved.bindingId) : undefined)
    ?? available.find((row) => row.provider === "claude") ?? available[0]
    ?? (botId ? (await settings.pooledBindings(scope))[0] : undefined);
  if (binding) return { model: String(binding.modelId), subscription: true };
  // No subscription: the person's API key (§ 2), before Mikka 默认.
  const key = await (await import("./run-credential-source")).firstRunApiKey(pool, scope.ownerId, keyWorkspace);
  return key ? { model: key.model, subscription: false, apiKey: true, harness: key.harness } : { model: COORDINATOR_MODEL, subscription: false };
}

async function deviceTarget(ownerId: string, selected: { place: string; harness: string; model: string }): Promise<DeviceTarget> {
  const agent = (
    await pool.query(
      'SELECT id FROM agents WHERE "userId"=$1 AND "deviceId"=$2 AND harness=$3 ORDER BY "createdAt",id LIMIT 1',
      [ownerId, selected.place, selected.harness],
    )
  ).rows[0];
  if (!agent) throw new ActionFailureError("agentHarnessMissing");
  return { place: selected.place, harness: selected.harness, model: selected.model, agentId: agent.id };
}

/**
 * 没有可用的电脑 (Alex, 2026-11-01): what the person can do when no machine can
 * take a new run, as two rows: 连接电脑 opens Settings › 电脑, where a computer
 * is connected or switched on (and picked automatically); 填入 E2B Key opens
 * where the person's own E2B key is set, the only way to run in the cloud. No
 * row offers Mikka's own cloud.
 */
export function machineUnavailableCard() {
  const copy = defaultAgentCopy;
  return {
    title: copy.needsMachineTitle,
    description: copy.needsMachineDescription,
    options: [
      { value: "computer", label: copy.needsMachineConnect, action: "connectServer" },
      { value: "e2b", label: copy.needsMachineE2B, action: "e2bKey" },
    ],
  };
}

/** The person's local devices, most recently seen first. */
async function ownDevices(ownerId: string): Promise<DeviceRow[]> {
  const { rows } = await pool.query(
    `SELECT id,enabled,"lastSeenAt","deviceType","autoSchedule",harnesses FROM devices WHERE "ownerId"=$1 AND kind='local' AND "removedAt" IS NULL ORDER BY "lastSeenAt" DESC NULLS LAST,id`,
    [ownerId],
  );
  return rows.map((row) => ({ ...row, online: isDeviceOnline(row.lastSeenAt) }));
}

