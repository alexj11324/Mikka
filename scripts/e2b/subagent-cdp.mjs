// Infrastructure only. Chrome has no TCP CDP port; no protocol data is logged.
import {spawn} from 'node:child_process'
import {createServer} from 'node:net'
import {mkdirSync,chmodSync} from 'node:fs'
const [id,display] = process.argv.slice(2)
if (display && !/^[1-9][0-9]{0,2}$/.test(display)) process.exit(2)
if (!/^[a-f0-9-]{36}$/.test(id)) process.exit(2)
const path = `/run/mikka-subagents/${id}/cdp.sock`
const profile = `/home/user/.mikka/subagents/${id}`
mkdirSync(profile,{recursive:true,mode:0o700})
// Start the browser as the desktop account, never the root gateway identity.
const {chownSync}=await import('node:fs');chownSync('/home/user/.mikka',1000,1000);chownSync('/home/user/.mikka/subagents',1000,1000);chownSync(profile,1000,1000)
const chrome = spawn('/usr/bin/chromium',[...(display?[]:['--headless']),'--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--password-store=basic','--remote-debugging-pipe',`--user-data-dir=${profile}`,'--window-size=1280,800','about:blank'],{uid:1000,gid:1000,env:{...process.env,...(display?{DISPLAY:`:${display}`}:{})},stdio:['ignore','ignore','ignore','pipe','pipe']})
let seq=0,buffer='';const clients=new Set(),pending=new Map()
chrome.stdio[4].on('data',data=>{buffer+=data;let at;while((at=buffer.indexOf('\0'))>=0){let message;try{message=JSON.parse(buffer.slice(0,at))}catch{process.exit(1)}buffer=buffer.slice(at+1);if(message.id){const call=pending.get(message.id);if(call){pending.delete(message.id);call.socket.write(JSON.stringify({...message,id:call.id})+'\n')}}else for(const socket of clients)socket.write(JSON.stringify(message)+'\n')}})
const server=createServer(socket=>{clients.add(socket);let input='';socket.on('data',data=>{input+=data;if(input.length>4*1024*1024){socket.destroy();return}let at;while((at=input.indexOf('\n'))>=0){try{const message=JSON.parse(input.slice(0,at));const id=++seq;pending.set(id,{socket,id:message.id});chrome.stdio[3].write(JSON.stringify({...message,id})+'\0')}catch{socket.destroy()}input=input.slice(at+1)}});socket.on('close',()=>{clients.delete(socket);for(const [id,call]of pending)if(call.socket===socket)pending.delete(id)})})
server.listen(path,()=>chmodSync(path,0o600))
chrome.on('exit',()=>process.exit(1))
process.on('SIGTERM',()=>{chrome.kill('SIGTERM');server.close();process.exit()})
