export type ManagedHarness = "claude_code" | "codex"
export interface HarnessArtifact {
  /** Path under the registry, `<package>/-/<file>.tgz`. */
  tarball: string
  /** Subresource-integrity string, `sha512-<base64>`. */
  integrity: string
  /** The executable inside the tarball. */
  entry: string
}
export interface HarnessPin { version: string; command: string; platforms: Record<string, HarnessArtifact> }
export interface HarnessPins { registry: string; harnesses: Record<ManagedHarness, HarnessPin> }
export interface HarnessStore {
  /** The daemon's own harness dir. */
  root: string
  pins?: HarnessPins
  /** `<platform>-<arch>`; this machine by default. */
  platform?: string
}
export type HarnessInstallState = "installed" | "not_installed" | "unsupported"
export const MANAGED_HARNESSES: readonly ManagedHarness[]
export const HARNESS_PINS: HarnessPins
export function platformKey(platform?: string, arch?: string): string
export function harnessBinaryPath(store: HarnessStore, harness: ManagedHarness): string
export function harnessInstallState(store: HarnessStore, harness: ManagedHarness): { state: HarnessInstallState; version: string }
export function ensureHarness(store: HarnessStore, harness: ManagedHarness): Promise<string>
export function managedHarnessReport(store: HarnessStore): { harness: ManagedHarness; state: HarnessInstallState; version: string }[]
