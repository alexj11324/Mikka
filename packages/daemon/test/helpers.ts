import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { execa } from "execa"

const dirs: string[] = []

export function tempDir(prefix = "orvd-"): string {
  // Short base path: Unix socket paths are limited to ~104 bytes on macOS.
  const dir = mkdtempSync(
    join(process.platform === "darwin" ? "/tmp" : tmpdir(), prefix)
  )
  dirs.push(dir)
  return dir
}

export function cleanupTempDirs() {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
}

/** A git repo with one commit on `main`, a git-ignored `.env.local` and an npm test script. */
export async function makeRepo(): Promise<string> {
  const repo = tempDir("orvr-")
  const git = (...args: string[]) =>
    execa("git", args, {
      cwd: repo,
      env: {
        GIT_AUTHOR_NAME: "Orvilo Test",
        GIT_AUTHOR_EMAIL: "test@orvilo.invalid",
        GIT_COMMITTER_NAME: "Orvilo Test",
        GIT_COMMITTER_EMAIL: "test@orvilo.invalid",
      },
    })
  await git("init", "-q", "-b", "main")
  writeFileSync(join(repo, "README.md"), "# Sandbox\n")
  writeFileSync(join(repo, ".gitignore"), ".env.local\nsetup-ran\n")
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      name: "sandbox",
      private: true,
      scripts: {
        test: "node -e \"const fs=require('fs');if(!fs.existsSync('.env.local')||!fs.existsSync('setup-ran'))process.exit(1);console.log('sandbox tests passed')\"",
      },
    })
  )
  await git("add", ".")
  await git("commit", "-q", "-m", "init")
  writeFileSync(join(repo, ".env.local"), "SANDBOX=1\n")
  return repo
}

export async function waitFor<T>(
  check: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 15_000,
  intervalMs = 25
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
