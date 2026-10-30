import { describe, expect, it } from "vitest";
import { withoutTaskEnv, withTaskEnv } from "./task-env";

describe("4e3 task env channel", () => {
  it("adds user variables after the platform env and never replaces a platform variable", () => {
    const out = withTaskEnv({ PATH: "/usr/bin", MIKKA_RUN: "r1" }, { API_TOKEN: "t", PATH: "/evil", MIKKA_RUN: "x" });
    expect(out.env).toEqual({ PATH: "/usr/bin", MIKKA_RUN: "r1", API_TOKEN: "t" });
    expect(out.dropped.sort()).toEqual(["MIKKA_RUN", "PATH"]);
  });
  it("drops every reserved hook name, case-insensitively, and reports names only", () => {
    const hooks = ["BASH_ENV", "ENV", "PROMPT_COMMAND", "PERL5OPT", "RUBYOPT", "JAVA_TOOL_OPTIONS", "NPM_CONFIG_REGISTRY", "npm_config_registry", "PIP_INDEX_URL", "PYTHONSTARTUP", "GLOBAL_AGENT_HTTP_PROXY", "LD_PRELOAD", "NODE_OPTIONS", "GIT_SSH_COMMAND", "https_proxy", "E2B_API_KEY", "ANTHROPIC_API_KEY"];
    const out = withTaskEnv({}, Object.fromEntries(hooks.map((name) => [name, "secret-value"])));
    expect(out.env).toEqual({});
    expect(out.dropped.sort()).toEqual([...hooks].sort());
    expect(JSON.stringify(out.dropped)).not.toContain("secret-value");
  });
  it("keeps look-alike but harmless names", () => {
    expect(withTaskEnv({}, { ENVIRONMENT: "x", MY_PATH: "y", RUBYOPTS_NOTE: "z" }).env).toEqual({ ENVIRONMENT: "x", MY_PATH: "y", RUBYOPTS_NOTE: "z" });
  });
  it("never writes task variables to disk", () => {
    expect(withoutTaskEnv({ runId: "r", taskEnv: { A: "b" } })).toEqual({ runId: "r" });
    expect(withoutTaskEnv({ runId: "r" })).toEqual({ runId: "r" });
  });
});
