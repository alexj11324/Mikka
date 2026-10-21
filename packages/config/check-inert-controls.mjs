// Lints the UI for buttons with no action and empty onClick handlers
// (ADR ORV-264). The main ESLint config carries the same rule. While the UI
// is ignored, this script is what `bun run lint` runs; once `eslint .` lints
// the tree (ADR ORV-263) the script steps aside so the two do not report the
// same files twice. `--print` still dumps the current counts.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { Linter, ESLint } from "eslint"
import tseslint from "typescript-eslint"

import { noInertControls } from "./eslint.js"

const ROOT = "apps/desktop/src/renderer"
const ALLOWLIST_PATH = join(ROOT, "inert-controls.allowlist.json")
const PROBE = join(ROOT, "components/common/issues/details/issue-details.tsx")

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (path === join(ROOT, "components/ui")) continue
      walk(path, out)
    } else if (path.endsWith(".tsx")) out.push(path)
  }
  return out
}

function verify(files, allowlist) {
  const linter = new Linter({ configType: "flat" })
  const config = [
    {
      files: ["**/*.tsx"],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
    },
    noInertControls(["**/*.tsx"], allowlist),
  ]
  const messages = []
  for (const file of files) {
    for (const message of linter.verify(
      readFileSync(file, "utf8"),
      config,
      file
    )) {
      messages.push({ file, ...message })
    }
  }
  return messages
}

const print = process.argv.includes("--print")
const files = walk(ROOT)

if (print) {
  const counts = {}
  for (const message of verify(files, null)) {
    if (message.messageId !== "inert" && message.messageId !== "empty") continue
    const key = message.file.slice(ROOT.length + 1)
    const entry = counts[key] ?? { inert: 0, empty: 0 }
    entry[message.messageId] += 1
    counts[key] = entry
  }
  console.log(JSON.stringify(counts, null, 2))
  process.exit(0)
}

const eslint = new ESLint()
if (!(await eslint.isPathIgnored(PROBE))) {
  process.exit(0)
}

const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"))
const messages = verify(files, allowlist)
if (messages.length === 0) process.exit(0)

console.error("产品界面里还有没有动作的按钮，或 allowlist 和代码对不上：")
for (const message of messages) {
  console.error(`${message.file}:${message.line} ${message.message}`)
}
console.error(
  "\n有动作的接上；没有的用 feature flag 藏起来。修掉一个控件就要在 inert-controls.allowlist.json 里把该文件的数字调低。数字只能减少。"
)
process.exit(1)
