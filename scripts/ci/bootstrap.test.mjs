import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'mikka-ci-trust-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'CI fixture',GIT_AUTHOR_EMAIL:'ci@example.invalid',GIT_COMMITTER_NAME:'CI fixture',GIT_COMMITTER_EMAIL:'ci@example.invalid'}
  const git=(...args)=>execFileSync('git',args,{cwd:root,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
  const write=(file,source)=>{mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),source)}
  git('init','-q','--initial-branch=main')
  return {root,env,git,write}
}
test('actual bootstrap loads the immutable base selector even if PR replaces it', t=>{
  const f=fixture(t)
  f.write('scripts/ci/select.mjs',`import fs from 'node:fs';if(!fs.existsSync(process.env.CI_CANDIDATE_ROOT+'/candidate-marker'))throw Error('candidateRootRequired');fs.appendFileSync(process.env.GITHUB_OUTPUT,'trusted=true\\n')`)
  f.git('add','.');f.git('commit','-qm','trusted base')
  const base=f.git('rev-parse','HEAD')
  f.git('update-ref','refs/remotes/origin/main',base)
  f.git('switch','-qc','candidate')
  f.write('scripts/ci/select.mjs',`import fs from 'node:fs';fs.writeFileSync('bypass-marker','unsafe')`)
  f.write('candidate-marker','candidate')
  f.git('add','.');f.git('commit','-qm','untrusted selector modification')
  const head=f.git('rev-parse','HEAD')
  f.write('event.json',JSON.stringify({pull_request:{base:{sha:base},head:{sha:head,repo:{full_name:'fork/repo'}}}}))
  // The trusted installer is stubbed only in this offline loader test; it must
  // receive immutable manifests and --ignore-scripts, never the candidate cwd.
  f.write('bin/pnpm',`#!/bin/sh\ncase "$*" in *--ignore-scripts*) exit 0;; *) exit 1;; esac\n`)
  execFileSync('chmod',['+x',join(f.root,'bin/pnpm')])
  const output=join(f.root,'output')
  execFileSync('bash',[resolve('scripts/ci/bootstrap.sh')],{cwd:f.root,env:{...f.env,PATH:`${f.root}/bin:${f.env.PATH}`,GITHUB_EVENT_PATH:join(f.root,'event.json'),GITHUB_OUTPUT:output},stdio:'pipe'})
  assert.match(readFileSync(output,'utf8'),/trusted=true/)
  assert(!existsSync(join(f.root,'bypass-marker')))
})
test('first-introduction workflow runs trusted legacy inventory and forces full coverage',t=>{
  const f=fixture(t)
  for(const file of ['scripts/run-db-tests.mjs','tests/helpers/e2e-target.mjs']) f.write(file,readFileSync(file))
  f.write('package.json',JSON.stringify({type:'module',scripts:{'test:fixture-db':'node --test tests/fixture.db.test.mjs'}}))
  f.write('tests/fixture.db.test.mjs','// synthetic inventory test file\n')
  f.git('add','.');f.git('commit','-qm','legacy base');f.git('remote','add','origin',f.root)
  const base=f.git('rev-parse','HEAD')
  f.git('switch','-qc','candidate')
  f.write('scripts/ci/bootstrap.sh','touch bypass-marker')
  f.write('scripts/ci/select.mjs','throw Error("untrusted")')
  f.git('add','.');f.git('commit','-qm','candidate adds selector')
  const event=join(f.root,'event.json'),output=join(f.root,'output'),summary=join(f.root,'summary')
  writeFileSync(event,JSON.stringify({pull_request:{base:{sha:base},head:{sha:f.git('rev-parse','HEAD')}}}))
  const workflow=readFileSync('.github/workflows/ci-selection.yml','utf8')
  const body=workflow.split('      - id: select\n')[1].split('        run: |\n')[1].split('\n').map(l=>l.slice(10)).join('\n')
  execFileSync('bash',['-e','-c',body],{cwd:f.root,env:{...f.env,GITHUB_EVENT_PATH:event,GITHUB_OUTPUT:output,GITHUB_STEP_SUMMARY:summary},stdio:'pipe'})
  const result=readFileSync(output,'utf8')
  for(const key of ['core','integration','source','daemon','desktop','image','analytics','db']) assert(result.includes(`${key}=true`))
  assert(result.includes('test:fixture-db'))
  assert(!existsSync(join(f.root,'bypass-marker')))
})

test('real trusted Nx selection parses candidate files without loading candidate plugins', t => {
  const f = fixture(t)
  f.write('package.json',JSON.stringify({type:'module',scripts:{'test:fixture-db':'node --test tests/fixture.db.test.ts'}}))
  f.write('tests/fixture.db.test.ts','')
  f.write('apps/mobile/lib/theme.ts','export const color = 1\n')
  f.write('nx.json',JSON.stringify({plugins:['./poison.cjs']}))
  f.write('poison.cjs',"require('node:fs').writeFileSync('plugin-executed','unsafe');module.exports={}")
  f.git('add','.');f.git('commit','-qm','candidate base')
  const base = f.git('rev-parse','HEAD')
  f.write('apps/mobile/lib/theme.ts','export const color = 2\n')
  f.git('add','.');f.git('commit','-qm','mobile edit')
  const result = join(f.root,'selection.json')
  execFileSync(process.execPath,[resolve('scripts/ci/select.mjs')],{
    cwd:f.root,env:{...f.env,CI_BASE:base,CI_HEAD:f.git('rev-parse','HEAD'),CI_CANDIDATE_ROOT:f.root,CI_SELECTION_FILE:result,GITHUB_EVENT_PATH:'',GITHUB_OUTPUT:'',GITHUB_STEP_SUMMARY:'',NX_DAEMON:'false'},stdio:'pipe',
  })
  assert(!existsSync(join(f.root,'plugin-executed')))
  const selection = JSON.parse(readFileSync(result,'utf8'))
  assert.equal(selection.full,false)
  assert.equal(selection.mobile,true)
  assert.deepEqual(selection.db_suites,[])
})

test('a PR targeting an unmerged branch cannot supply its own trusted policy', t => {
  const f=fixture(t)
  f.write('scripts/ci/select.mjs',`import fs from 'node:fs';fs.appendFileSync(process.env.GITHUB_OUTPUT,'trusted=true\\nforce='+process.env.CI_FORCE_FULL+'\\n')`)
  f.git('add','.');f.git('commit','-qm','reviewed main')
  const main=f.git('rev-parse','HEAD')
  f.git('update-ref','refs/remotes/origin/main',main)
  f.git('switch','-qc','unmerged-base')
  f.write('scripts/ci/select.mjs',"import fs from 'node:fs';fs.writeFileSync('bypass-marker','unsafe')")
  f.git('add','.');f.git('commit','-qm','untrusted base policy')
  const base=f.git('rev-parse','HEAD')
  f.git('switch','-qc','candidate')
  f.write('candidate-marker','candidate')
  f.git('add','.');f.git('commit','-qm','candidate')
  f.write('event.json',JSON.stringify({pull_request:{base:{sha:base},head:{sha:f.git('rev-parse','HEAD')}}}))
  f.write('bin/pnpm','#!/bin/sh\nexit 0\n')
  execFileSync('chmod',['+x',join(f.root,'bin/pnpm')])
  const output=join(f.root,'output')
  execFileSync('bash',[resolve('scripts/ci/bootstrap.sh')],{cwd:f.root,env:{...f.env,PATH:`${f.root}/bin:${f.env.PATH}`,GITHUB_EVENT_PATH:join(f.root,'event.json'),GITHUB_OUTPUT:output},stdio:'pipe'})
  assert.match(readFileSync(output,'utf8'),/trusted=true\nforce=true/)
  assert(!existsSync(join(f.root,'bypass-marker')))
})
