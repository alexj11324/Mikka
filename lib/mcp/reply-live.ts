import "server-only";
import { pool } from "../db";
import { workspacePool } from "../workspace-db";
import { MCP_REPLY_CHANNEL, subscribeShared } from "../db/listen";
import type { SharedSubscription } from "../db/listen";
import type { LiveScope } from "../live/scope";
import { observeReplySignals } from "./reply-signals";
import type { ReplyChanged } from "./reply-wait";

/** Listen before reading. App and workspace notifications are committed with
 * their writes; identical target settings share one physical LISTEN session. */
export function subscribeToCoordinatorReplies(
  scope: LiveScope,
  botId: string,
  changed: ReplyChanged,
  signal: AbortSignal,
) {
  return observeReplySignals(
    async (signal) => {
    // One budget for both connect+LISTEN handshakes. subscribeShared detaches
    // this setup signal after ready, so it cannot expire a healthy observer.
      const setup = new AbortController(),
        timer = setTimeout(() => setup.abort(), 5_000);
      const ready = AbortSignal.any([signal, setup.signal]);
    try {
        const results = await Promise.allSettled([
        subscribeShared(pool, MCP_REPLY_CHANNEL, [`bot:${botId}`], ready),
          subscribeShared(
            workspacePool,
            MCP_REPLY_CHANNEL,
            [`member:${scope.workspaceId}:${scope.ownerId}`],
            ready,
          ),
        ]);
        const failure = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (failure) {
          for (const result of results)
            if (result.status === "fulfilled") result.value?.close();
          throw failure.reason;
        }
        return results.map(
          (result) =>
            (result as PromiseFulfilledResult<SharedSubscription | null>).value,
        );
      } finally {
        clearTimeout(timer);
      }
    },
    changed,
    signal,
  );
}
