-- 「允许自动调度」 per device (decision 2026-10-31-2200-run-machine-fallback,
-- orchestration.md § 4). Null means the default for the device type: on for
-- servers, off for personal computers. Only devices with it on are picked
-- automatically; a device the person names is used regardless.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS "autoSchedule" boolean;
