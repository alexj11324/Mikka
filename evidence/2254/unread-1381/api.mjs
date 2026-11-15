import http from 'node:http'
import {Readable} from 'node:stream'
import api from '../../../../apps/api/src/index.ts'
const allowed='127.0.0.1:3100'
const server=http.createServer(async(incoming,outgoing)=>{
 try {
  if(incoming.headers.host!==allowed){outgoing.writeHead(400).end();return}
  const url=new URL(incoming.url,'http://'+allowed)
  if(url.host!==allowed){outgoing.writeHead(403).end();return}
  const headers=new Headers()
  for(let i=0;i<incoming.rawHeaders.length;i+=2)headers.append(incoming.rawHeaders[i],incoming.rawHeaders[i+1])
  const body=['GET','HEAD'].includes(incoming.method)?undefined:Readable.toWeb(incoming)
  const result=await api.fetch(new Request(url,{method:incoming.method,headers,...(body?{body,duplex:'half'}:{})}))
  for(const [key,value] of result.headers)if(key!=='set-cookie')outgoing.setHeader(key,value)
  const cookies=result.headers.getSetCookie();if(cookies.length)outgoing.setHeader('set-cookie',cookies)
  outgoing.writeHead(result.status)
  if(result.body){const stream=Readable.fromWeb(result.body);outgoing.on('close',()=>stream.destroy());stream.pipe(outgoing)}
  else outgoing.end()
 }catch(error){console.error('HTTP adapter:',error.name,String(error.code??'').slice(0,50));if(!outgoing.headersSent)outgoing.writeHead(500);outgoing.end()}
})
server.listen(3100,'127.0.0.1',()=>console.log('Product API serving generated route manifest'))
