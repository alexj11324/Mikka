import { execa } from "execa";
import { buildChildEnv } from "./env";
import type { Harness, HarnessInfo } from "@mikka/protocol";

// These are model identifiers, never provider keys or credentials.
export function claudeDiscoveryEnv(host: NodeJS.ProcessEnv = process.env) {
  const env = buildChildEnv({ host });
  for (const slot of ["OPUS", "SONNET", "HAIKU"]) {
    const key = `ANTHROPIC_DEFAULT_${slot}_MODEL`;
    const value = host[key];
    if (value && /^[a-zA-Z0-9._:/-]{1,128}$/.test(value)) env[key] = value;
  }
  return env;
}
type Catalogue = Pick<
  HarnessInfo,
  "models" | "modelSlots" | "defaultModelSlot"
>;
export function claudeModelCatalogue(
  rows: { value: string; resolvedModel?: string; displayName: string }[],
): Catalogue {
  const modelSlots = rows
    .filter((r) => r.resolvedModel && r.value !== "auto")
    .map((r) => ({
      slot: r.value,
      model: r.resolvedModel!,
      name: r.resolvedModel!,
    }));
  return {
    models: modelSlots.map((r) => r.slot),
    modelSlots,
    ...(modelSlots.some((r) => r.slot === "opus")
      ? { defaultModelSlot: "opus" }
      : {}),
  };
}
export async function detectHarnessCatalogue(
  harness: Harness,
  binary: string,
): Promise<Catalogue> {
  if (harness === "claude_code") {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const session = query({
      prompt: (async function* () {})(),
      options: {
        pathToClaudeCodeExecutable: binary,
        env: claudeDiscoveryEnv(),
        abortController: controller,
        settingSources: ["user", "project", "local"],
      },
    });
    try {
      return claudeModelCatalogue(await session.supportedModels());
    } catch {
      return {};
    } finally {
      clearTimeout(timer);
      session.close();
    }
  }
  return await discover(harness, binary);
}
export async function detectHarnessModels(
  harness: Harness,
  binary: string,
): Promise<string[] | undefined> {
  return (await detectHarnessCatalogue(harness, binary)).models;
}
/** Codex exposes its account's catalogue via app-server; Claude has no list API. */
async function discover(harness: Harness, binary: string): Promise<Catalogue> {
  const options = {
    env: buildChildEnv(),
    extendEnv: false,
    timeout: 5_000,
    stdin: "ignore" as const,
  };
  try {
    if (harness === "cursor") {
      const { stdout } = await execa(binary, ["--list-models"], options);
      const models = stdout
        .replace(/\x1b\[[0-9;]*m/g, "")
        .split("\n")
        .flatMap((line) => {
          const match =
            /^\s*(?:[-*•]\s*)?([a-z0-9][a-z0-9._:/-]*)\s+(?:[-–(]|\s)/.exec(
              line,
            );
          return match ? [match[1]] : [];
        });
      return { models: [...new Set(models)].slice(0, 500) };
    }
    if (harness !== "codex") return {};
    const child = execa(binary, ["app-server"], { ...options, stdin: "pipe" });
    // Attach a rejection handler immediately: timeout/kill is expected cleanup.
    const completion = child.catch(() => undefined);
    child.stdin!.write(
      JSON.stringify({
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "mikka", version: "1" } },
      }) + "\n",
    );
    let pending = "";
    try {
      for await (const chunk of child.stdout!) {
        pending += chunk.toString();
        if (pending.length > 1_000_000) return {};
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          let reply;
          try {
            reply = JSON.parse(line);
          } catch {
            continue;
          }
          if (reply.id === 1 && reply.result) {
            child.stdin!.write(
              JSON.stringify({ method: "initialized" }) + "\n",
            );
            child.stdin!.write(
              JSON.stringify({
                id: 2,
                method: "model/list",
                params: { limit: 500 },
              }) + "\n",
            );
          }
          if (reply.id === 2) {
            const rows = reply.result?.data;
            if (!Array.isArray(rows)) return {};
            const models = rows.filter(
              (r: { model?: unknown }) =>
                typeof r.model === "string" && r.model.length <= 128,
            );
            const modelSlots = models.map(
              (r: { model: string; displayName?: string }) => ({
                slot: r.model,
                model: r.model,
                name: r.displayName ?? r.model,
              }),
            );
            const selected = models.find(
              (r: { isDefault?: boolean }) => r.isDefault,
            );
            if (selected)
              modelSlots.push({
                slot: "default",
                model: selected.model,
                name: selected.displayName ?? selected.model,
              });
            return {
              models: models.map((r: { model: string }) => r.model),
              modelSlots,
              ...(selected ? { defaultModelSlot: "default" } : {}),
            };
          }
        }
      }
    } finally {
      child.kill();
      await completion;
    }
  } catch {
    /* Unsupported command, no account, or old CLI: auto only. */
  }
  return {};
}
