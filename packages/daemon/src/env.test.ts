import { describe, expect, it } from "vitest"

import { buildChildEnv, isDeniedEnvName } from "./env"

const PLANTED = {
  E2B_API_KEY: "e2b-test-placeholder",
  CLAUDE_CONFIG_DIR: "/home/me/.claude",
  CLAUDE_CODE_USE_BEDROCK: "1",
  MCP_SERVERS: "{}",
  ANTHROPIC_API_KEY: "sk-ant-planted",
  OPENAI_API_KEY: "sk-planted",
  AWS_ACCESS_KEY_ID: "AKIAPLANTED",
  AWS_SECRET_ACCESS_KEY: "planted",
  GOOGLE_APPLICATION_CREDENTIALS: "/planted.json",
  AZURE_CLIENT_SECRET: "planted",
  GITHUB_TOKEN: "ghp_planted",
  GH_TOKEN: "gho_planted",
  NPM_TOKEN: "npm_planted",
  MIKKA_DEVICE_TOKEN: "planted",
  DATABASE_URL: "postgres://planted",
  SOME_SERVICE_TOKEN: "planted",
  NODE_OPTIONS: "--require /planted.js",
}

const host = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/me",
  LANG: "en_US.UTF-8",
  ...PLANTED,
}

describe("buildChildEnv", () => {
  it("drops every planted host variable", () => {
    const env = buildChildEnv({ host, runId: "run-1" })
    for (const name of Object.keys(PLANTED))
      expect(env).not.toHaveProperty(name)
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/me",
      LANG: "en_US.UTF-8",
      MIKKA_RUN_ID: "run-1",
    })
  })

  it("passes adapter-declared vars but never denied ones", () => {
    const env = buildChildEnv({
      host: { ...host, CURSOR_CONFIG: "x" },
      adapterAllow: [
        "CURSOR_CONFIG",
        "ANTHROPIC_API_KEY",
        "CLAUDE_CONFIG_DIR",
        "E2B_API_KEY",
      ],
    })
    expect(env.CURSOR_CONFIG).toBe("x")
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY")
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR")
    expect(env).not.toHaveProperty("E2B_API_KEY")
  })

  it("classifies names", () => {
    expect(isDeniedEnvName("MCP_ANYTHING")).toBe(true)
    expect(isDeniedEnvName("PATH")).toBe(false)
  })
})
