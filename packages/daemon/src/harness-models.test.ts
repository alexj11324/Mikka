import { test, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectHarnessModels,
  detectHarnessCatalogue,
  claudeModelCatalogue,
  claudeDiscoveryEnv,
} from "./harness-models";

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
 if(request.method==='model/list') console.log(JSON.stringify({id:request.id,result:{data:[{model:'account-specific'},{model:'second-model',isDefault:true,displayName:'Account default'}]}}));
});`,
      { mode: 0o700 },
    );
    expect(await detectHarnessModels("codex", binary)).toEqual([
      "account-specific",
      "second-model",
    ]);
    const catalogue = await detectHarnessCatalogue("codex", binary);
    expect(catalogue.defaultModelSlot).toBe("default");
    expect(catalogue.modelSlots?.find((s) => s.slot === "default")?.model).toBe(
      "second-model",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Cursor catalogue is parsed; unsupported or failed CLIs advertise no models", async () => {
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

test("Claude slots use the CLI resolved values, including user environment/settings remaps", () => {
  for (const resolved of ["reported-opus-model", "third-party-flash"]) {
    expect(
      claudeModelCatalogue([
        { value: "opus", resolvedModel: resolved, displayName: "Opus" },
      ]),
    ).toEqual({
      models: ["opus"],
      defaultModelSlot: "opus",
      modelSlots: [{ slot: "opus", model: resolved, name: resolved }],
    });
  }
  expect(
    claudeModelCatalogue([{ value: "opus", displayName: "Opus" }]).modelSlots,
  ).toEqual([]);
  expect(
    claudeDiscoveryEnv({
      ANTHROPIC_DEFAULT_OPUS_MODEL: "third-party-flash",
      ANTHROPIC_API_KEY: "secret",
      GITHUB_TOKEN: "secret",
    }),
  ).toEqual({ ANTHROPIC_DEFAULT_OPUS_MODEL: "third-party-flash" });
});

test("Claude SDK discovery initializes without a model call and preserves environment and settings mappings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mikka-claude-models-"));
  const key = "ANTHROPIC_DEFAULT_OPUS_MODEL";
  const previous = process.env[key];
  try {
    const binary = join(dir,"claude");
    await writeFile(binary,`#!/usr/bin/env node
const readline=require('node:readline');
const fs=require('node:fs');
const path=require('node:path');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const msg=JSON.parse(line);
 if(msg.type==='user') process.exit(2);
 if(msg.type==='control_request' && msg.request.subtype==='initialize') {
  const model=process.env.ANTHROPIC_DEFAULT_OPUS_MODEL || fs.readFileSync(path.join(__dirname,'model.txt'),'utf8');
  console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:msg.request_id,response:{models:[{value:'opus',resolvedModel:model,displayName:'Opus',description:''}],commands:[],agents:[],account:{}}}}));
 }
});`,{mode:0o700});
    delete process.env[key];
    await writeFile(join(dir,"model.txt"),"cli-reported-opus");
    expect((await detectHarnessCatalogue("claude_code",binary)).modelSlots?.[0]).toEqual({slot:"opus",model:"cli-reported-opus",name:"cli-reported-opus"});
    await writeFile(join(dir,"model.txt"),"settings-remapped-model");
    expect((await detectHarnessCatalogue("claude_code",binary)).modelSlots?.[0].model).toBe("settings-remapped-model");
    process.env[key]="environment-remapped-model";
    expect((await detectHarnessCatalogue("claude_code",binary)).modelSlots?.[0].model).toBe("environment-remapped-model");
  } finally {
    if(previous===undefined)delete process.env[key];else process.env[key]=previous;
    await rm(dir,{recursive:true,force:true});
  }
},20_000);
