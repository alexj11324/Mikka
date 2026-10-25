#!/usr/bin/env node
// Mikka's MCP server for agent CLIs: the explicit hand-in tools a real
// harness calls instead of just ending its turn (`submit`, `ask_human`,
// `report_blocked`). It runs inside the agent's sandbox as a stdio child of
// the CLI, with no dependencies, and records the call in the handoff file
// (in the worktree's git dir, writable from the sandbox). The daemon reads
// that file when the turn ends; the file, not the CLI's event stream, is the
// one source of truth for every harness.
// An optional daemon-owned local bridge adds five reference-only credential tools;
// this child never receives the platform run token or a submitted secret.
//
//   node mikka-mcp.mjs --handoff <file>
//
// Protocol: MCP over stdio, newline-delimited JSON-RPC 2.0.
import { randomUUID } from "node:crypto"
import { writeFileSync, renameSync, readFileSync } from "node:fs"
import { createInterface } from "node:readline"

const handoffIndex = process.argv.indexOf("--handoff")
const handoffFile = handoffIndex > 0 ? process.argv[handoffIndex + 1] : null
const bridgeIndex = process.argv.indexOf('--credential-bridge')
const credentialBridge = bridgeIndex > 0 ? process.argv[bridgeIndex + 1] : null
const credentialNames = new Set(['prepare_credential_request','credential_status','credential_use','credential_browser_action','credential_finish'])
const credentialId = { type: 'string', format: 'uuid' }
const actionId = { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' }
const credentialSchema = (properties, required) => ({ type: 'object', properties: { runId: credentialId, ...properties }, required, additionalProperties: false })
// Local declarations keep the existing hand-in tools available when the backend is down.
// The authenticated backend still validates every argument and derives the actual run.
const CREDENTIAL_TOOLS = [
  { name: 'prepare_credential_request', description: 'Prepare secure owner input for a registered service. Never accept passwords/tokens/codes in chat or tool arguments.', inputSchema: credentialSchema({ serviceId: actionId, mode: { type: 'string', enum: ['api_header', 'browser_login'] } }, ['serviceId', 'mode']) },
  ...['credential_status', 'credential_use', 'credential_finish'].map(name => ({ name, description: 'Inspect, use or finish a task credential by opaque reference only. No plaintext is returned.', inputSchema: credentialSchema({ credentialRef: credentialId }, ['credentialRef']) })),
  { name: 'credential_browser_action', description: 'Continue the same authenticated task using only named permitted browser pages, business regions or non-sensitive links.', inputSchema: credentialSchema({ credentialRef: credentialId, action: { oneOf: [
    { type: 'object', properties: { type: { const: 'navigate' }, pageId: actionId }, required: ['type', 'pageId'], additionalProperties: false },
    { type: 'object', properties: { type: { const: 'read' }, regionId: actionId }, required: ['type', 'regionId'], additionalProperties: false },
    { type: 'object', properties: { type: { const: 'click' }, targetId: actionId }, required: ['type', 'targetId'], additionalProperties: false },
  ] } }, ['credentialRef', 'action']) },
]
async function forwardCredentials(method, params) {
  const response = await fetch(credentialBridge, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(50_000), headers: { 'Content-Type': 'application/json', 'X-Mikka-Credential-Bridge': '1' }, body: JSON.stringify({ method, params }) })
  if (!response.ok) throw new Error('credential_bridge_unavailable')
  return response.json()
}
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

const mailboxEnabled = Boolean(process.env.MIKKA_MAILBOX_URL && process.env.MIKKA_MAILBOX_TOKEN)
const mailboxActions = { mailbox_recipients: 'recipients', mailbox_send: 'send', mailbox_inbox: 'inbox', mailbox_ack: 'ack', mailbox_sent: 'sent' }
if (mailboxEnabled) for (const name of Object.keys(mailboxActions)) {
  TOOLS.push({
    name,
    description: name === 'mailbox_send' ? 'Send a short peer envelope or reply. Reuse key only for retrying the same envelope. No user authority is granted.' : `${name}: inspect or acknowledge your session mailbox at a safe boundary.`,
    inputSchema: name === 'mailbox_send' ? {
      type: 'object', properties: { to: { type: 'string', format: 'uuid' }, key: { type: 'string', format: 'uuid' }, text: { type: 'string', minLength: 1, maxLength: 4000 }, replyTo: { type: 'string', format: 'uuid' } }, required: ['to', 'key', 'text'],
    } : name === 'mailbox_ack' ? { type: 'object', properties: { ids: { type: 'array', maxItems: 50, items: { type: 'string', format: 'uuid' } } }, required: ['ids'] } : { type: 'object', properties: {} },
  })
}
async function mailboxCall(id, name, args) {
  try {
    const response = await fetch(process.env.MIKKA_MAILBOX_URL, {
      method: 'POST', headers: { authorization: `Bearer ${process.env.MIKKA_MAILBOX_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...args, action: mailboxActions[name] }), signal: AbortSignal.timeout(15000),
    })
    const body = await response.json()
    reply(id, { isError: !response.ok, content: [{ type: 'text', text: JSON.stringify(body) }] })
  } catch {
    reply(id, { isError: true, content: [{ type: 'text', text: 'Mailbox unavailable. If retrying a send, reuse the same key. Do not infer execution from delivery.' }] })
  }
}

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

async function handle(message) {
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
      return reply(id, { tools: [...TOOLS, ...(credentialBridge ? CREDENTIAL_TOOLS : []), ...(process.env.MIKKA_ACTION_READBACK_URL ? [{
        name: 'resume_account_actions', description: 'Read the current server status of this run’s bound account actions. Does not create, approve, retry a send, or finish the run.',
        inputSchema: { type: 'object', properties: { operationId: { type: 'string', format: 'uuid' } }, additionalProperties: false },
      }] : [])] })
    case "tools/call": {
      if (params?.name === 'resume_account_actions') {
        try {
          const url = new URL(process.env.MIKKA_ACTION_READBACK_URL)
          if (!url.pathname.endsWith('/api/worker/account-actions') || url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1'))) throw new Error('invalid endpoint')
          const input = params.arguments ?? {}
          if (Object.keys(input).some(k => k !== 'operationId') || (input.operationId !== undefined && !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.operationId))) throw new Error('invalid operation')
          if (input.operationId) url.searchParams.set('operationId', input.operationId)
          const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.MIKKA_ACTION_READBACK_TOKEN}` }, redirect: 'error', signal: AbortSignal.timeout(10000) })
          if (!response.ok) throw new Error('unavailable')
          return reply(id, { content: [{ type: 'text', text: JSON.stringify(await response.json()) }] })
        } catch {
          return reply(id, { isError: true, content: [{ type: 'text', text: 'Bound account actions unavailable; no action was sent.' }] })
        }
      }
      if (credentialBridge && credentialNames.has(params?.name)) {
        try { return reply(id, await forwardCredentials('tools/call', params)) }
        catch { return reply(id, { isError: true, content: [{ type: 'text', text: 'Controlled credential tools unavailable; no secret was returned.' }] }) }
      }
      if (mailboxEnabled && Object.hasOwn(mailboxActions, params?.name ?? "")) return mailboxCall(id, params.name, params.arguments ?? {})
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
  void handle(message).catch(() => fail(message.id, -32603, 'Mikka tool failed'))
})
