#!/usr/bin/env node
// Mikka's MCP server for agent CLIs: the explicit hand-in tools a real
// harness calls instead of just ending its turn (`submit`, `ask_human`,
// `report_blocked`). It runs inside the agent's sandbox as a stdio child of
// the CLI, with no dependencies, and records the call in the handoff file
// (in the worktree's git dir, writable from the sandbox). The daemon reads
// that file when the turn ends; the file, not the CLI's event stream, is the
// one source of truth for every harness.
//
//   node mikka-mcp.mjs --handoff <file> [--captures <dir> --capture-root <dir>...]
//
// `submit_capture` copies a screenshot or recording the agent made into the
// captures dir; the daemon checks it again and uploads it to the run.
//
// Protocol: MCP over stdio, newline-delimited JSON-RPC 2.0.
import { randomUUID } from "node:crypto"
import { closeSync, copyFileSync, fstatSync, openSync, readSync, readdirSync, realpathSync, renameSync, writeFileSync, constants } from "node:fs"
import { join, sep } from "node:path"
import { createInterface } from "node:readline"

const handoffIndex = process.argv.indexOf("--handoff")
const handoffFile = handoffIndex > 0 ? process.argv[handoffIndex + 1] : null
if (!handoffFile) {
  process.stderr.write("mikka-mcp: --handoff <file> is required\n")
  process.exit(2)
}
const flagValues = (flag) => process.argv.flatMap((arg, i) => (arg === flag && process.argv[i + 1] ? [process.argv[i + 1]] : []))
const capturesDir = flagValues("--captures")[0] ?? null
const captureRoots = flagValues("--capture-root").flatMap((root) => {
  try { return [realpathSync(root)] } catch { return [] }
})

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
    name: "ask_human",
    description:
      "Stop and ask a human a question you cannot answer yourself (a product decision, missing access). Your work so far is kept; the run continues after the answer.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
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

// The same limits as @mikka/protocol/capture; this file has no dependencies.
const CAPTURE_LIMITS = { png: 10_000_000, jpg: 10_000_000, webp: 10_000_000, mp4: 100_000_000, webm: 100_000_000 }
const MAX_QUEUED_CAPTURES = 20
const CAPTURE_TOOL = {
  name: "submit_capture",
  description:
    "Attach a screenshot or screen recording you made (for example with Playwright) to this thread as evidence for the person. PNG, JPEG or WebP up to 10 MB; MP4 or WebM up to 100 MB. Pass a file inside the worktree or your temp directory.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "The file's path." },
      title: { type: "string", description: "What it shows, for the person." },
    },
    required: ["path", "title"],
  },
}

function sniff(head) {
  const ascii = (at, text) => [...text].every((c, i) => head[at + i] === c.charCodeAt(0))
  if (head.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => head[i] === b)) return "png"
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpg"
  if (head.length >= 12 && ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp"
  if (head.length >= 12 && ascii(4, "ftyp")) return "mp4"
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3 && Buffer.from(head).toString("latin1").includes("webm")) return "webm"
  return null
}

/** Copies the file into the captures dir after the checks the daemon repeats. */
function queueCapture(args) {
  if (!capturesDir) throw new Error("Captures are not available in this run.")
  const title = typeof args.title === "string" ? args.title.replace(/\s+/g, " ").trim().slice(0, 200) : ""
  if (!title) throw new Error("A title is required.")
  if (typeof args.path !== "string" || !args.path) throw new Error("A path is required.")
  const real = realpathSync(args.path)
  if (!captureRoots.some((root) => real === root || real.startsWith(root + sep)))
    throw new Error("The file must be inside the worktree or your temp directory.")
  const fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let ext
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error("Not a regular file.")
    const head = Buffer.alloc(64)
    ext = sniff(head.subarray(0, readSync(fd, head, 0, 64, 0)))
    if (!ext) throw new Error("Not a PNG, JPEG or WebP image, or an MP4 or WebM video.")
    if (stat.size === 0 || stat.size > CAPTURE_LIMITS[ext]) throw new Error(`At most ${CAPTURE_LIMITS[ext]} bytes for a .${ext} file.`)
  } finally {
    closeSync(fd)
  }
  if (readdirSync(capturesDir).filter((name) => name.endsWith(".json")).length >= MAX_QUEUED_CAPTURES)
    throw new Error("Too many captures waiting to upload; try again shortly.")
  const id = randomUUID()
  copyFileSync(real, join(capturesDir, `${id}.${ext}`), constants.COPYFILE_EXCL)
  // The metadata lands last: the daemon only takes files that have one.
  const meta = join(capturesDir, `${id}.json`)
  writeFileSync(`${meta}.tmp`, JSON.stringify({ title, at: new Date().toISOString() }))
  renameSync(`${meta}.tmp`, meta)
}

const KINDS = { submit: "submit", ask_human: "ask", report_blocked: "blocked" }

function record(kind, args) {
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
  const handoff = {
    kind,
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
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`
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
      return reply(id, { tools: capturesDir ? [...TOOLS, CAPTURE_TOOL] : TOOLS })
    case "tools/call": {
      if (capturesDir && params?.name === CAPTURE_TOOL.name) {
        try {
          queueCapture(params.arguments ?? {})
        } catch (error) {
          return reply(id, { isError: true, content: [{ type: "text", text: `Not attached: ${error instanceof Error ? error.message : error}` }] })
        }
        return reply(id, { content: [{ type: "text", text: "Attached to this thread. Keep working; it uploads in the background." }] })
      }
      const kind = KINDS[params?.name]
      if (!kind) return fail(id, -32602, `Unknown tool: ${params?.name}`)
      let planned
      try {
        planned = record(kind, params.arguments ?? {})
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
