#!/usr/bin/env node
// Mikka's MCP server for agent CLIs: the explicit hand-in tools a real
// harness calls instead of just ending its turn (`submit`, `ask_human`,
// `report_blocked`). It runs inside the agent's sandbox as a stdio child of
// the CLI, with no dependencies, and records the call in the handoff file
// (in the worktree's git dir, writable from the sandbox). The daemon reads
// that file when the turn ends; the file, not the CLI's event stream, is the
// one source of truth for every harness.
//
//   node mikka-mcp.mjs --handoff <file>
//
// Protocol: MCP over stdio, newline-delimited JSON-RPC 2.0.
import { randomUUID } from "node:crypto"
import { writeFileSync, renameSync, readFileSync } from "node:fs"
import { createInterface } from "node:readline"

const handoffIndex = process.argv.indexOf("--handoff")
const handoffFile = handoffIndex > 0 ? process.argv[handoffIndex + 1] : null
if (!handoffFile) {
  process.stderr.write("mikka-mcp: --handoff <file> is required\n")
  process.exit(2)
}

const stringArray = { type: "array", items: { type: "string" } }

// A `plan` run hands in a spec and the split it proposes instead of code
// (ADR 0047). The shapes are `planSpec` / `planSplit` in
// packages/protocol/src/plan.ts; the daemon checks them again on the way out.
const SPEC_SCHEMA = {
  type: "object",
  description: "The product-level spec. Required on a planning run.",
  properties: {
    title: { type: "string" },
    summary: { type: "string", description: "One paragraph, for the card." },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading: { type: "string" },
          items: stringArray,
        },
        required: ["heading", "items"],
      },
    },
  },
  required: ["title", "sections"],
}

const SPLIT_SCHEMA = {
  type: "object",
  description:
    "The issues the spec splits into. Required on a planning run. Every issue needs at least one acceptance criterion; nothing is created until a person approves the split.",
  properties: {
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Local id; parentKey and blockedBy name these.",
          },
          title: { type: "string" },
          goal: { type: "string" },
          parentKey: { type: "string", description: "Grouping only." },
          blockedBy: {
            ...stringArray,
            description: "Keys that must merge first.",
          },
          criteria: {
            type: "array",
            items: {
              type: "object",
              properties: {
                body: { type: "string" },
                checkCommand: {
                  type: "string",
                  description: "Omit when a person checks it.",
                },
              },
              required: ["body"],
            },
          },
          verifyCommand: { type: "string" },
          predictedFiles: stringArray,
          sizeEstimate: {
            type: "object",
            properties: {
              files: { type: "number" },
              lines: { type: "number" },
            },
            required: ["files", "lines"],
          },
          priority: {
            type: "string",
            enum: ["none", "urgent", "high", "medium", "low"],
          },
        },
        required: ["key", "title", "criteria"],
      },
    },
  },
  required: ["issues"],
}

const TOOLS = [
  {
    name: "submit",
    description:
      "Hand in your finished work. Call this once, as your last action, when the task is done and you checked it. Mikka then runs the verify command, commits your changes and pushes the branch. Do not commit or push yourself. On a planning run, hand in the spec and the split you propose instead of code.",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "What you did, in a few sentences.",
        },
        nextStep: {
          type: "string",
          description: "What should happen next, if anything.",
        },
        openQuestions: {
          ...stringArray,
          description: "Questions a human should look at.",
        },
        spec: SPEC_SCHEMA,
        split: SPLIT_SCHEMA,
        criteria: {
          type: "array",
          description:
            "One entry per acceptance criterion (AC-n) the issue lists, in order. On a read-only check, an entry with no evidence counts as not passed, so report only what you actually saw.",
          items: {
            type: "object",
            properties: {
              criterionId: {
                type: "string",
                description: "The criterion's id, as given in your brief.",
              },
              passed: { type: "boolean" },
              evidence: {
                type: "string",
                description:
                  "What you saw: the command and its output, or the file and line.",
              },
            },
            required: ["criterionId", "passed"],
          },
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "request_help",
    description:
      "Stop and request missing task context from the Orchestrator. It first checks the issue and existing facts; only genuinely unresolved input is escalated to the person. Work is preserved for the original session.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        context: { type: "string" },
        summary: { type: "string" },
      },
      required: ["question"],
    },
  },
  {
    name: "ask_human",
    description:
      "Stop and ask a human a question you cannot answer yourself (a product decision, missing access). Your work so far is kept; the run continues after the answer.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        kind: { type: "string", enum: ["decision", "permission"] },
        summary: { type: "string", description: "Where you are so far." },
      },
      required: ["question"],
    },
  },
  {
    name: "report_blocked",
    description:
      "Stop because something outside the code blocks you (quota, a service down, a permission you lack).",
    inputSchema: {
      type: "object",
      properties: {
        blockedOn: {
          type: "string",
          description: "The external condition, e.g. quota_exhausted.",
        },
        summary: { type: "string" },
      },
      required: ["blockedOn"],
    },
  },
]

const KINDS = { submit: "submit",
  request_help: "ask", ask_human: "ask", report_blocked: "blocked", }

function record(kind, args, toolName) {
  // A planning hand-in carries the spec and the split it proposes. The id is
  // generated here, once, so the cards the daemon puts in the conversation
  // and the row the server stores name the same spec.
  const plan =
    kind === "submit" &&
    typeof args.spec === "object" &&
    args.spec !== null &&
    typeof args.split === "object" &&
    args.split !== null
      ? { specId: randomUUID(), spec: args.spec, split: args.split }
      : null
  const questionText = String(
    kind === "blocked"
      ? (args.blockedOn ?? "External condition")
      : (args.question ?? "Missing task input"),
  )
    .trim()
    .slice(0, 4000)
  const questionKind =
    kind === "blocked"
      ? "external"
      : toolName === "request_help"
        ? "context"
        : args.kind === "permission"
          ? "permission"
          : "decision"
  let questionId = randomUUID()
  try {
    const existing = JSON.parse(readFileSync(handoffFile, "utf8"))
    if (
      existing.kind === kind &&
      existing.question?.question === questionText &&
      existing.question.kind === questionKind
    )
      questionId = existing.question.questionId
  } catch {
    /* First durable hand-in; a retry reads the same id above. */
  }
  const handoff = {
    kind,
    ...(kind === "ask" || kind === "blocked"
      ? {
          question: {
            questionId,
            kind: questionKind,
            question: questionText,
            context: String(args.context ?? args.summary ?? "").slice(0, 4000),
            options: [],
          },
        }
      : {}),
    summary: typeof args.summary === "string" ? args.summary : "",
    nextStep: typeof args.nextStep === "string" ? args.nextStep : null,
    openQuestions: Array.isArray(args.openQuestions)
      ? args.openQuestions.filter((q) => typeof q === "string")
      : typeof args.question === "string"
        ? [args.question]
        : [],
    ...(typeof args.blockedOn === "string"
      ? { blockedOn: args.blockedOn }
      : {}),
    ...(plan ? { plan } : {}),
    // Kept as sent; the daemon validates and trims each entry.
    ...(Array.isArray(args.criteria) ? { criteria: args.criteria } : {}),
    at: new Date().toISOString(),
  }
  const tmp = `${handoffFile}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(handoff, null, 2)}\n`)
  renameSync(tmp, handoffFile)
  return plan !== null
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
}

function fail(id, code, message) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`,
  )
}

function handle(message) {
  const { id, method, params } = message
  if (id === undefined || id === null) return // notifications
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "mikka", version: "0.0.1" },
      })
    case "ping":
      return reply(id, {})
    case "tools/list":
      return reply(id, { tools: TOOLS })
    case "tools/call": {
      const kind = KINDS[params?.name]
      if (!kind) return fail(id, -32602, `Unknown tool: ${params?.name}`)
      let planned
      try {
        planned = record(kind, params.arguments ?? {}, params.name)
      } catch (error) {
        return reply(id, {
          isError: true,
          content: [{ type: "text", text: `Could not record: ${error}` }],
        })
      }
      const text =
        kind !== "submit"
          ? "Recorded. End your turn now."
          : planned
            ? "Handed in. End your turn now; a person approves the spec, then the split."
            : "Handed in. End your turn now; Mikka verifies, commits and pushes."
      return reply(id, { content: [{ type: "text", text }] })
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`)
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return fail(null, -32700, "Parse error")
  }
  handle(message)
})
