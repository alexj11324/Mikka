import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import https from 'node:https'
import assert from 'node:assert/strict'
import { Cdp } from './browser.ts'
import { fillCredential } from './broker.ts'
import { seal } from './kms.ts'
async function _retainedFixture() {
const dir=mkdtempSync(join(tmpdir(),'mikka-broker-cdp-')), cert=join(dir,'cert.pem'), key=join(dir,'key.pem')
if (spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1'],{stdio:'ignore'}).status!==0) throw Error('fixture certificate failed')
const server=https.createServer({key:readFileSync(key),cert:readFileSync(cert)},(_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<input id="fixture" type="password">')})
let chrome, setup, verify
try {
 await new Promise(r=>server.listen(0,'127.0.0.1',r)); const origin=`https://127.0.0.1:${server.address().port}`
 chrome=spawn('/usr/bin/chromium',['--headless=new','--no-sandbox','--disable-gpu','--disable-background-networking','--ignore-certificate-errors',`--user-data-dir=${dir}/profile`,'--remote-debugging-port=0','about:blank'],{stdio:'ignore'})
 let debug; for(let i=0;i<150;i++){try{debug=readFileSync(join(dir,'profile','DevToolsActivePort'),'utf8').trim().split('\n');break}catch{await new Promise(r=>setTimeout(r,100))}}
 if(!debug)throw Error('fixture Chromium unavailable')
 const ws=`ws://127.0.0.1:${debug[0]}${debug[1]}`; setup=await Cdp.connect(ws)
 const targetId=(await setup.call('Target.createTarget',{url:origin})).targetId; await setup.attach(targetId)
 let frame,node; for(let i=0;i<100;i++){try{frame=(await setup.call('Page.getFrameTree')).frameTree.frame;const root=(await setup.call('DOM.getDocument',{depth:-1,pierce:false})).root;const find=n=>n?.nodeName==='INPUT'?n:(n?.children??[]).map(find).find(Boolean);node=find(root);if(frame.url.startsWith(origin)&&node)break}catch{}await new Promise(r=>setTimeout(r,100))}
 if(!node||!frame?.loaderId)throw Error('fixture page unavailable')
 const context={userId:'fixture-owner',credentialId:'fixture-credential',origin}; let dek
 const kms={async generate(){dek=randomBytes(32);return{plaintext:Buffer.from(dek),wrapped:'fixture-wrap'}},async decrypt(wrapped,c){assert.equal(wrapped,'fixture-wrap');assert.deepEqual(c,context);return Buffer.from(dek)}}
 const encrypted=await seal(kms,context,Buffer.from(JSON.stringify({username:'fixture-user',password:'synthetic-fixture'})))
 const target={targetId,origin,endpoint:'https://fixture.e2b.app/',expiresAt:Date.now()+60000,credentialMode:'password',credentialRevision:encrypted.nonce,observedInput:{loaderId:frame.loaderId,backendNodeId:node.backendNodeId,credentialRole:'password',epoch:1,permissionVersion:0}}
 const claimed={user_id:context.userId,workspace_id:'fixture-workspace',bot_id:'fixture-bot',subagent_id:'fixture-subagent',run_id:null,credential_id:context.credentialId,origin,input_kind:'password',target}; let claimCount=0,guardEnded=false
 const client={async query(sql){if(sql.includes('FROM bots ')||sql.includes('FROM bot_subagents WHERE'))return{rows:[{id:'fixture'}]};if(sql.includes('FROM bot_subagents s LEFT JOIN'))return{rows:[{targetId,epoch:1,permissionVersion:0,permission:'ask'}]};if(sql.includes('JOIN credential_secrets'))return{rows:[{wrapped_dek:encrypted.wrappedDek,nonce:encrypted.nonce,ciphertext:encrypted.ciphertext,username:'fixture-user'}]};if(sql.includes('FROM browser_sessions'))return{rows:[]};return{rows:[]}},release(){}}
 const pool={async query(sql){if(sql.includes('WITH candidate'))return{rows:claimCount++===0?[claimed]:[]};return{rows:[]}},async connect(){return client}}
 const guard={async begin(){return{cdpUrl:ws,targetId,guardToken:'synthetic-guard'}},async end(){guardEnded=true}}
 const result=await fillCredential(pool,'a'.repeat(43),{kms,guard,connect:async()=>Cdp.connect(ws)})
 assert.deepEqual(result,{status:'guarded',origin});assert.equal(guardEnded,false)
 verify=await Cdp.connect(ws);await verify.attach(targetId);assert.equal(await verify.evaluate("document.querySelector('#fixture').value === 'synthetic-fixture'"),true)
 await assert.rejects(fillCredential(pool,'a'.repeat(43),{kms,guard,connect:async()=>Cdp.connect(ws)}) )
 console.log(JSON.stringify({environment:'isolated Linux Chromium with local synthetic HTTPS fixture',syntheticLease:'single-use',realCdpInsertion:'pass',viewerGuard:'simulated and retained',realGateway:false,realAccount:false}))
}finally{ void chrome /* Retain all resources. */ }
}
throw new Error('Credential browser fixture is on retention hold; do not start or destroy resources')
