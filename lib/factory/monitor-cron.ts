import "server-only";
import { pool } from "@/lib/db";
import { factoryLifecycleEnabled, factoryRuntimeForBot } from "./runtime";
import { disabledFactoryMonitorSweep, sweepFactoryMonitor } from "./monitor-sweep";

/** Entry for the existing hourly cron (GET /api/cron/suggestions-reconcile). Off with the lifecycle flags. */
export async function runFactoryMonitorCron(
  options: { deadline: number },
  sweep: typeof sweepFactoryMonitor = sweepFactoryMonitor,
) {
  if (!factoryLifecycleEnabled()) return disabledFactoryMonitorSweep();
  const monitors = new Map<string | null, ReturnType<typeof factoryRuntimeForBot>["monitor"]>();
  return sweep(pool, (botId) => {
    if (!monitors.has(botId)) monitors.set(botId, factoryRuntimeForBot(botId).monitor);
    return monitors.get(botId)!;
  }, options);
}
