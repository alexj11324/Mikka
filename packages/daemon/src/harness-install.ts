// Daemon-managed harnesses; the implementation is plain JavaScript in
// harness/install.mjs so the runner image and the E2B template run the same
// code from the same pins.
export {
  ensureHarness,
  HARNESS_PINS,
  harnessBinaryPath,
  harnessInstallState,
  MANAGED_HARNESSES,
  managedHarnessReport,
  platformKey,
  type HarnessArtifact,
  type HarnessInstallState,
  type HarnessPin,
  type HarnessPins,
  type HarnessStore,
  type ManagedHarness,
} from "../harness/install.mjs"
