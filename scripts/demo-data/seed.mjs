// Retired by #1517: synthetic devices, future heartbeats and unfinished runs
// must never be created or refreshed. This exits before importing DB code.
// Existing historical demo data remains; scripts/ops/remove-demo-devices.ts
// stops active runs and removes only the exact demo devices through business APIs.
throw new Error('Demo device seeding is retired (#1517); use real device enrollment')
