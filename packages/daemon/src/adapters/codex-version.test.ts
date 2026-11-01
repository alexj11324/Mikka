import { describe, expect, it } from "vitest"

import { codexHasAuditedDynamicTools, codexSupportsRunApproval } from "./codex-version"

describe("codexSupportsRunApproval", () => {
  it.each(["codex-cli 0.162.0", "codex-cli 0.163.0", "codex-cli 0.166.0", "codex_cli_rs/0.166.0 (Linux; arm64)", "codex-cli 0.170.2", "codex-cli 1.0.0"])("accepts %s", version => {
    expect(codexSupportsRunApproval(version)).toBe(true)
  })

  it.each(["codex-cli 0.161.9", "codex-cli 0.100.0", "codex-cli 0.163.0-alpha", "codex-cli", "", null, undefined])("refuses %s", version => {
    expect(codexSupportsRunApproval(version)).toBe(false)
  })
})

describe("codexHasAuditedDynamicTools", () => {
  it("is only the audited release, whichever way it is written", () => {
    expect(codexHasAuditedDynamicTools("codex_cli_rs/0.163.0 synthetic-fixture")).toBe(true)
    expect(codexHasAuditedDynamicTools("codex-cli 0.163.0")).toBe(true)
    for (const version of ["codex_cli_rs/0.162.0", "codex_cli_rs/0.164.0", "codex_cli_rs/0.163.0-alpha", null]) {
      expect(codexHasAuditedDynamicTools(version)).toBe(false)
    }
  })
})
