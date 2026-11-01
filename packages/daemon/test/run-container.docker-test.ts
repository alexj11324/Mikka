// Docker mode end to end against a real engine and the real runner image
// (harness/Dockerfile): `pnpm test:run-container`. Needs Docker and npm access.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { ensureRunnerImage, openRunContainer, sweepRunContainers } from "../src/run-container"

const owner = `test-${process.pid}`
const listed = () => execFileSync("docker", ["ps", "-aq", "--filter", `label=com.mikka.run=${owner}`], { encoding: "utf8" }).trim()

test("a run container sees only its own paths, has no open network, and is removed after the run", { timeout: 900_000 }, async () => {
  const image = await ensureRunnerImage()
  const root = mkdtempSync(join(tmpdir(), "mikka-run-container-"))
  const worktree = join(root, "tree"), runDir = join(root, "run")
  const outside = join(root, "outside")
  mkdirSync(worktree)
  mkdirSync(runDir)
  mkdirSync(outside)
  writeFileSync(join(outside, "person-login.json"), "{}")
  const asked: string[] = []
  const container = await openRunContainer({
    image, runId: "docker-test", owner, cwd: worktree,
    policy: { allowWrite: [worktree, runDir], denyWrite: [], denyRead: [], allowDomains: [] },
    onNetwork: async request => { asked.push(request.host); return false },
  })
  try {
    const script = [
      'echo "$RUN_SECRET" > out.txt',
      'touch /etc/mikka 2>/dev/null && echo ROOT-WRITABLE',
      `cat "${join(outside, "person-login.json")}" >/dev/null 2>&1 && echo HOST-FILE-VISIBLE`,
      'claude --version', 'codex --version',
      `node -e "fetch('https://example.com').then(() => console.log('NET-OPEN'), () => console.log('NET-DENIED'))"`,
    ].join("; ")
    const child = container.spawn("sh", ["-c", script], { RUN_SECRET: "only-in-env", HOME: runDir })
    let stdout = ""
    child.process.stdout.on("data", (chunk: Buffer) => { stdout += chunk })
    child.process.stdin.end()
    const exit = await child.exited
    assert.equal(exit.code, 0, child.stderrTail())
    assert.equal(readFileSync(join(worktree, "out.txt"), "utf8").trim(), "only-in-env")
    assert.match(stdout, /\(Claude Code\)/)
    assert.match(stdout, /codex-cli \d/)
    assert.match(stdout, /NET-DENIED/)
    assert.doesNotMatch(stdout, /NET-OPEN|ROOT-WRITABLE|HOST-FILE-VISIBLE/)
    assert.deepEqual(asked, ["example.com"])
    assert.equal(existsSync(join(root, "etc")), false)
    assert.equal(listed(), "")

    // A container a killed daemon left behind is removed at the next start.
    const stuck = container.spawn("sleep", ["300"], {})
    for (let i = 0; i < 100 && !listed(); i++) await new Promise(resolve => setTimeout(resolve, 100))
    assert.notEqual(listed(), "")
    await sweepRunContainers(owner)
    await stuck.exited
    assert.equal(listed(), "")
  } finally {
    await container.close()
  }
})
