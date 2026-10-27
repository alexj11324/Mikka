import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const root = fileURLToPath(new URL(".", import.meta.url))
const upstream = join(root, ".upstream")
const pin = readFileSync(join(root, "CPA_COMMIT"), "utf8").trim()
if (!/^[a-f0-9]{40}$/.test(pin)) throw new Error("Invalid CPA pin")
const env = {
  PATH: process.env.PATH,
  LANG: "C.UTF-8",
  GIT_TERMINAL_PROMPT: "0"
}
for (const name of [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR"
])
  if (process.env[name]) env[name] = process.env[name]
const git = (...args) => {
  try {
    return execFileSync(
      "git",
      [
        "-c",
        "credential.helper=",
        "-c",
        "credential.interactive=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args
      ],
      { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim()
  } catch {
    throw new Error("CPA git operation failed; existing checkout preserved")
  }
}
if (!existsSync(upstream)) {
  mkdirSync(upstream, { mode: 0o700 })
  git("-C", upstream, "init", "-q")
  git(
    "-C",
    upstream,
    "remote",
    "add",
    "origin",
    "https://github.com/router-for-me/CLIProxyAPI.git"
  )
}
let head
try {
  head = git("-C", upstream, "rev-parse", "--verify", "HEAD")
} catch {}
if (!head) {
  if (
    git("-C", upstream, "remote", "get-url", "origin") !==
    "https://github.com/router-for-me/CLIProxyAPI.git"
  )
    throw new Error("Unexpected CPA remote; preserved")
  git("-C", upstream, "fetch", "--depth", "1", "--no-tags", "origin", pin)
  git("-C", upstream, "checkout", "--detach", "FETCH_HEAD")
}
if (git("-C", upstream, "rev-parse", "HEAD") !== pin)
  throw new Error("Existing CPA checkout has a different pin; preserved")
if (git("-C", upstream, "diff", "--name-only", "HEAD", "--"))
  throw new Error("Tracked CPA modifications found; preserved")
const untracked = git(
  "-C",
  upstream,
  "ls-files",
  "--others",
  "--exclude-standard"
)
  .split("\n")
  .filter(Boolean)
const bridges = [
  ["compat/bridge.go.txt", "sdk/mikkaadapter/bridge.go"],
  ["compat/codex-http.go.txt", "internal/auth/codex/mikka_http.go"],
  ["compat/claude-http.go.txt", "internal/auth/claude/mikka_http.go"]
]
if (untracked.some((path) => !bridges.some(([, target]) => path === target)))
  throw new Error("Unexpected untracked CPA files; preserved")
for (const [source, destination] of bridges) {
  const bridge = readFileSync(join(root, source), "utf8")
  const target = join(upstream, destination)
  if (existsSync(target) && readFileSync(target, "utf8") !== bridge)
    throw new Error("Modified CPA bridge found; preserved")
  mkdirSync(join(upstream, destination.substring(0, destination.lastIndexOf('/'))), { recursive: true, mode: 0o700 })
  writeFileSync(target, bridge, { mode: 0o600 })
}
console.log(`CPA source verified: ${pin}; credential type bridge installed`)
