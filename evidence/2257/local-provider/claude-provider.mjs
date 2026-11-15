import {createServer} from 'node:https'
import {randomUUID,timingSafeEqual,createHash} from 'node:crypto'
import {appendFileSync,readFileSync} from 'node:fs'
import {getLlama,LlamaChatSession} from 'node-llama-cpp'
const work=process.env.E_CODEX_QA, modelId='SmolLM2-135M-Instruct-Q4_K_M'
const key=Buffer.from(process.env.E_LOOPBACK_KEY)
const log=(name,value)=>appendFileSync(work+'/'+name,JSON.stringify({at:new Date().toISOString(),...value})+'\n',{mode:0o600})
const llama=await getLlama({gpu:false,build:'never',skipDownload:true})
const model=await llama.loadModel({modelPath:process.env.E_WEIGHT_FILE})
const tls={key:readFileSync(work+'/endpoint.key'),cert:readFileSync(work+'/endpoint.pem'),minVersion:'TLSv1.2'}
createServer(tls,async(req,res)=>{
 const route=new URL(req.url,'https://127.0.0.1').pathname
 const reject=(code,reason)=>{log('claude-routes.jsonl',{route,method:req.method,code,reason});res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:reason}}))}
 if(req.socket.remoteAddress!=='127.0.0.1')return reject(403,'Loopback only')
 if(route==='/health'&&req.method==='GET')return res.end('ready')
 const supplied=Buffer.from(String(req.headers['x-api-key']??''))
 if(supplied.length!==key.length||!timingSafeEqual(supplied,key))return reject(401,'Ephemeral credential required')
 if(req.method!=='POST'||(route!=='/v1/messages'&&route!=='/v1/messages/count_tokens'))return reject(404,'Unsupported route')
 let raw='';for await(const buf of req){raw+=buf;if(raw.length>2e6)return reject(413,'Body too large')}
 let body;try{body=JSON.parse(raw)}catch{return reject(400,'Expected JSON')}
 const texts=(body.messages??[]).filter(m=>m.role==='user').flatMap(m=>typeof m.content==='string'?[m.content]:(m.content??[]).filter(b=>b.type==='text').map(b=>b.text))
 const marked=texts.flatMap(t=>[...t.matchAll(/E2262_QA_BEGIN ([^\n]{1,340}?) E2262_QA_END/g)].map(m=>m[1]))
 const prompt=marked.at(-1)
 log('claude-requests.jsonl',{route,model:body.model,anthropicVersion:req.headers['anthropic-version'],wireSha256:createHash('sha256').update(raw).digest('hex'),marker:Boolean(prompt),stream:body.stream??false,tls:req.socket.getProtocol()})
 if(route.endsWith('/count_tokens')){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({input_tokens:model.tokenize(texts.join('\n')).length}))}
 if(!prompt||body.model!==modelId)return reject(400,'Only the configured evaluation model and marked synthetic prompt are accepted')
 const id='msg_'+randomUUID().replaceAll('-',''),input_tokens=model.tokenize(prompt).length
 const base={id,type:'message',role:'assistant',model:modelId,stop_sequence:null}
 const event=(type,parts)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...parts})+'\n\n')
 const stream=body.stream===true
 if(stream){
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'})
  event('message_start',{message:{...base,content:[],stop_reason:null,usage:{input_tokens,output_tokens:0}}})
  event('content_block_start',{index:0,content_block:{type:'text',text:''}})
 }
 const abort=new AbortController()
 res.on('close',()=>{if(!res.writableEnded)abort.abort()})
 let text='',context
 try{
  context=await model.createContext({contextSize:1024,threads:1})
  const sequence=context.getSequence()
  const session=new LlamaChatSession({contextSequence:sequence,systemPrompt:'Answer this harmless English test request in plain text. Do not call any tools.'})
  const actual=await session.prompt(prompt,{temperature:0,maxTokens:64,signal:abort.signal,onTextChunk:delta=>{if(!text)log('claude-first-token.jsonl',{id,prompt});text+=delta;if(stream)event('content_block_delta',{index:0,delta:{type:'text_delta',text:delta}})}})
  if(!actual||actual!==text)throw Error('Stream and result mismatch')
  const output_tokens=model.tokenize(actual).length
  log('claude-results.jsonl',{id,model:modelId,prompt,output:actual,input_tokens,output_tokens})
  if(stream){event('content_block_stop',{index:0});event('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens}});event('message_stop',{});res.end()}
  else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({...base,content:[{type:'text',text:actual}],stop_reason:'end_turn',usage:{input_tokens,output_tokens}}))}
 }catch(e){log('claude-routes.jsonl',{route,phase:'inference',name:e.name,aborted:abort.signal.aborted});if(!res.headersSent)return reject(500,'Inference failed');res.end()}finally{await context?.dispose()}
}).listen(3857,'127.0.0.1')
