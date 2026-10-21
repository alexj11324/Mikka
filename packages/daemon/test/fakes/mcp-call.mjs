// Fake CLIs call Mikka's MCP server the way a real harness does: spawn it
// from the config they were given, initialize, then `tools/call`.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

export async function callMcpTool(server, name, args) {
  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...(server.env ?? {}) },
    stdio: ["pipe", "pipe", "inherit"],
  })
  const replies = new Map()
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line)
    replies.get(message.id)?.(message)
  })
  let id = 0
  const request = (method, params) =>
    new Promise((resolve) => {
      const current = ++id
      replies.set(current, resolve)
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: current, method, params })}\n`
      )
    })
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "fake", version: "1" },
  })
  const result = await request("tools/call", { name, arguments: args })
  child.kill()
  return result
}
