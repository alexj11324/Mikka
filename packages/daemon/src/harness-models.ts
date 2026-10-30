import { execa } from "execa";
import { buildChildEnv } from "./env";
import type { Harness } from "@mikka/protocol";

/** Codex exposes its account's catalogue via app-server; Claude has no list API. */
export async function detectHarnessModels(
  harness: Harness,
  binary: string,
): Promise<string[] | undefined> {
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
      return models.length ? [...new Set(models)].slice(0, 500) : undefined;
    }
    if (harness !== "codex") return undefined;
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
        if (pending.length > 1_000_000) return undefined;
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
            if (!Array.isArray(rows)) return undefined;
            return [
              ...new Set(
                rows.flatMap((row: { model?: unknown }) =>
                  typeof row.model === "string" && row.model.length <= 128
                    ? [row.model]
                    : [],
                ),
              ),
            ];
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
  return undefined;
}
