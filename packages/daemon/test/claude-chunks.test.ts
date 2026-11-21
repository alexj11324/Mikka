import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { expect, it } from "vitest"
import { claudeChunks } from "../src/adapters/claude"

it("reports both cache buckets from the Claude result", () => {
  const message = {
    type: "result", usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 },
  } as SDKMessage
  expect(claudeChunks(message)).toMatchObject([
    { type: "data-usage", data: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 80, cacheWriteTokens: 20 } },
  ])
  expect(claudeChunks(message, "claude-sonnet-5")).toMatchObject([
    { type: "data-usage", data: { model: "claude-sonnet-5" } },
  ])
})

// Claude Code 2.1.305's ToolSearch result for a `select:` query, as sent to the model.
it("shows the tools a ToolSearch loaded instead of an empty output", () => {
  const message = {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_01",
          content: [
            { type: "tool_reference", tool_name: "mcp__mikka__submit" },
            { type: "tool_reference", tool_name: "mcp__mikka__report_blocked" },
          ],
        },
        { type: "text", text: "Tool loaded." },
      ],
    },
    parent_tool_use_id: null,
    session_id: "s",
  } as unknown as SDKMessage
  expect(claudeChunks(message)).toEqual([
    { type: "tool-output-available", toolCallId: "toolu_01", output: "mcp__mikka__submit\nmcp__mikka__report_blocked" },
  ])
})
