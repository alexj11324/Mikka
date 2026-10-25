import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, existsSync, renameSync, chmodSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const worker = join(root, 'packages/subscription-worker')
const cache = join(worker, '.cache/build-toolchain')
const version = 'go1.26.10'
const digest = 'ccfe7ae822d2c2f41f4fe7c956199967a4dac22d0ee0d2b2bfdb440aab3b20c5'
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('BYOS build requires Linux x64')
// Toolchain/dependency processes never inherit application or vault credentials.
const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: cache, CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64', GOTOOLCHAIN: 'local', GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org', GOMODCACHE: join(cache,'modules'), GOCACHE: join(cache,'objects') }
for (const key of ['HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY','SSL_CERT_FILE','SSL_CERT_DIR']) if (process.env[key]) env[key]=process.env[key]
mkdirSync(cache,{recursive:true,mode:0o700})
const archive=join(cache,`${version}.linux-amd64.tar.gz`)
const run=(bin,args,cwd=worker)=>execFileSync(bin,args,{cwd,env,stdio:['ignore','pipe','pipe'],timeout:600000})
try {
 if(!existsSync(archive)) {
  const temp=archive+'.download'
  run('curl',['--fail','--silent','--show-error','--location','--proto','=https','--proto-redir','=https','--max-time','180','--output',temp,`https://go.dev/dl/${version}.linux-amd64.tar.gz`])
  if(createHash('sha256').update(readFileSync(temp)).digest('hex')!==digest) throw new Error('toolchain integrity mismatch')
  renameSync(temp,archive)
 }
 if(createHash('sha256').update(readFileSync(archive)).digest('hex')!==digest) throw new Error('toolchain integrity mismatch')
 // Re-extract verified bytes; never trust a preinstalled compiler or prior binary.
 rmSync(join(cache,'go'),{recursive:true,force:true})
 run('tar',['-xzf',archive,'-C',cache])
 const go=join(cache,'go/bin/go')
 if(!run(go,['version']).toString().startsWith(`go version ${version} linux/amd64`)) throw new Error('toolchain version mismatch')
 run(process.execPath,[join(worker,'bootstrap.mjs')])
 mkdirSync(join(worker,'bin'),{recursive:true})
 for(const name of ['mikka-subscription-worker','mikka-subscription-enrollment']) {
  const target=resolve(worker,'bin',name)
  run(go,['build','-mod=readonly','-trimpath','-buildvcs=false','-ldflags=-s -w','-o',target+'.build',`./cmd/${name}`])
  chmodSync(target+'.build',0o755);renameSync(target+'.build',target)
  if(!run(target,['--version']).toString().includes(name)) throw new Error('binary smoke failed')
 }
 console.log('BYOS workers compiled and smoke-tested from pinned official Go and CPA sources')
} catch {
 throw new Error('BYOS worker build failed; refusing application build (tool output withheld)')
}
