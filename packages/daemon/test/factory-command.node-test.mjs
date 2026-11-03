import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../src/agents/mikka-mcp.mjs", import.meta.url);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "factory-command-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(root, "README.md"), "# Fixture\n");
  writeFileSync(
    join(root, "check.mjs"),
    `import assert from 'node:assert/strict';import fs from 'node:fs';assert.match(fs.readFileSync('README.md','utf8'),/^# Fixture/);assert.equal(process.env.ANTHROPIC_API_KEY,undefined);console.log('REAL_CHECK_PASSED')`,
  );
  writeFileSync(join(root, "Makefile"), "test:\n\tnode check.mjs\n");
  writeFileSync(
    join(root, "slow.mjs"),
    `import fs from 'node:fs';fs.writeFileSync('.git/slow.pid',String(process.pid));setTimeout(()=>fs.writeFileSync('ESCAPED','bad'),4000)`,
  );
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "Fixture",
  );
  return { root, git, sha: git("rev-parse", "HEAD") };
}
function client(root, config) {
  const file = join(root, ".git", "host-check.json");
  if (config) writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const proc = spawn(
    process.execPath,
    [
      script.pathname,
      "--handoff",
      join(root, "handoff.json"),
      ...(config ? ["--check-config", file] : []),
    ],
    {
      cwd: root,
      env: { ...process.env, ANTHROPIC_API_KEY: "fixture-secret" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let buffer = "",
    seq = 0;
  const pending = new Map();
  proc.stdout.on("data", (data) => {
    buffer += data;
    for (;;) {
      const i = buffer.indexOf("\n");
      if (i < 0) break;
      const message = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      pending.get(message.id)?.(message.result);
      pending.delete(message.id);
    }
  });
  return {
    close: () => proc.stdin.end(),
    call: (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        proc.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        );
      }),
  };
}

test(
  "real MCP verification is host-bound, executes actual commands, retains file-only native policy and supports text criteria",
  { timeout: 15000 },
  async () => {
    const f = fixture();
    const c = client(f.root, {
      worktree: f.root,
      candidateSha: f.sha,
      command: "node check.mjs",
      gitDir: join(f.root, ".git"),
    });
    try {
      const { tools } = await c.call("tools/list");
      assert.ok(tools.some((tool) => tool.name === "verify_command"));
    assert.ok(tools.some((tool) => tool.name === "inspect_candidate"));
    const inspected=await c.call('tools/call',{name:'inspect_candidate',arguments:{}})
    assert.equal(JSON.parse(inspected.content[0].text).sha,f.sha)

      const criterion = tools.find((tool) => tool.name === "submit").inputSchema
        .properties.criteria.items;
      assert.ok(
        criterion.properties.text,
        "Ordinary issues have text criteria without synthetic UUIDs",
      );
      const rejected = await c.call("tools/call", {
        name: "verify_command",
        arguments: { command: "touch PWNED" },
      });
      assert.equal(rejected.isError, true);
      assert.equal(existsSync(join(f.root, "PWNED")), false);
      const checked = await c.call("tools/call", {
        name: "verify_command",
        arguments: { command: "node check.mjs" },
      });
      assert.equal(checked.isError, undefined);
      const receipt = JSON.parse(checked.content[0].text);
      assert.equal(receipt.exitCode, 0);
      assert.equal(receipt.sha, f.sha);
      assert.equal(receipt.readOnly, true);
      assert.match(receipt.output, /REAL_CHECK_PASSED/);
      assert.equal(f.git("status", "--porcelain"), "");
    } finally {
      c.close();
    }
  },
);

test(
  "inference uses a declared repository entrypoint; dirty HEAD, invented commands and unfenced access fail",
  { timeout: 15000 },
  async () => {
    const f = fixture();
    const c = client(f.root, {
      worktree: f.root,
      candidateSha: f.sha,
      gitDir: join(f.root, ".git"),
      infer: true,
    });
    try {
      const bad = await c.call("tools/call", {
        name: "verify_command",
        arguments: { command: "touch PWNED", basis: "I made this up" },
      });
      assert.equal(bad.isError, true);
      assert.equal(existsSync(join(f.root, "PWNED")), false);
      const good = await c.call("tools/call", {
        name: "verify_command",
        arguments: {
          command: "make test",
          basis: "Makefile test target invokes check.mjs",
        },
      });
      assert.equal(good.isError, undefined);
      assert.equal(JSON.parse(good.content[0].text).exitCode, 0);
      writeFileSync(join(f.root, "README.md"), "changed\n");
      assert.equal(
        (
          await c.call("tools/call", {
            name: "verify_command",
            arguments: { command: "make test", basis: "Makefile test target" },
          })
        ).isError,
        true,
      );
    } finally {
      c.close();
    }
    const unbound = client(f.root);
    try {
      assert.equal(
        (await unbound.call("tools/list")).tools.some(
          (tool) => tool.name === "verify_command",
        ),
        false,
      );
    } finally {
      unbound.close();
    }
  },
);

test(
  "a timed out verification is not a pass and its process group stops",
  { timeout: 15000 },
  async () => {
    const f = fixture();
    const c = client(f.root, {
      worktree: f.root,
      candidateSha: f.sha,
      command: "node slow.mjs",
      gitDir: join(f.root, ".git"),
      timeoutMs: 200,
    });
    try {
      const result = await c.call("tools/call", {
        name: "verify_command",
        arguments: { command: "node slow.mjs" },
      });
      const receipt = JSON.parse(result.content[0].text);
      assert.equal(receipt.timedOut, true);
      assert.notEqual(receipt.exitCode, 0);
      const pid = Number(readFileSync(join(f.root, ".git/slow.pid"), "utf8"));
      try {
        process.kill(pid, 0);
        assert.match(readFileSync(`/proc/${pid}/stat`, "utf8"), /\) Z /);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      assert.equal(existsSync(join(f.root, "ESCAPED")), false);
    } finally {
      c.close();
    }
  },
);
