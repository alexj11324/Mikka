// Why the run sandbox could not start, in a form the device page can act on.
//
// Ubuntu 23.10+ (and so 24.04) restricts unprivileged user namespaces through
// AppArmor: `kernel.apparmor_restrict_unprivileged_userns=1` lets a process
// create a user namespace but strips its capabilities, which bubblewrap and
// sandbox-runtime's seccomp layer need (sandbox-runtime README, "Ubuntu 24.04+
// note"; Ubuntu's spec:
// https://discourse.ubuntu.com/t/spec-unprivileged-user-namespace-restrictions-via-apparmor-in-ubuntu-23-10/37626).
// On GitHub's ubuntu-24.04 runner (CI run 41313960870) the sysctl read 1 and
// bwrap failed with "bwrap: loopback: Failed RTM_NEWADDR: Operation not
// permitted". Only the person can lift it; the daemon never runs unsandboxed.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

export type SandboxIssueReason = "userns_restricted"

export interface SandboxFailure {
  reason?: SandboxIssueReason
  /** The probe's own error, bounded and with no home paths or variable values. */
  detail?: string
}

const DETAIL_MAX = 300
const SYSCTL = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns"

/** bwrap's messages when a user namespace exists but has no capabilities. */
const USERNS_DENIED = [
  /loopback: Failed RTM_NEWADDR: Operation not permitted/i,
  /setting up uid map: Permission denied/i,
  /setting up uid map: Operation not permitted/i,
  /Creating new namespace failed: Operation not permitted/i,
  /No permissions to create new namespace/i,
]

export function readUsernsRestriction(read: (path: string) => string = path => readFileSync(path, "utf8")): boolean {
  try {
    return read(SYSCTL).trim() === "1"
  } catch {
    return false
  }
}

/** The probe error as text a person can see: no home directory, no `NAME=value`, bounded. */
export function sanitizeSandboxDetail(text: string, home = homedir()): string {
  let value = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
  if (home && home !== "/") value = value.split(home).join("~")
  value = value
    .replace(/\b([A-Z][A-Z0-9_]{2,})=("[^"]*"|'[^']*'|\S+)/g, "$1=…")
    .replace(/\s+/g, " ")
    .trim()
  return value.length > DETAIL_MAX ? `${value.slice(0, DETAIL_MAX - 1)}…` : value
}

/** Classifies a failed sandbox probe; `restricted` is the sysctl reading. */
export function classifySandboxFailure(error: unknown, restricted = readUsernsRestriction(), home = homedir()): SandboxFailure {
  const message = error instanceof Error ? error.message : String(error ?? "")
  const detail = message ? sanitizeSandboxDetail(message, home) : undefined
  const denied = USERNS_DENIED.some(pattern => pattern.test(message))
  return {
    ...(denied || (restricted && /Operation not permitted|Permission denied/i.test(message)) ? { reason: "userns_restricted" as const } : {}),
    ...(detail ? { detail } : {}),
  }
}
