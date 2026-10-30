import { test, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectHarnessModels } from "./harness-models";

test("Codex catalogue is obtained from the CLI account via model/list", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mikka-models-"));
  try {
    const binary = join(dir, "codex");
    await writeFile(
      binary,
      `#!/usr/bin/env node
const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 if(request.method==='initialize') console.log(JSON.stringify({id:request.id,result:{}}));
 if(request.method==='model/list') console.log(JSON.stringify({id:request.id,result:{data:[{model:'account-specific'},{model:'second-model'}]}}));
});`,
      { mode: 0o700 },
    );
    expect(await detectHarnessModels("codex", binary)).toEqual([
      "account-specific",
      "second-model",
    ]);
    expect(await detectHarnessModels("claude_code", binary)).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Cursor catalogue is parsed; unsupported or failed CLIs advertise auto only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mikka-models-"));
  try {
    const binary = join(dir, "cursor-agent");
    await writeFile(
      binary,
      "#!/usr/bin/env node\nconsole.log('Available models:\\n  account-model - Account model\\n  second-model - Second model')",
      { mode: 0o700 },
    );
    expect(await detectHarnessModels("cursor", binary)).toEqual([
      "account-model",
      "second-model",
    ]);
    expect(
      await detectHarnessModels("cursor", join(dir, "missing")),
    ).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
