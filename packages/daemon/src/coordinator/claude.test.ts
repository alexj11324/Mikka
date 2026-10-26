import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { claudeCoordinatorOptions, runClaudeCoordinator } from "./claude"
import { CoordinatorToolHost } from "./contract"

const cwd = mkdtempSync(join(tmpdir(), "mikka-coordinator-"))
afterAll(() => rmSync(cwd, { recursive: true, force: true }))
const host = { cwd, tools: [], executable: resolve("test/fakes/fake-coordinator-claude.mjs") }
const input = { instructions: "You are Mikka, Alex's personal assistant.", context: 'root = TextContent("收到邮件，要帮你准备回复吗？")', timeoutMs: 3000 }

describe("Claude Coordinator", () => {
  it("uses a replacement string prompt without coding preset, tools or bypass", async () => {
    const controller = new AbortController()
    const definition = { name: "propose_reply", description: "Propose", inputSchema: { text: z.string() }, execute: vi.fn(async () => ({})) }
    const tools = new CoordinatorToolHost([definition], controller.signal, 5)
    const options = claudeCoordinatorOptions(input, { cwd, tools: [definition], env: { HOME: cwd, GH_TOKEN: "fixture-secret", ANTHROPIC_API_KEY: "fixture-secret" } }, controller, tools)
    expect(typeof options.systemPrompt).toBe("string")
    expect(options.systemPrompt).toContain(input.instructions)
    expect(options.tools).toEqual([])
    expect(options.settingSources).toEqual([])
    expect(options.strictMcpConfig).toBe(true)
    expect(options.persistSession).toBe(false)
    expect(options.permissionMode).toBe("default")
    expect(options.env).not.toHaveProperty("GH_TOKEN")
    expect(options.env).not.toHaveProperty("ANTHROPIC_API_KEY")
    const context = { signal: controller.signal, toolUseID: "test", requestId: "request-test" }
    await expect(options.canUseTool!("Bash", { command: "echo no" }, context)).resolves.toMatchObject({ behavior: "deny" })
    await expect(options.canUseTool!("mcp__mikka__propose_reply", { text: "draft" }, context)).resolves.toMatchObject({ behavior: "allow" })
  })
  it("runs through the actual SDK subprocess and returns exact OpenUI", async () => {
    const result = await runClaudeCoordinator(input, host)
    expect(result.text).toBe(input.context)
    expect(result.nativeSessionId).toBe("11111111-1111-4111-8111-111111111111")
    expect(result.toolCalls).toBe(0)
  })
  it("passes Mikka's system prompt to the actual SDK CLI boundary", async () => {
    const result = await runClaudeCoordinator({ ...input, context: "INSPECT" }, host)
    const inspected = JSON.parse(result.text)
    // SDK versions can carry the prompt in initialization instead of argv.
    expect(JSON.stringify(inspected)).toContain(input.instructions)
    expect(inspected.settings).toBe("")
  })
  it("roundtrips a real SDK MCP tool call without built-in coding tools", async () => {
    const execute = vi.fn(async (input: Record<string, unknown>) => ({ text: input.text, pendingApproval: true }))
    const result = await runClaudeCoordinator({ ...input, context: "TOOL" }, { ...host, tools: [{ name: "propose_reply", description: "Propose a draft", inputSchema: { text: z.string() }, execute }] })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.text).toContain("pendingApproval")
    expect(result.toolCalls).toBe(1)
  })
  it.each(["ERROR", "EXIT"])("rejects SDK %s without another model fallback", async context => {
    await expect(runClaudeCoordinator({ ...input, context }, host)).rejects.toThrow()
  })
  it("cancels a hung real SDK subprocess", async () => {
    await expect(runClaudeCoordinator({ ...input, context: "HANG", timeoutMs: 150 }, host)).rejects.toThrow()
  })
})
