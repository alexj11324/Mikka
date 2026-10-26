// Execute #265's immutable regressions against the composed canonical engine.
// Operator configuration exists only as this temporary test fixture, not a
// community management endpoint or installed runtime adapter.
import {execFileSync,spawnSync} from 'node:child_process'
import {mkdirSync,writeFileSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
import {resolve} from 'node:path'
const sha='50598846e592dbdb4b9419f96eb99b6cf5b9edbf',url=process.env.QUOTA_TEST_DATABASE_URL
if(!url||new URL(url).hostname!=='127.0.0.1'||!new URL(url).pathname.endsWith('_quota215')||['VERCEL','OPENAI_API_KEY','OPENCODE_API_KEY','AI_GATEWAY_API_KEY','COMPOSIO_API_KEY'].some(k=>process.env[k]))throw new Error('isolated quota regression database required')
const root=resolve('.'),temp=resolve('node_modules/.cache/resource-quota-'+sha.slice(0,8))
mkdirSync(temp,{recursive:true})
for(const file of ['store.test.ts','config.ts','restart-worker.ts']){
 let text=execFileSync('git',['show',`${sha}:lib/quota/${file}`],{encoding:'utf8'})
 for(const module of ['store','errors'])text=text.replaceAll(`'./${module}'`,JSON.stringify(pathToFileURL(resolve(root,'lib/quota',module+'.ts')).href))
 text=text.replaceAll("new URL('../../drizzle/20261025165100_tenant_quotas.sql', import.meta.url)",`new URL(${JSON.stringify(pathToFileURL(resolve(root,'drizzle/20261025165100_tenant_quotas.sql')).href)})`)
 text=text.replaceAll("new URL('../..',import.meta.url)",`new URL(${JSON.stringify(pathToFileURL(root+'/').href)})`)
 writeFileSync(resolve(temp,file),text)
}
console.log(JSON.stringify({upstream:sha,subject:'current lib/quota/store.ts and errors.ts',operatorFixture:'temporary test only',production:false}))
const result=spawnSync(process.execPath,['--import','tsx','--test',resolve(temp,'store.test.ts')],{stdio:'inherit',env:process.env})
process.exitCode=result.status??1
