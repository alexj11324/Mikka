// Installs the pinned harnesses with plain Node, for images built from the
// same pins as the daemon (scripts/e2b/build-template.py):
//   node harness/cli.mjs <root> [claude_code|codex ...]
// Prints each installed binary's path.
import { ensureHarness, MANAGED_HARNESSES } from './install.mjs'

const [root, ...names] = process.argv.slice(2)
if (!root) throw new Error('usage: cli.mjs <root> [harness ...]')
for (const harness of names.length ? names : MANAGED_HARNESSES) {
  if (!MANAGED_HARNESSES.includes(harness)) throw new Error(`unknown harness ${harness}`)
  console.log(await ensureHarness({ root }, harness))
}
