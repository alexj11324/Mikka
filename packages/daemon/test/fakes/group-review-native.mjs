#!/usr/bin/env node
// Controlled protocol fixture only. Never calls a model, reads auth or tools.
import {basename} from 'node:path'
import {readFileSync,writeFileSync,existsSync} from 'node:fs'
import {connect} from 'node:net'
import {spawn} from 'node:child_process'
const claude=basename(process.argv[1])==='claude',args=process.argv.slice(2)
if(args.includes('--version')){console.log(claude?'2.1.290 (Claude Code)':'codex-cli 0.162.1');process.exit(0)}
if(args.includes('features')&&args.includes('list')){if(!args.includes('features.multi_agent_v2=false'))throw Error('V2 not disabled');console.log('shell_tool stable false\napply_patch_freeform stable false\nmulti_agent stable false\nmulti_agent_v2 stable false');process.exit(0)}
if(args.includes('--help')){console.log('--bare --restricted --tools --disallowedTools --strict-mcp-config --mcp-config --output-format --setting-sources --no-session-persistence --json-schema --max-turns --system-prompt --ignore-user-config --ephemeral --skip-git-repo-check --sandbox --json --output-schema --output-last-message --config');process.exit(0)}
for(const path of ['/workspace/Mikka','/workspace/mikka-group-artifact-integration','/root/.codex/auth.json','/root/.claude/.credentials.json'])if(existsSync(path))throw Error('Host context leaked')
if(process.env.PRIVATE_HOST_SENTINEL||process.env.ANTHROPIC_API_KEY||process.env.OPENAI_API_KEY||process.env.MIKKA_MAILBOX_TOKEN||process.env.DOCKER_HOST||process.env.DOCKER_CONTEXT)throw Error('Host environment leaked')
if(process.cwd()!=='/scratch/work'||process.env.HOME!=='/scratch/home')throw Error('Wrong group context')
let readonly=false;try{writeFileSync('/mikka-group-escape','forbidden')}catch{readonly=true}if(!readonly)throw Error('Writable image root')
await new Promise((resolve,reject)=>{const s=connect({host:'198.51.100.1',port:443});s.on('connect',()=>{s.destroy();reject(Error('Unexpected network'))});s.on('error',()=>resolve());s.setTimeout(100,()=>{s.destroy();resolve()})})
const pieces=[];for await(const d of process.stdin)pieces.push(d)
const request=JSON.parse(Buffer.concat(pieces).toString('utf8')),text=JSON.stringify(request)
if(text.includes('fixture:unicode')&&!text.includes('中文🌍'.repeat(4000)))throw Error('Unicode context was corrupted')
if(!request.untrustedData||text.includes('PRIVATE_INSTRUCTIONS_SENTINEL')||text.includes('PRIVATE_CHAT_SENTINEL'))throw Error('Private instructions leaked')
if(text.includes('fixture:delay'))await new Promise(resolve=>setTimeout(resolve,1500))
if(text.includes('fixture:wait'))await new Promise(resolve=>setTimeout(resolve,30000))
if(text.includes('fixture:oversized')){process.stdout.write('x'.repeat(4_400_000));process.exit(0)}
if(claude){for(const flag of ['--bare','--restricted','--tools','--disallowedTools','--no-session-persistence','--strict-mcp-config'])if(!args.includes(flag))throw Error('Missing Claude guard');if(args[args.indexOf('--tools')+1]!==''||args[args.indexOf('--disallowedTools')+1]!=='*')throw Error('Tools enabled')}
else{for(const flag of ['--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','--output-schema','--output-last-message'])if(!args.includes(flag))throw Error('Missing Codex guard');if(args[args.indexOf('--sandbox')+1]!=='read-only'||!args.includes('features.shell_tool=false')||!args.includes('mcp_servers={}')||!args.includes('features.multi_agent_v2=false'))throw Error('Codex capabilities broadened');JSON.parse(readFileSync(args[args.indexOf('--output-schema')+1],'utf8'))}
const result={body:(claude?'CC':'Codex')+' controlled reply 中文 🌍',content:request.untrustedData.artifact?'# Controlled revision 中文 🌍':null}
if(text.includes('fixture:drain'))result.content='中文🌍'+'x'.repeat(900000)
if(text.includes('fixture:shape'))result.extra='not allowed'
if(text.includes('fixture:content-limit'))result.content='x'.repeat(1_000_001)
const content=text.includes('fixture:malformed')?'not json':JSON.stringify(result)
const nativeOutput=claude?(text.includes('fixture:malformed')?content:JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:result})):JSON.stringify({type:'item.completed',item:{type:text.includes('fixture:tool')||text.includes('fixture:drain-tool')?'command_execution':'agent_message',text:'done'}})
if(!claude)writeFileSync(args[args.indexOf('--output-last-message')+1],content)
if(text.includes('fixture:drain')){
 writeFileSync('/scratch/drain-output.json',nativeOutput)
 // Parent exits before its grandchild writes: exit != stdio-close. This also
 // proves a late tool event cannot disappear before the result is admitted.
 spawn(process.execPath,['-e',`const s=require('fs').readFileSync('/scratch/drain-output.json');setTimeout(()=>process.stdout.write(s.subarray(0,200000),()=>setTimeout(()=>process.stdout.write(s.subarray(200000)),30)),100)`],{stdio:['ignore','inherit','inherit']})
 process.exit(0)
}
console.log(nativeOutput)
