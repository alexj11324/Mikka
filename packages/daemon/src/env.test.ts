import { describe, expect, it } from "vitest"
import { createServer } from "node:http"
import { execa } from "execa"

import { buildChildEnv, isDeniedEnvName } from "./env"

const PLANTED = {
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
  it("keeps the host's proxy and CA trust configuration without inheriting credentials or Node hooks", () => {
    const network = { HTTP_PROXY: "http://proxy.invalid:8080", HTTPS_PROXY: "http://proxy.invalid:8080",
      ALL_PROXY: "http://proxy.invalid:8080", NO_PROXY: "localhost,127.0.0.1", http_proxy: "http://proxy.invalid:8080",
      https_proxy: "http://proxy.invalid:8080", all_proxy: "http://proxy.invalid:8080", no_proxy: "localhost,127.0.0.1",
      NODE_USE_ENV_PROXY: "1", NODE_EXTRA_CA_CERTS: "/test/company-ca.pem", SSL_CERT_FILE: "/test/company-ca.pem", SSL_CERT_DIR: "/test/ca" }
    const child = buildChildEnv({ host: { ...host, ...network } })
    expect(child).toMatchObject(network)
    for (const name of Object.keys(PLANTED)) expect(child).not.toHaveProperty(name)
    expect(child).not.toHaveProperty("NODE_TLS_REJECT_UNAUTHORIZED")
  })

  it("an actual child reaches the model host through the configured proxy", async () => {
    const targets: string[] = []
    const proxy = createServer((request, response) => { targets.push(request.url!); response.end("proxied") })
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve))
    try {
      const address = proxy.address() as { port: number }
      const env = buildChildEnv({ host: { ...host, HTTP_PROXY: `http://127.0.0.1:${address.port}`, NO_PROXY: "", NODE_USE_ENV_PROXY: "1" } })
      const child = await execa(process.execPath, ["--input-type=module", "-e", "import http from 'node:http'; http.get('http://model.invalid/v1/messages', response => response.pipe(process.stdout)).on('error', error => { console.error(error.code); process.exitCode = 1 })"], { env, extendEnv: false, timeout: 5_000 })
      expect(child.stdout).toBe("proxied")
      expect(targets).toEqual(["http://model.invalid/v1/messages"])
    } finally { await new Promise<void>(resolve => proxy.close(() => resolve())) }
  })

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
      adapterAllow: ["CURSOR_CONFIG", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"],
    })
    expect(env.CURSOR_CONFIG).toBe("x")
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY")
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR")
  })

  it("classifies names", () => {
    expect(isDeniedEnvName("MCP_ANYTHING")).toBe(true)
    expect(isDeniedEnvName("PATH")).toBe(false)
  })
})
