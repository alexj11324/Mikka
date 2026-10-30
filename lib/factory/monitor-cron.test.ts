import assert from "node:assert/strict";
import test from "node:test";
import { runFactoryMonitorCron } from "./monitor-cron";
import { disabledFactoryMonitorSweep } from "./monitor-sweep";

const flags = ["MIKKA_FACTORY_ROUTING_ENABLED", "MIKKA_FACTORY_LIFECYCLE_ENABLED"] as const;

test("monitor cron is a no-op unless both factory lifecycle flags are on", async (t) => {
  const saved = flags.map((k) => process.env[k]);
  t.after(() => flags.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i]))));
  let calls = 0;
  const sweep = (async () => { calls++; return { ...disabledFactoryMonitorSweep(), enabled: true }; }) as any;
  for (const [routing, lifecycle] of [[undefined, undefined], ["1", undefined], [undefined, "1"], ["1", "0"], ["true", "1"]]) {
    flags.forEach((k, i) => { const v = [routing, lifecycle][i]; if (v === undefined) delete process.env[k]; else process.env[k] = v; });
    assert.deepEqual(await runFactoryMonitorCron({ deadline: Date.now() + 1000 }, sweep), disabledFactoryMonitorSweep());
  }
  assert.equal(calls, 0, "flag-off never sweeps");
  process.env.MIKKA_FACTORY_ROUTING_ENABLED = "1";
  process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = "1";
  await runFactoryMonitorCron({ deadline: Date.now() + 1000 }, sweep);
  assert.equal(calls, 1, "control: flag-on sweeps");
});
