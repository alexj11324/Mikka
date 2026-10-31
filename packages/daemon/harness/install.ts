// Installs the pinned harnesses with plain Node, for images built from the
// same pins as the daemon (scripts/e2b/build-template.py):
//   node harness/install.ts <root> [claude_code|codex ...]
// Prints each installed binary's path.
import { ensureHarness, MANAGED_HARNESSES, type ManagedHarness } from "../src/harness-install.ts"

const [root, ...names] = process.argv.slice(2)
if (!root) throw new Error("usage: install.ts <root> [harness ...]")
const wanted = (names.length ? names : MANAGED_HARNESSES) as ManagedHarness[]
for (const harness of wanted) {
  if (!MANAGED_HARNESSES.includes(harness)) throw new Error(`unknown harness ${harness}`)
  console.log(await ensureHarness({ root }, harness))
}
