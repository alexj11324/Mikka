// Which Codex releases can do what. Approvals and sandbox policy use the public
// app-server protocol, checked against official releases by
// test/codex-official-synthetic.acceptance.ts. Mailbox dynamic tools are
// experimental and undocumented, so those stay on the one audited release.
const VERSION = /(?:^|[ /])(\d+)\.(\d+)\.(\d+)(?:$|[ ();])/
const MINIMUM_APPROVAL_VERSION = [0, 162, 0] as const
const AUDITED_DYNAMIC_TOOLS = "0.163.0"

/** Takes `codex-cli 0.162.0` or `codex_cli_rs/0.162.0 ...`. A prerelease or unreadable version is refused. */
export function codexSupportsRunApproval(version: string | null | undefined): boolean {
  const match = VERSION.exec(version ?? "")
  if (!match) return false
  for (const [index, minimum] of MINIMUM_APPROVAL_VERSION.entries()) {
    const part = Number(match[index + 1])
    if (part !== minimum) return part > minimum
  }
  return true
}

export function codexHasAuditedDynamicTools(version: string | null | undefined): boolean {
  return VERSION.exec(version ?? "")?.slice(1).join(".") === AUDITED_DYNAMIC_TOOLS
}
