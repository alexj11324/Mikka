import type { SharedSubscription } from "../db/listen";
import type { ReplyChanged, ReplyObserver } from "./reply-wait";

/** Reconnect the transport, not the business read. PostgreSQL notifications
 * are hints, not a durable log: every fully restored LISTEN set emits a wake
 * after registration, so the waiter reconciles current authorized state once.
 * Missing/failed connections back off until the request's lifetime ends. */
export async function observeReplySignals(
  open: (signal: AbortSignal) => Promise<(SharedSubscription | null)[]>,
  changed: ReplyChanged,
  signal: AbortSignal,
): Promise<ReplyObserver> {
  const lifetime = new AbortController();
  let subscriptions: SharedSubscription[] = [],
    closed = false,
    lost = true;
  let pause: ReturnType<typeof setTimeout> | undefined;
  let resume: (() => void) | undefined;
  const release = () => {
    const current = subscriptions;
    subscriptions = [];
    for (const subscription of current) subscription.close();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", close);
    lifetime.abort();
    clearTimeout(pause);
    resume?.();
    release();
  };
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) close();
  const connect = async () => {
    let values: (SharedSubscription | null)[];
    try {
      values = await open(lifetime.signal);
    } catch {
      return false;
    }
    if (
      closed ||
      !values.length ||
      values.some((value) => !value || value.lost)
    ) {
      for (const value of values) value?.close();
      return false;
  }
    subscriptions = values as SharedSubscription[];
    lost = false;
    return true;
  };
  const watch = async (
    subscription: SharedSubscription,
    generation: AbortSignal,
  ) => {
    while (!generation.aborted) {
      subscription.reset();
      if (subscription.lost) return;
      await subscription.next(2_147_483_647, generation);
      if (generation.aborted || subscription.lost) return;
      changed("notification");
    }
  };
  const connected = !closed && (await connect());
  const run = async () => {
    let ready = connected,
      failures = 0;
    while (!closed) {
      if (ready) {
        const generation = new AbortController();
        const abort = () => generation.abort();
        lifetime.signal.addEventListener("abort", abort, { once: true });
  try {
          await Promise.race(
            subscriptions.map((value) => watch(value, generation.signal)),
          );
        } catch {
          /* Socket/read errors have the same recovery path as EOF. */
        } finally {
          generation.abort();
          lifetime.signal.removeEventListener("abort", abort);
          release();
        }
        if (closed) return;
        lost = true;
        changed("lost");
      }
      // Backoff only reconnects LISTEN. No status reads run on this clock.
      await new Promise<void>((resolve) => {
        resume = resolve;
        pause = setTimeout(
          resolve,
          Math.min(30_000, 250 * 2 ** Math.min(failures++, 7)),
        );
      });
      resume = undefined;
      if (closed) return;
      ready = await connect();
      if (ready) {
        failures = 0;
        changed("notification");
      }
    }
  };
  void run();
  return {
    get lost() {
      return lost;
    },
    close,
  };
}
