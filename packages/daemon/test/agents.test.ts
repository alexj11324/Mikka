// The pieces real adapters share: Mikka's MCP hand-in server, the run
// context's handoff file, and the daemon's commit and push of a verified run.
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { execa } from "execa"
import { afterEach, describe, expect, it } from "vitest"

import { defaultRunPolicy, PACKAGE_REGISTRY_DOMAINS } from "@mikka/protocol/agent-policy"
import { normalizeRepository } from "@mikka/protocol/repository"

import { onLines } from "../src/agents/child"
import { commitMessage, publishRun, snapshotTree } from "../src/agents/publish"
import { MCP_SERVER_SCRIPT, RunContext } from "../src/agents/run-context"
import type { Logger } from "../src/log"
import { cleanupTempDirs, makeRepo, tempDir } from "./helpers"

afterEach(() => cleanupTempDirs())

async function worktreeOf(repo: string) {
  const path = join(tempDir("orvw-"), "wt")
  await execa("git", ["worktree", "add", "-q", "-b", "mikka/run-t", path], {
    cwd: repo,
  })
  return path
}

/** Talks newline-delimited JSON-RPC to the MCP server script. */
function mcpClient(handoff: string, extraArgs: string[] = [], env?: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [
    MCP_SERVER_SCRIPT,
    "--handoff",
    handoff,
    ...extraArgs,
  ], { env })
  const waiting = new Map<number, (value: unknown) => void>()
  onLines(child.stdout, (line) => {
    const message = JSON.parse(line) as { id: number }
    waiting.get(message.id)?.(message)
  })
  let id = 0
  return {
    request(method: string, params?: unknown) {
      const current = ++id
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: current, method, params })}\n`,
      )
      return new Promise<Record<string, unknown>>((resolve) =>
        waiting.set(current, resolve as (value: unknown) => void),
      )
    },
    close: () => child.kill(),
  }
}

describe("mikka MCP server", () => {
  it('continues in the already selected repository despite a CLI shadow clone with a local origin', async () => {
    const repo = await makeRepo()
    await execa('git', ['remote', 'add', 'origin', 'https://github.com/example/correct.git'], { cwd: repo })
    const worktree = await worktreeOf(repo)
    const shadow = join(tempDir(), 'shadow')
    await execa('git', ['clone', '--no-hardlinks', worktree, shadow])
    expect((await execa('git', ['remote', 'get-url', 'origin'], { cwd: shadow })).stdout).toBe(worktree)
    writeFileSync(join(worktree, 'uncommitted.txt'), 'preserve this work\n')
    const head = (await execa('git', ['rev-parse', 'HEAD'], { cwd: worktree })).stdout
    const before = (await execa('git', ['status', '--porcelain'], { cwd: worktree })).stdout
    const ctx = new RunContext({ harness: 'codex', kind: 'fix', worktree, runDir: tempDir(), privateDir: tempDir() })
    const client = mcpClient(ctx.handoffFile, ctx.mcpServer().args.slice(3), {
      ...process.env, GIT_DIR: join(shadow, '.git'), GIT_WORK_TREE: shadow,
    })
    try {
      const result = await client.request('tools/call', { name: 'switch_repository', arguments: {
        repository: 'example/correct', reason: 'The CLI origin is a local worktree path, but the task names this GitHub repository.',
      } }) as { result: { content: { text: string }[] } }
      expect(ctx.readHandoff()).toBeNull()
      expect(JSON.parse(result.result.content[0].text)).toMatchObject({
        status: 'already_active', selectionRecorded: false, action: 'continue_current_checkout',
        currentRepository: 'example/correct', observedRemote: 'https://github.com/example/correct.git', observedHead: head,
      })
      expect((await execa('git', ['status', '--porcelain'], { cwd: worktree })).stdout).toBe(before)
      expect((await execa('git', ['rev-parse', 'HEAD'], { cwd: worktree })).stdout).toBe(head)
      await client.request('tools/call', { name: 'submit', arguments: { summary: 'Continued the current repair.' } })
      expect(ctx.readHandoff()).toMatchObject({ outcome: 'succeeded', stopReason: 'submitted' })
    } finally { client.close() }
  })

  it.each([
    ['Example/CORRECT', true],
    ['https://github.com:443/Example/correct.git/', true],
    ['ssh://git@GITHUB.COM:22/Example/correct.git', true],
    ['git@GITHUB.COM:Example/correct.git', true],
    ['https://github.com:444/example/correct.git', false],
    ['ssh://git@github.com:2222/example/correct.git', false],
    ['ssh://other@github.com/example/correct.git', false],
    ['git@github.com:other/correct.git', false],
    ['https://fixture-user@github.com/example/correct.git', false],
    ['https://github.com/example/correct%2Egit', false],
    ['file:///tmp/example/correct', false],
  ] as const)('only continues for the same canonical GitHub identity: %s', async (repository, same) => {
    let key: string | null = null
    try { key = normalizeRepository(repository).key } catch { /* Invalid inputs are never same-repository evidence. */ }
    expect(key === 'v2/github.com/example/correct').toBe(same)
    const repo = await makeRepo()
    await execa('git', ['remote', 'add', 'origin', 'https://github.com/example/correct.git'], { cwd: repo })
    const ctx = new RunContext({ harness: 'claude_code', kind: 'implement', worktree: await worktreeOf(repo), runDir: tempDir(), privateDir: tempDir() })
    const client = mcpClient(ctx.handoffFile, ctx.mcpServer().args.slice(3))
    try {
      const result = await client.request('tools/call', { name: 'switch_repository', arguments: {
        repository, reason: 'Inspect repository identity before deciding whether a new checkout is needed.',
      } }) as { result: { content: { text: string }[] } }
      if (same) {
        expect(ctx.readHandoff()).toBeNull()
        expect(JSON.parse(result.result.content[0].text)).toMatchObject({
          status: 'already_active', selectionRecorded: false, action: 'continue_current_checkout', currentRepository: 'example/correct',
        })
      } else {
        expect(ctx.readHandoff()).toMatchObject({ stopReason: 'blocked', report: { repositorySelection: { repository } } })
        expect(result.result.content[0].text).toContain('Repository selection recorded')
      }
    } finally { client.close() }
  })

  it('reads repository metadata from the bound root despite inherited Git selectors', async () => {
    const repo = await makeRepo(), other = await makeRepo()
    await execa('git', ['remote', 'add', 'origin', 'https://github.com/example/wrong.git'], { cwd: repo })
    await execa('git', ['remote', 'add', 'origin', 'https://github.com/example/redirected.git'], { cwd: other })
    writeFileSync(join(repo, 'README.md'), 'Bound repository\n')
    await execa('git', ['add', 'README.md'], { cwd: repo })
    await execa('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'bound README'], { cwd: repo })
    const head = (await execa('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout
    const worktree = await worktreeOf(repo)
    const ctx = new RunContext({ harness: 'codex', kind: 'implement', worktree, runDir: tempDir(), privateDir: tempDir(), policy: { ...defaultRunPolicy(), readOnly: true } })
    const client = mcpClient(ctx.handoffFile, ctx.mcpServer().args.slice(3), { ...process.env, GIT_DIR: join(other, '.git'), GIT_WORK_TREE: worktree })
    try {
      const inspected = await client.request('tools/call', { name: 'inspect_artifact', arguments: { path: 'README.md' } }) as { result: { content: { text: string }[] } }
      expect(JSON.parse(inspected.result.content[0].text)).toMatchObject({ head, contentUtf8: 'Bound repository\n', contentMatchesGit: true })
      await client.request('tools/call', { name: 'switch_repository', arguments: { repository: 'example/correct', reason: 'The bound README identifies the wrong repository.' } })
      expect(ctx.readHandoff()?.report?.repositorySelection).toMatchObject({ observedRemote: 'https://github.com/example/wrong.git', observedHead: head })
      expect((await execa('git', ['status', '--porcelain'], { cwd: worktree })).stdout).toBe('')
    } finally { client.close() }
  })

  it('records an execution-side repository switch with actual Git evidence and retains the old checkout', async () => {
    const repo = await makeRepo()
    await execa('git', ['remote', 'add', 'origin', 'https://github.com/example/wrong.git'], { cwd: repo })
    const worktree = await worktreeOf(repo)
    writeFileSync(join(worktree, 'uncommitted.txt'), 'preserve this work\n')
    const ctx = new RunContext({ harness: 'codex', kind: 'implement', worktree, runDir: tempDir(), privateDir: tempDir() })
    const client = mcpClient(ctx.handoffFile, ctx.mcpServer().args.slice(3))
    try {
      expect(JSON.stringify(await client.request('tools/list'))).toContain('switch_repository')
      const result = await client.request('tools/call', { name: 'switch_repository', arguments: {
        repository: 'example/correct', reason: 'Task names the correct repository; this checkout is wrong.',
      } })
      expect(result).toMatchObject({ result: { content: expect.any(Array) } })
      expect(ctx.readHandoff()).toMatchObject({ outcome: 'failed', stopReason: 'blocked', report: {
        repositorySelection: { repository: 'example/correct', reason: expect.any(String),
          observedRemote: 'https://github.com/example/wrong.git', observedHead: expect.stringMatching(/^[a-f0-9]{40}$/) },
      } })
      expect((await execa('git', ['remote', 'get-url', 'origin'], { cwd: worktree })).stdout).toBe('https://github.com/example/wrong.git')
      expect(existsSync(join(worktree, 'uncommitted.txt'))).toBe(true)
    } finally { client.close() }
    const check = new RunContext({ harness: 'codex', kind: 'implement', worktree, runDir: tempDir(), privateDir: tempDir(),
      factoryCheck: { stage: 'review', reportOnly: true, inferCommand: false } })
    const checker = mcpClient(check.handoffFile, check.mcpServer().args.slice(3))
    try {
      expect(JSON.stringify(await checker.request('tools/list'))).not.toContain('switch_repository')
      expect(await checker.request('tools/call', { name: 'switch_repository', arguments: { repository: 'example/correct', reason: 'retarget check' } }))
        .toMatchObject({ error: { code: -32602 } })
      expect(check.readHandoff()).toBeNull()
    } finally { checker.close() }
  })
  it('offers a host-bound verify tool with real output, no model credential env and no hand-in side effect', async () => {
    const root = tempDir()
    const command = `${JSON.stringify(process.execPath)} -e "console.log('verified'); if(process.env.ANTHROPIC_API_KEY)process.exit(7)"`
    const previous = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'fixture-private-key'
    const client = mcpClient(join(root, 'handoff.json'), ['--factory-verify', JSON.stringify({ cwd: root, command, infer: false })])
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous
    try {
      const list = await client.request('tools/list')
      expect(JSON.stringify(list)).toContain('verify_command')
      const refused = await client.request('tools/call', { name: 'verify_command', arguments: { command: 'echo another command' } })
      expect(refused).toMatchObject({ result: { isError: true } })
      const result = await client.request('tools/call', { name: 'verify_command', arguments: { command } }) as { result: { content: { text: string }[] } }
      expect(JSON.parse(result.result.content[0].text)).toMatchObject({ exitCode: 0, stdout: 'verified\n' })
      expect(existsSync(join(root, 'handoff.json'))).toBe(false)
    } finally { client.close() }
  })
  it("lists the hand-in tools and records a submit as the session's exit", async () => {
    const repo = await makeRepo()
    const ctx = new RunContext({
      harness: "claude_code",
      worktree: await worktreeOf(repo),
      runDir: tempDir(),
      privateDir: tempDir("orvp-"),
    })
    const client = mcpClient(ctx.handoffFile)
    try {
      const init = await client.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      })
      expect(init).toMatchObject({
        result: { serverInfo: { name: "mikka" } },
      })
      const list = (await client.request("tools/list")) as {
        result: { tools: { name: string; description: string }[] }
      }
      expect(list.result.tools.map((t) => t.name)).toEqual([
        "submit",
        "request_help",
        "ask_human",
        "report_blocked",
      ])
      const submit = list.result.tools.find((tool) => tool.name === "submit")!
      expect(submit.description).toMatch(/delivery rules supplied for this run/)
      expect(submit.description).not.toMatch(/Do not commit or push yourself|Mikka then.*commits/)
      expect(ctx.readHandoff()).toBeNull()
      const submitted = await client.request("tools/call", {
        name: "submit",
        arguments: { summary: "Added greet()", nextStep: "Review it" },
      })
      expect(JSON.stringify(submitted)).not.toMatch(/Mikka verifies, commits and pushes/)
      expect(ctx.readHandoff()).toEqual({
        type: "exit",
        outcome: "succeeded",
        stopReason: "submitted",
        report: {
          summary: "Added greet()",
          nextStep: "Review it",
          openQuestions: [],
        },
      })
      // The handoff lives in the run dir, never in the tree.
      expect(ctx.handoffFile.startsWith(ctx.runDir)).toBe(true)
      ctx.clearHandoff()
      expect(ctx.readHandoff()).toBeNull()

      // A read-only check hands in one verdict per criterion (ADR 0046).
      const criterionId = randomUUID()
      await client.request("tools/call", {
        name: "submit",
        arguments: {
          summary: "Checked AC-1",
          previewDatabaseBranch: "preview/ac-1",
          reviewVerdict: "needs_judgment",
          criteria: [
            {
              criterionId,
              passed: true,
              evidence: "curl -s localhost:4000 -> 200",
              command: "curl -fsS localhost:4000",
              exitCode: 0,
            },
            { text: "End-to-end checks", passed: false, status: "unverified", reason: "No executable command exists.", resolution: "Recorded the missing observation." },
          ],
        },
      })
      expect(ctx.readHandoff()).toMatchObject({
        stopReason: "submitted",
        report: {
          previewDatabaseBranch: "preview/ac-1",
          reviewVerdict: "needs_judgment",
          criteria: [
            {
              criterionId,
              passed: true,
              evidence: "curl -s localhost:4000 -> 200",
              command: "curl -fsS localhost:4000",
              exitCode: 0,
            },
            { text: "End-to-end checks", passed: false, status: "unverified", reason: "No executable command exists.", resolution: "Recorded the missing observation." },
          ],
        },
      })
      ctx.clearHandoff()

      await client.request("tools/call", {
        name: "report_blocked",
        arguments: { blockedOn: "quota_exhausted" },
      })
      expect(ctx.readHandoff()).toMatchObject({
        outcome: "failed",
        stopReason: "blocked",
        report: { blockedOn: "quota_exhausted" },
      })
      await client.request("tools/call", {
        name: "ask_human",
        arguments: { question: "Which color?" },
      })
      expect(ctx.readHandoff()).toMatchObject({
        stopReason: "asked_human",
        report: { openQuestions: ["Which color?"] },
      })
      const questionId = ctx.readHandoff()?.report?.question?.questionId
      expect(questionId).toEqual(expect.any(String))
      await client.request("tools/call", {
        name: "ask_human",
        arguments: { question: "Which color?" },
      })
      expect(ctx.readHandoff()?.report?.question?.questionId).toBe(questionId)
      ctx.clearHandoff()
      await client.request("tools/call", {
        name: "request_help",
        arguments: { question: "Which existing API should I use?" },
      })
      expect(ctx.readHandoff()?.report?.question).toMatchObject({
        kind: "context",
        question: "Which existing API should I use?",
      })
      ctx.clearHandoff()
      await client.request("tools/call", { name: "request_help", arguments: { question: "Reply with the exact verification command only.", purpose: "verification_command" } })
      expect(ctx.readHandoff()?.report?.question).toMatchObject({ kind: "decision", purpose: "verification_command" })
      const unknown = await client.request("tools/call", { name: "rm_rf" })
      expect(unknown).toHaveProperty("error")
    } finally {
      client.close()
    }
  })
})

describe("run context", () => {
  it.each(['clean', 'process'] as const)('gives a Codex plan fixed repository observations without executing a %s filter', async filter => {
    const repo = await makeRepo(), other = await makeRepo(), worktree = await worktreeOf(repo)
    await execa('git', ['remote', 'add', 'origin', 'https://fixture-user:fixture-token@github.com/Example/Correct.git?token=private-query#private-fragment'], { cwd: repo })
    await execa('git', ['remote', 'add', 'origin', 'https://github.com/example/other.git'], { cwd: other })
    mkdirSync(join(worktree, 'docs'))
    writeFileSync(join(worktree, 'docs', 'context.md'), 'Plan from observed repository files.\n')
    const head = (await execa('git', ['rev-parse', 'HEAD'], { cwd: worktree })).stdout
    const before = (await execa('git', ['--no-optional-locks', 'status', '--porcelain=v1', '-z'], { cwd: worktree })).stdout
    const index = readFileSync(join(repo, '.git', 'worktrees', 'wt', 'index'))
    const marker = join(tempDir(), 'must-not-run')
    const hostile = join(tempDir(), 'hostile.sh')
    writeFileSync(hostile, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
    for (const name of ['core.fsmonitor', 'core.pager']) await execa('git', ['config', name, hostile], { cwd: repo })
    await execa('git', ['config', 'core.hooksPath', join(repo, '.git', 'hooks')], { cwd: repo })
    writeFileSync(join(repo, '.git', 'hooks', 'post-index-change'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
    await execa('git', ['config', `filter.probe.${filter}`, hostile], { cwd: repo })
    await execa('git', ['config', 'filter.probe.required', 'true'], { cwd: repo })
    writeFileSync(join(worktree, '.gitattributes'), 'README.md filter=probe\n')
    // Keep the size unchanged so status hashes the working copy rather than
    // concluding it changed from stat alone; that path invokes clean filters.
    writeFileSync(join(worktree, 'README.md'), '# Sandboz\n')
    const ctx = new RunContext({ harness: 'codex', kind: 'plan', worktree, runDir: tempDir(), privateDir: tempDir(), policy: { ...defaultRunPolicy(), readOnly: true } })
    const client = mcpClient(ctx.handoffFile, ctx.mcpServer().args.slice(3), { ...process.env, GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other, GIT_PAGER: hostile })
    try {
      expect(JSON.stringify(await client.request('tools/list'))).toContain('inspect_repository')
      const read = async (args: unknown) => {
        const response = await client.request('tools/call', { name: 'inspect_repository', arguments: args }) as { result: { isError?: boolean; content: { text: string }[] } }
        expect(response.result.isError).not.toBe(true)
        expect(JSON.stringify(response)).not.toMatch(/fixture-user|fixture-token|private-query|private-fragment/)
        return JSON.parse(response.result.content[0].text)
      }
      expect(await read({})).toMatchObject({ head, repository: 'example/correct', origin: 'https://github.com/example/correct.git',
        path: '.', status: { dirty: true, truncated: false },
        entries: expect.arrayContaining([{ name: 'README.md', kind: 'file' }, { name: 'docs', kind: 'directory' }]), truncated: false })
      expect((await read({ path: 'docs' })).entries).toEqual([{ name: 'context.md', kind: 'file' }])
      expect((await read({})).entries.some((entry: { name: string }) => entry.name === '.git')).toBe(false)
      expect((await read({})).status.porcelain).toContain(' M README.md\0')
      expect((await read({})).status.porcelain).toContain(before)
      expect(existsSync(marker)).toBe(false)
      expect(readFileSync(join(repo, '.git', 'worktrees', 'wt', 'index'))).toEqual(index)
      expect((await execa('git', ['rev-parse', 'HEAD'], { cwd: worktree })).stdout).toBe(head)
      expect(ctx.readHandoff()).toBeNull()
    } finally { client.close() }
  })

  it('lets a read-only Codex plan read its bound README without execution or repository-selection tools', async () => {
    const worktree = await worktreeOf(await makeRepo())
    const before = (await execa('git', ['rev-parse', 'HEAD'], { cwd: worktree })).stdout
    const ctx = new RunContext({ harness: 'codex', kind: 'plan', worktree, runDir: tempDir(), privateDir: tempDir(), policy: { ...defaultRunPolicy(), readOnly: true } })
    const client = mcpClient(ctx.handoffFile, ctx.mcpServer().args.slice(3))
    try {
      const tools = JSON.stringify(await client.request('tools/list'))
      expect(tools).toContain('inspect_artifact')
      expect(tools).not.toContain('switch_repository')
      expect(tools).not.toContain('verify_command')
      const observed = await client.request('tools/call', { name: 'inspect_artifact', arguments: { path: 'README.md' } }) as { result: { content: { text: string }[] } }
      expect(JSON.parse(observed.result.content[0].text)).toMatchObject({ path: 'README.md', head: before, contentUtf8: '# Sandbox\n', contentMatchesGit: true })
      for (const name of ['shell', 'write_file', 'switch_repository', 'verify_command']) {
        expect(await client.request('tools/call', { name, arguments: { command: 'touch write-must-not-run' } })).toMatchObject({ error: { code: -32602 } })
      }
      expect((await execa('git', ['status', '--porcelain'], { cwd: worktree })).stdout).toBe('')
      expect((await execa('git', ['rev-parse', 'HEAD'], { cwd: worktree })).stdout).toBe(before)
      expect(ctx.readHandoff()).toBeNull()
      expect(ctx.policy().allowWrite).not.toContain(worktree)
      expect(ctx.policy().denyWrite).toContain(worktree)
      await client.request('tools/call', { name: 'submit', arguments: { summary: 'Observed the README before planning.',
        spec: { title: 'Document the sandbox', sections: [{ heading: 'Scope', items: ['Keep the observed sandbox heading.'] }] },
        split: { issues: [{ key: 'readme', title: 'Document the sandbox', criteria: [{ body: 'README retains the observed heading.' }] }] },
      } })
      expect(ctx.readHandoff()).toMatchObject({ outcome: 'succeeded', stopReason: 'submitted', report: { plan: { spec: { title: 'Document the sandbox' } } } })
      expect((await execa('git', ['status', '--porcelain'], { cwd: worktree })).stdout).toBe('')
    } finally { client.close() }
  })

  it('bounds plan repository inspection and refuses paths, symlinks and free-form commands', async () => {
    const repo = await makeRepo(), worktree = await worktreeOf(repo), outside = tempDir()
    writeFileSync(join(outside, 'secret.txt'), 'outside-private-value')
    symlinkSync(outside, join(worktree, 'outside-directory'))
    symlinkSync(join(outside, 'secret.txt'), join(worktree, 'outside-file'))
    for (let i = 0; i < 240; i++) writeFileSync(join(worktree, `${String(i).padStart(3, '0')}-${'x'.repeat(110)}.txt`), '')
    const ctx = new RunContext({ harness: 'codex', kind: 'plan', worktree, runDir: tempDir(), privateDir: tempDir(), policy: { ...defaultRunPolicy(), readOnly: true } })
    const client = mcpClient(ctx.handoffFile, ctx.mcpServer().args.slice(3))
    const inspect = (args: unknown) => client.request('tools/call', { name: 'inspect_repository', arguments: args }) as Promise<{ result: { isError?: boolean; content: { text: string }[] } }>
    try {
      const observed = await inspect({})
      expect(observed.result.isError).not.toBe(true)
      expect(Buffer.byteLength(JSON.stringify(observed))).toBeLessThan(32 * 1024)
      const value = JSON.parse(observed.result.content[0].text)
      expect(value.entries.length).toBeLessThanOrEqual(200)
      expect(value.truncated).toBe(true)
      expect(value.status).toMatchObject({ dirty: true, truncated: true })
      expect(Buffer.byteLength(value.status.porcelain)).toBeLessThanOrEqual(8192)
      expect(value.entries.some((entry: { name: string }) => ['.git', 'outside-directory', 'outside-file'].includes(entry.name))).toBe(false)
      for (const path of ['../', outside, '.git', '.git/../', 'outside-directory', 'outside-directory/secret.txt', 'outside-file']) {
        const refused = await inspect({ path })
        expect(refused.result.isError).toBe(true)
        expect(JSON.stringify(refused)).not.toContain('outside-private-value')
        const file = await client.request('tools/call', { name: 'inspect_artifact', arguments: { path } })
        expect(file).toMatchObject({ result: { isError: true } })
        expect(JSON.stringify(file)).not.toContain('outside-private-value')
      }
      expect((await inspect({ command: 'touch write-must-not-run' })).result.isError).toBe(true)
      expect(existsSync(join(worktree, 'write-must-not-run'))).toBe(false)
      writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'index'), 'invalid-index-private-value')
      const failed = await inspect({})
      expect(failed.result.isError).toBe(true)
      expect(JSON.stringify(failed)).not.toMatch(/invalid-index-private-value|"dirty":false/)
      expect(ctx.readHandoff()).toBeNull()
    } finally { client.close() }
  })

  it('keeps artifact-reader advertising unchanged for writable executions and command checks', async () => {
    const worktree = await worktreeOf(await makeRepo())
    for (const options of [
      { kind: 'implement' as const, policy: defaultRunPolicy() },
      { kind: 'implement' as const, policy: { ...defaultRunPolicy(), readOnly: true }, factoryCheck: { stage: 'verify' as const, reportOnly: false, inferCommand: false } },
    ]) {
      const ctx = new RunContext({ harness: 'codex', worktree, runDir: tempDir(), privateDir: tempDir(), ...options })
      expect(ctx.mcpServer().args).not.toContain('--factory-artifacts')
    }
  })

  it.each([
    ['claude_code', 'implement'], ['codex', 'implement'], ['claude_code', 'fix'], ['codex', 'fix'],
  ] as const)('lets a read-only %s %s execution inspect its bound repository before selecting another', async (harness, kind) => {
    const repo = await makeRepo(), worktree = await worktreeOf(repo)
    const content = 'This is the wrong repository.\n'
    writeFileSync(join(worktree, 'README.md'), content)
    await execa('git', ['add', 'README.md'], { cwd: worktree })
    await execa('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'README'], { cwd: worktree })
    const before = (await execa('git', ['rev-parse', 'HEAD'], { cwd: worktree })).stdout
    const ctx = new RunContext({ harness, kind, worktree, runDir: tempDir(), privateDir: tempDir(), policy: { ...defaultRunPolicy(), readOnly: true } })
    const client = mcpClient(ctx.handoffFile, ctx.mcpServer().args.slice(3))
    try {
      const tools = JSON.stringify(await client.request('tools/list'))
      expect(tools).toContain('inspect_artifact')
      expect(tools).toContain('switch_repository')
      expect(tools).not.toContain('verify_command')
      const observed = await client.request('tools/call', { name: 'inspect_artifact', arguments: { path: 'README.md' } }) as { result: { content: { text: string }[] } }
      expect(JSON.parse(observed.result.content[0].text)).toMatchObject({ path: 'README.md', head: before, contentUtf8: content, contentMatchesGit: true })
      const outside = join(tempDir(), 'secret.txt')
      writeFileSync(outside, 'outside-private-value')
      symlinkSync(outside, join(worktree, 'escape'))
      for (const path of ['../secret.txt', outside, 'escape', '.git']) {
        const refused = await client.request('tools/call', { name: 'inspect_artifact', arguments: { path } })
        expect(refused).toMatchObject({ result: { isError: true } })
        expect(JSON.stringify(refused)).not.toContain('outside-private-value')
      }
      expect((await execa('git', ['status', '--porcelain'], { cwd: worktree })).stdout).toBe('?? escape')
      expect((await execa('git', ['rev-parse', 'HEAD'], { cwd: worktree })).stdout).toBe(before)
      expect(existsSync(ctx.handoffFile)).toBe(false)
    } finally { client.close() }
  })

  it('provides file hashes and fixed Git observations to a report-only check without granting shell commands', async () => {
    const repo = await makeRepo()
    const worktree = await worktreeOf(repo)
    const content = 'delivery-marker\n'
    writeFileSync(join(worktree, 'DELIVERY.txt'), content)
    await execa('git', ['add', 'DELIVERY.txt'], { cwd: worktree })
    await execa('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'candidate'], { cwd: worktree })
    const head = (await execa('git', ['rev-parse', 'HEAD'], { cwd: worktree })).stdout
    const ctx = new RunContext({ harness: 'claude_code', worktree, runDir: tempDir(), privateDir: tempDir(),
      factoryCheck: { stage: 'verify', reportOnly: true, inferCommand: false } })
    const spec = ctx.mcpServer()
    const client = mcpClient(ctx.handoffFile, spec.args.slice(3))
    try {
      const tools = JSON.stringify(await client.request('tools/list'))
      expect(tools).toContain('inspect_artifact')
      expect(tools).not.toContain('verify_command')
      const inspect = async (path: string) => (await client.request('tools/call', { name: 'inspect_artifact', arguments: { path } })) as { result: { isError?: boolean; content: { text: string }[] } }
      const observed = await inspect('DELIVERY.txt')
      expect(observed.result.isError).not.toBe(true)
      expect(JSON.parse(observed.result.content[0].text)).toMatchObject({
        path: 'DELIVERY.txt', bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'),
        head, committedSha256: createHash('sha256').update(content).digest('hex'), contentMatchesGit: true,
      })
      writeFileSync(join(worktree, 'DELIVERY.txt'), 'changed\n')
      expect(JSON.parse((await inspect('DELIVERY.txt')).result.content[0].text).contentMatchesGit).toBe(false)
      const outside = join(tempDir(), 'secret.txt')
      writeFileSync(outside, 'outside-private-value')
      symlinkSync(outside, join(worktree, 'escape'))
      for (const path of ['../secret.txt', outside, 'escape', '.git', 'missing']) {
        const refused = await inspect(path)
        expect(refused.result.isError).toBe(true)
        expect(JSON.stringify(refused)).not.toContain('outside-private-value')
      }
      expect(existsSync(ctx.handoffFile)).toBe(false)
    } finally { client.close() }
  })

  it('reads bounded UTF8 delivery contents and compares exact expected bytes without hiding extra lines', async () => {
    const repo = await makeRepo(), worktree = await worktreeOf(repo)
    // The actual failed production candidate retained two extra blank lines.
    const expected = 'factory-1136-codex-63a84557\n7 - 4 = 3\nverified artifact\n'
    const actual = 'factory-1136-codex-63a84557\n\n7 - 4 = 3\n\nverified artifact\n'
    expect(Buffer.byteLength(expected)).toBe(56)
    expect(Buffer.byteLength(actual)).toBe(58)
    const unicode = '\ufeff你好🌍\n'
    writeFileSync(join(worktree, 'DELIVERY.txt'), actual)
    writeFileSync(join(worktree, 'UNICODE.txt'), unicode)
    writeFileSync(join(worktree, 'BINARY.bin'), Buffer.from([0xff, 0xfe, 0x61]))
    writeFileSync(join(worktree, 'NUL.bin'), Buffer.from([0x61, 0, 0x62]))
    writeFileSync(join(worktree, 'LARGE.txt'), 'x'.repeat(64 * 1024 + 1))
    await execa('git', ['add', '.'], { cwd: worktree })
    await execa('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'candidate'], { cwd: worktree })
    const ctx = new RunContext({ harness: 'codex', worktree, runDir: tempDir(), privateDir: tempDir(),
      factoryCheck: { stage: 'verify', reportOnly: true, inferCommand: false } })
    const client = mcpClient(ctx.handoffFile, ctx.mcpServer().args.slice(3))
    const call = async (path: string, expectedUtf8?: string) => (await client.request('tools/call', {
      name: 'inspect_artifact', arguments: { path, ...(expectedUtf8 === undefined ? {} : { expectedUtf8 }) },
    })) as { result: { isError?: boolean; content: { text: string }[] } }
    const inspect = async (path: string, expectedUtf8?: string) => {
      const response = await call(path, expectedUtf8)
      expect(response.result.isError).not.toBe(true)
      return JSON.parse(response.result.content[0].text)
    }
    try {
      expect(await inspect('DELIVERY.txt', expected)).toMatchObject({ bytes: 58, contentUtf8: actual, matchesExpectedUtf8: false, contentMatchesGit: true })
      expect(await inspect('DELIVERY.txt', actual)).toMatchObject({ matchesExpectedUtf8: true })
      expect(await inspect('DELIVERY.txt', actual.slice(0, -1))).toMatchObject({ matchesExpectedUtf8: false })
      expect(await inspect('UNICODE.txt', unicode)).toMatchObject({ contentUtf8: unicode, matchesExpectedUtf8: true })
      for (const path of ['BINARY.bin', 'NUL.bin']) expect(await inspect(path)).toMatchObject({ contentUtf8: null, textUnavailable: 'binary', contentMatchesGit: true })
      expect(await inspect('LARGE.txt')).toMatchObject({ bytes: 64 * 1024 + 1, contentUtf8: null, textUnavailable: 'oversize', contentMatchesGit: true })
      expect((await call('DELIVERY.txt', 'x'.repeat(64 * 1024 + 1))).result.isError).toBe(true)
      writeFileSync(join(worktree, 'TOO-LARGE.bin'), '')
      truncateSync(join(worktree, 'TOO-LARGE.bin'), 16 * 1024 * 1024 + 1)
      expect((await call('TOO-LARGE.bin')).result.isError).toBe(true)
      expect(existsSync(ctx.handoffFile)).toBe(false)
    } finally { client.close() }
  })

  it('grants isolated command observations to a report-only repository review with host-enabled inference', async () => {
    const repo = await makeRepo()
    const ctx = new RunContext({ harness: 'claude_code', worktree: await worktreeOf(repo), runDir: tempDir(), privateDir: tempDir(),
      factoryCheck: { stage: 'review', reportOnly: true, inferCommand: true } })
    const spec = ctx.mcpServer()
    const at = spec.args.indexOf('--factory-verify')
    expect(at).toBeGreaterThan(-1)
    expect(JSON.parse(spec.args[at + 1])).toMatchObject({ command: null, infer: true, cwd: ctx.worktree })
    const client = mcpClient(ctx.handoffFile, spec.args.slice(at))
    try {
      const result = await client.request('tools/call', { name: 'verify_command', arguments: { command: 'git diff --check HEAD', basis: 'Inspect the fixed candidate Git tree without modifying it.' } }) as {result:{content:{text:string}[]}}
      expect(JSON.parse(result.result.content[0].text).exitCode).toBe(0)
    } finally { client.close() }
  })
  it("lets the run write its worktree and run dir, never git's files, and always reach its harness API", async () => {
    const repo = await makeRepo()
    const ctx = new RunContext({
      harness: "codex",
      worktree: await worktreeOf(repo),
      networkAllow: ["registry.npmjs.org"],
      extraWrite: ["/tmp/codex-auth.json"],
      runDir: tempDir(),
      privateDir: tempDir("orvp-"),
      // A person limited the network; the run still reaches its harness API.
      policy: { ...defaultRunPolicy(), permissions: { ...defaultRunPolicy().permissions, network: "ask" } },
    })
    const policy = ctx.policy()
    expect(policy).toMatchObject({
      allowWrite: [ctx.worktree, ctx.runDir, "/tmp/codex-auth.json"],
      denyWrite: [
        join(ctx.worktree, ".git"),
        join(ctx.gitDir, "commondir"),
        join(ctx.gitDir, "gitdir"),
        join(ctx.gitDir, "config.worktree"),
      ],
      allowDomains: [
        "openai.com",
        "*.openai.com",
        "chatgpt.com",
        "*.chatgpt.com",
        // The workspace's default allow-list (ADR 0028), then the repo's.
        "github.com",
        "*.github.com",
        "*.githubusercontent.com",
        ...PACKAGE_REGISTRY_DOMAINS,
      ],
    })
    expect(policy.allowWrite).not.toContain(ctx.gitDir)
    const home = homedir()
    expect(policy.denyRead).toEqual(
      expect.arrayContaining([
        join(home, ".ssh"),
        join(home, ".aws"),
        join(home, ".claude/.credentials.json"),
      ]),
    )
    // Codex still reads its own login; the others never see it.
    expect(policy.denyRead).not.toContain(join(home, ".codex/auth.json"))
  })

  it("a read-only check can read its worktree but not write it (ADR 0046)", async () => {
    const repo = await makeRepo()
    const ctx = new RunContext({
      harness: "codex",
      worktree: await worktreeOf(repo),
      runDir: tempDir(),
      privateDir: tempDir("orvp-"),
      policy: { ...defaultRunPolicy(), readOnly: true },
    })
    const policy = ctx.policy()
    // The worktree moves out of the writable set and into the denied one;
    // the run dir stays writable so the handoff still lands.
    expect(policy.allowWrite).not.toContain(ctx.worktree)
    expect(policy.allowWrite).toEqual([ctx.runDir])
    expect(policy.denyWrite).toEqual(
      expect.arrayContaining([ctx.worktree, join(ctx.worktree, ".git")]),
    )
    // Its instructions say so, so the agent does not try.
    expect(ctx.instructions()).toContain("read-only check")
  })
})

describe("publish", () => {
  async function repoWithRemote() {
    const repo = await makeRepo()
    const origin = tempDir("orvo-")
    await execa("git", ["init", "-q", "--bare", origin])
    await execa("git", ["remote", "add", "origin", origin], { cwd: repo })
    return { repo, origin }
  }

  async function runWorktree(repo: string, runId: string) {
    const worktree = join(tempDir("orvw-"), runId)
    await execa(
      "git",
      ["worktree", "add", "-q", "-b", `mikka/run-${runId}`, worktree],
      { cwd: repo },
    )
    return worktree
  }

  async function snapshotAndPublish(
    repo: string,
    worktree: string,
    options: { runId: string; summary: string; approved: boolean },
  ) {
    const tree = await snapshotTree(repo, worktree)
    return publishRun({
      runId: options.runId,
      repoPath: repo,
      worktree,
      tree,
      issueId: "issue-1",
      summary: options.summary,
      push: { approved: options.approved, remote: "origin" },
    })
  }

  it("commits the snapshot on the run branch and pushes it when approved", async () => {
    const { repo, origin } = await repoWithRemote()
    const worktree = await runWorktree(repo, "run-1")
    writeFileSync(join(worktree, "NEW.md"), "new\n")
    const tree = await snapshotTree(repo, worktree)
    // Written after the snapshot: not part of what verify passed on.
    writeFileSync(join(worktree, "LATE.md"), "late\n")
    const result = await publishRun({
      runId: "run-1",
      repoPath: repo,
      worktree,
      tree,
      issueId: "issue-1",
      summary: "Add NEW.md\n\nBecause it was asked for.",
      push: { approved: true, remote: "origin" },
    })
    expect(result).toMatchObject({
      branch: "mikka/run-run-1",
      pushed: true,
      remote: "origin",
    })
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/)
    const remote = (args: string[]) =>
      execa("git", ["--git-dir", origin, ...args]).then((r) => r.stdout)
    const log = await remote([
      "log",
      "-1",
      "--format=%s%n%b",
      "mikka/run-run-1",
    ])
    expect(log).toContain("mikka: Add NEW.md")
    expect(log).toContain("Mikka-Run: run-1")
    const files = await remote(["ls-tree", "--name-only", "mikka/run-run-1"])
    expect(files.split("\n")).toContain("NEW.md")
    expect(files.split("\n")).not.toContain("LATE.md")
    // The worktree's own branch moved to the commit.
    const head = await execa("git", ["rev-parse", "HEAD"], { cwd: worktree })
    expect(head.stdout).toBe(result.commit)
  })

  it("ignores a .git file the agent pointed at another repo", async () => {
    const { repo } = await repoWithRemote()
    const worktree = await runWorktree(repo, "run-3")
    writeFileSync(join(worktree, "NEW.md"), "new\n")
    // A repo of the agent's making, with a hook that would run on commit.
    const evil = await makeRepo()
    const marker = join(tempDir("orvm-"), "ran")
    const hooks = join(evil, ".git", "hooks")
    writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\ntouch ${marker}\n`, {
      mode: 0o755,
    })
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(evil, ".git")}\n`)
    const evilHead = (await execa("git", ["rev-parse", "HEAD"], { cwd: evil }))
      .stdout
    const result = await snapshotAndPublish(repo, worktree, {
      runId: "run-3",
      summary: "x",
      approved: false,
    })
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/)
    const branch = await execa(
      "git",
      ["rev-parse", "refs/heads/mikka/run-run-3"],
      { cwd: repo },
    )
    expect(branch.stdout).toBe(result.commit)
    expect(
      (await execa("git", ["rev-parse", "HEAD"], { cwd: evil })).stdout,
    ).toBe(evilHead)
    expect(existsSync(marker)).toBe(false)
  })

  it("commits but does not push without approval, and skips an empty run", async () => {
    const { repo, origin } = await repoWithRemote()
    const worktree = await runWorktree(repo, "run-2")
    const empty = await snapshotAndPublish(repo, worktree, {
      runId: "run-2",
      summary: "nothing",
      approved: true,
    })
    expect(empty).toMatchObject({
      commit: null,
      pushed: false,
      skipped: "no_changes",
    })
    writeFileSync(join(worktree, "x.txt"), "x\n")
    const held = await snapshotAndPublish(repo, worktree, {
      runId: "run-2",
      summary: "x",
      approved: false,
    })
    expect(held.commit).not.toBeNull()
    expect(held).toMatchObject({
      branch: "mikka/run-run-2",
      pushed: false,
      remote: null,
      skipped: "not_approved",
      note: /approval/,
    })
    const remote = await execa(
      "git",
      ["--git-dir", origin, "branch", "--list"],
      { reject: false },
    )
    expect(remote.stdout.trim()).toBe("")
  })

  describe("to the issue branch", () => {
    const PERSON = {
      GIT_AUTHOR_NAME: "Person",
      GIT_AUTHOR_EMAIL: "person@mikka.invalid",
      GIT_COMMITTER_NAME: "Person",
      GIT_COMMITTER_EMAIL: "person@mikka.invalid",
    }
    const remoteRev = (origin: string, ref: string) =>
      execa("git", ["--git-dir", origin, "rev-parse", ref], {
        reject: false,
      }).then((r) => (r.exitCode === 0 ? r.stdout.trim() : null))

    async function publishTo(
      repo: string,
      worktree: string,
      runId: string,
      approved = true,
      pushBranch = "mikka/orv-1",
    ) {
      return publishRun({
        runId,
        repoPath: repo,
        worktree,
        tree: await snapshotTree(repo, worktree),
        issueId: "issue-1",
        summary: `Work of ${runId}`,
        pushBranch,
        baseBranch: "main",
        push: { approved, remote: "origin" },
      })
    }

    /** What a continued run does to the worktree: same tree, its own branch. */
    const continueAs = (worktree: string, runId: string) =>
      execa("git", ["checkout", "-q", "-b", `mikka/run-${runId}`], {
        cwd: worktree,
      })

    it("pushes each run's commit to the same branch, fast-forward", async () => {
      const { repo, origin } = await repoWithRemote()
      const worktree = await runWorktree(repo, "run-1")
      writeFileSync(join(worktree, "one.txt"), "1\n")
      const first = await publishTo(repo, worktree, "run-1")
      expect(first).toMatchObject({
        branch: "mikka/orv-1",
        pushed: true,
        remote: "origin",
      })
      expect(first.skipped).toBeUndefined()
      expect(await remoteRev(origin, "mikka/orv-1")).toBe(first.commit)
      // The local commit stays on the run's own branch, which is not pushed.
      expect(
        (await execa("git", ["rev-parse", "mikka/run-run-1"], { cwd: repo }))
          .stdout,
      ).toBe(first.commit)
      expect(await remoteRev(origin, "mikka/run-run-1")).toBeNull()

      await continueAs(worktree, "run-2")
      writeFileSync(join(worktree, "two.txt"), "2\n")
      const second = await publishTo(repo, worktree, "run-2")
      expect(second).toMatchObject({ branch: "mikka/orv-1", pushed: true })
      expect(await remoteRev(origin, "mikka/orv-1")).toBe(second.commit)
      expect(await remoteRev(origin, "mikka/orv-1^")).toBe(first.commit)

      // A run that changes nothing re-pushes the issue's head (a no-op).
      await continueAs(worktree, "run-3")
      const third = await publishTo(repo, worktree, "run-3")
      expect(third).toEqual({
        branch: "mikka/orv-1",
        commit: second.commit,
        pushed: true,
        remote: "origin",
        skipped: "no_changes",
      })
    })

    it("pushes nothing when the worktree is still the base branch", async () => {
      const { repo, origin } = await repoWithRemote()
      const worktree = await runWorktree(repo, "run-1")
      expect(await publishTo(repo, worktree, "run-1")).toMatchObject({
        branch: "mikka/run-run-1",
        commit: null,
        pushed: false,
        skipped: "no_changes",
      })
      expect(await remoteRev(origin, "mikka/orv-1")).toBeNull()
    })

    it("commits without pushing when push is not approved", async () => {
      const { repo, origin } = await repoWithRemote()
      const worktree = await runWorktree(repo, "run-1")
      writeFileSync(join(worktree, "one.txt"), "1\n")
      const result = await publishTo(repo, worktree, "run-1", false)
      expect(result).toMatchObject({
        branch: "mikka/run-run-1",
        pushed: false,
        remote: null,
        skipped: "not_approved",
      })
      expect(result.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(await remoteRev(origin, "mikka/orv-1")).toBeNull()
    })

    it("never forces over commits it does not have, and reports the failure", async () => {
      const { repo, origin } = await repoWithRemote()
      // Someone else's history on the issue branch.
      const other = await makeRepo()
      await execa("git", ["commit", "-q", "--allow-empty", "-m", "theirs"], {
        cwd: other,
        env: PERSON,
      })
      await execa(
        "git",
        ["push", "-q", origin, "main:refs/heads/mikka/orv-1"],
        {
          cwd: other,
        },
      )
      const theirs = await remoteRev(origin, "mikka/orv-1")
      const worktree = await runWorktree(repo, "run-1")
      writeFileSync(join(worktree, "one.txt"), "1\n")
      const result = await publishTo(repo, worktree, "run-1")
      expect(result).toMatchObject({
        branch: "mikka/orv-1",
        pushed: false,
        remote: "origin",
        note: /Push failed/,
      })
      expect(result.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(result.skipped).toBeUndefined()
      expect(await remoteRev(origin, "mikka/orv-1")).toBe(theirs)
    })

    it("refuses a branch name that is not a plain branch", async () => {
      const { repo, origin } = await repoWithRemote()
      const worktree = await runWorktree(repo, "run-1")
      writeFileSync(join(worktree, "one.txt"), "1\n")
      const result = await publishTo(repo, worktree, "run-1", true, "a..b")
      expect(result).toMatchObject({ pushed: false, note: /branch name/ })
      expect(result.skipped).toBeUndefined()
      const branches = await execa("git", ["--git-dir", origin, "branch"])
      expect(branches.stdout.trim()).toBe("")
    })
  })

  it("builds a commit message from the agent's summary", () => {
    expect(
      commitMessage({ runId: "r", issueId: "i", summary: "  Fix bug  " }),
    ).toBe("mikka: Fix bug\n\nMikka-Run: r\nMikka-Issue: i")
  })
})

describe("the planning hand-in (ADR ORV-205)", () => {
  const spec = {
    title: "Planner",
    summary: "What changes for the user.",
    sections: [
      { heading: "User stories", items: ["As a person, I want a spec."] },
    ],
  }
  const split = {
    summary: "",
    issues: [
      {
        key: "scaffold",
        title: "Scaffold the schema",
        blockedBy: [],
        criteria: [{ body: "The table exists." }],
        predictedFiles: ["packages/db/src/schema/work.ts"],
        priority: "high",
      },
    ],
  }

  async function planContext(kind?: "plan") {
    return new RunContext({
      harness: "claude_code",
      ...(kind ? { kind } : {}),
      worktree: await worktreeOf(await makeRepo()),
      runDir: tempDir(),
      privateDir: tempDir("orvp-"),
    })
  }

  async function submit(ctx: RunContext, args: Record<string, unknown>) {
    const client = mcpClient(ctx.handoffFile)
    try {
      await client.request("initialize", { protocolVersion: "2025-06-18" })
      return await client.request("tools/call", {
        name: "submit",
        arguments: args,
      })
    } finally {
      client.close()
    }
  }

  it("records the spec and the split, and reads them back as the run's plan", async () => {
    const ctx = await planContext("plan")
    const result = await submit(ctx, {
      summary: "Wrote the spec.",
      spec,
      split,
    })
    // The agent is told what happens next, not that its work was verified.
    expect(result).toMatchObject({
      result: {
        content: [{ text: expect.stringContaining("approves the spec") }],
      },
    })
    const plan = ctx.readHandoff()?.report?.plan
    expect(plan?.specId).toMatch(/^[0-9a-f-]{36}$/)
    expect(plan?.spec.title).toBe("Planner")
    expect(plan?.split.issues[0]).toMatchObject({
      key: "scaffold",
      blockedBy: [],
      criteria: [{ body: "The table exists." }],
    })
  })

  it("drops a split that cannot be built, so no broken plan is stored", async () => {
    const ctx = await planContext("plan")
    await submit(ctx, {
      summary: "Wrote the spec.",
      spec,
      split: {
        summary: "",
        issues: [{ ...split.issues[0]!, blockedBy: ["nope"] }],
      },
    })
    const report = ctx.readHandoff()?.report
    // The submit still ends the run; only the unbuildable plan is left out.
    expect(report?.summary).toBe("Wrote the spec.")
    expect(report?.plan).toBeUndefined()
  })

  it("drops a hand-in with no spec at all", async () => {
    const ctx = await planContext("plan")
    await submit(ctx, { summary: "Wrote the spec.", split })
    expect(ctx.readHandoff()?.report?.plan).toBeUndefined()
  })

  it("tells a plan run to write a spec, and other runs nothing about specs", async () => {
    const planning = await planContext("plan")
    expect(planning.instructions()).toContain("This is a planning run")
    const implementing = await planContext()
    expect(implementing.instructions()).not.toContain("This is a planning run")
  })
})
