import {createServer} from 'node:https'
import {createServer as createHttp} from 'node:http'
import {randomUUID,timingSafeEqual,createHash} from 'node:crypto'
import {appendFileSync,readFileSync} from 'node:fs'
import {getLlama,LlamaChatSession} from 'node-llama-cpp'
const work=process.env.E_CODEX_QA, modelId='SmolLM2-135M-Instruct-Q4_K_M'
const key=Buffer.from(process.env.E_LOOPBACK_KEY)
const log=(name,value)=>appendFileSync(work+'/'+name,JSON.stringify({at:new Date().toISOString(),...value})+'\n',{mode:0o600})
const llama=await getLlama({gpu:false,build:'never',skipDownload:true})
const model=await llama.loadModel({modelPath:process.env.E_WEIGHT_FILE})
const tls={key:readFileSync(work+'/endpoint.key'),cert:readFileSync(work+'/endpoint.pem'),minVersion:'TLSv1.2'}
createHttp(async(req,res)=>{
 const route=new URL(req.url,'https://127.0.0.1').pathname
 const reject=(code,reason)=>{log('claude-routes.jsonl',{route,method:req.method,code,reason});res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:reason}}))}
 if(req.socket.remoteAddress!=='127.0.0.1')return reject(403,'Loopback only')
 if(route==='/health'&&req.method==='GET')return res.end('ready')
 const supplied=Buffer.from(String(req.headers['x-api-key']??''))
 if(supplied.length!==key.length||!timingSafeEqual(supplied,key))return reject(401,'Ephemeral credential required')
 if(req.method==='GET'&&route==='/v1/models'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:modelId,type:'model',display_name:modelId}],has_more:false}));return}
 if(req.method!=='POST'||(route!=='/v1/messages'&&route!=='/v1/messages/count_tokens'))return reject(404,'Unsupported route')
 let raw='';for await(const buf of req){raw+=buf;if(raw.length>2e6)return reject(413,'Body too large')}
 let body;try{body=JSON.parse(raw)}catch{return reject(400,'Expected JSON')}
 const texts=(body.messages??[]).filter(m=>m.role==='user').flatMap(m=>typeof m.content==='string'?[m.content]:(m.content??[]).filter(b=>b.type==='text').map(b=>b.text))
 const marked=texts.flatMap(t=>[...t.matchAll(/E2262_QA_BEGIN ([^\n]{1,340}?) E2262_QA_END/g)].map(m=>m[1]))
 const prompt=marked.at(-1)
 log('claude-requests.jsonl',{route,model:body.model,anthropicVersion:req.headers['anthropic-version'],wireSha256:createHash('sha256').update(raw).digest('hex'),marker:Boolean(prompt),stream:body.stream??false,transport:"nonproduction loopback only"})
 if(route.endsWith('/count_tokens')){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({input_tokens:model.tokenize(texts.join('\n')).length}))}
 if(!prompt||body.model!==modelId)return reject(400,'Only the configured evaluation model and marked synthetic prompt are accepted')
 const id='msg_'+randomUUID().replaceAll('-',''),input_tokens=model.tokenize(prompt).length
 const base={id,type:'message',role:'assistant',model:modelId,stop_sequence:null}
 const event=(type,parts)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...parts})+'\n\n')
 const toolNames=(body.tools??[]).map(t=>t.name??'').filter(Boolean)
 const allBlocks=(body.messages??[]).flatMap(m=>Array.isArray(m.content)?m.content:[])
 const refs=allBlocks.filter(b=>b.type==='tool_result').flatMap(b=>Array.isArray(b.content)?b.content:[]).filter(b=>b.type==='tool_reference').map(b=>b.tool_name)
 const submit='mcp__mikka__submit'
 const offered=[...new Set([...toolNames,...refs])].filter(n=>n===submit)
 const made=allBlocks.filter(x=>x.type==='tool_use').map(x=>x.name)
 const search=toolNames.find(n=>n==='ToolSearch'||n==='tool_search')
 log('claude-tools.jsonl',{model:body.model,tools:toolNames,referencedNames:refs,offeredSubmit:offered,priorTools:made,toolCount:toolNames.length})
 const reviewing=prompt.startsWith('Review the producer report against the requirement')
 const handin=reviewing||prompt.startsWith('The user wants the finished report delivered.')
 if(handin&&!made.includes(submit)&&(offered.length===1||(search&&!made.includes(search)))){
  const ctx=await model.createContext({contextSize:1024,threads:1})
  try {
   const needsSearch=offered.length===0
   const fields=needsSearch?{action:{enum:['answer','search']},query:{type:'string',maxLength:60}}:{action:{enum:['answer','submit']},summary:{type:'string',maxLength:140},...(reviewing?{assessment:{enum:['observed','unverified']},observation:{type:'string',maxLength:135}}:{})}
   const grammar=await llama.createGrammarForJsonSchema({type:'object',properties:fields,required:Object.keys(fields),additionalProperties:false})
   const instructions=needsSearch?'Pick the action for a requested final report. The submit tool is not currently exposed. To discover it, select search and put the tool name in the query. Do not report it as already submitted.':reviewing?'You must hand in your review using the submit tool. The caller requires a report even when the source does not meet its requirement. Set action to submit to deliver your report. First read the producer report, then write your independent summary, set assessment to observed or unverified according to the text, and quote the evidence. Do not use answer for a requested handoff.':'Select one action for the human request. Your JSON has action and summary. To submit a final report, action is submit. To send a chat answer, action is answer.'
   const session=new LlamaChatSession({contextSequence:ctx.getSequence(),systemPrompt:instructions})
   const question=needsSearch?'Find the tool named mcp__mikka__submit. Choose search with query select:mcp__mikka__submit.':prompt
   const generated=await session.prompt(question,{temperature:0,maxTokens:reviewing?180:90,grammar}),decision=JSON.parse(generated)
   const generatedTokens=model.tokenize(generated).length
   log('decisions.jsonl',{model:modelId,prompt,generated,generatedTokens,mode:needsSearch?'discovery':'handoff'})
   if((needsSearch&&decision.action==='search')||(!needsSearch&&decision.action==='submit')){
    const useId='toolu_'+randomUUID().replaceAll('-',''),use={type:'tool_use',id:useId,name:needsSearch?search:submit,input:needsSearch?{query:decision.query}:{summary:decision.summary,...(reviewing?{reviewVerdict:'needs_judgment',criteria:[decision.assessment==='observed'?{text:'The report identifies a clear daytime sky colour.',status:'passed',passed:true,evidence:decision.observation}:{text:'The report identifies a clear daytime sky colour.',status:'unverified',passed:false,reason:decision.observation}]}:{})}}
    if(body.stream===true){
     res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'})
     event('message_start',{message:{...base,content:[],stop_reason:null,usage:{input_tokens,output_tokens:0}}})
     event('content_block_start',{index:0,content_block:{...use,input:{}}})
     event('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(use.input)}})
     event('content_block_stop',{index:0});event('message_delta',{delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:generatedTokens}});event('message_stop',{});res.end()
    }else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({...base,content:[use],stop_reason:'tool_use',usage:{input_tokens,output_tokens:generatedTokens}}))}
    return
   }
  }finally{await ctx.dispose()}
 }
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
  const actual=await session.prompt(prompt,{temperature:0,maxTokens:64,signal:abort.signal,onTextChunk:delta=>{if(!text)log('claude-first-token.jsonl',{id,prompt});text+=delta;if(prompt.startsWith('List twenty vegetables'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,160);if(stream)event('content_block_delta',{index:0,delta:{type:'text_delta',text:delta}})}})
  if(!actual||actual!==text)throw Error('Stream and result mismatch')
  const output_tokens=model.tokenize(actual).length
  log('claude-results.jsonl',{id,model:modelId,prompt,output:actual,input_tokens,output_tokens})
  if(stream){event('content_block_stop',{index:0});event('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens}});event('message_stop',{});res.end()}
  else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({...base,content:[{type:'text',text:actual}],stop_reason:'end_turn',usage:{input_tokens,output_tokens}}))}
 }catch(e){log('claude-routes.jsonl',{route,phase:'inference',name:e.name,aborted:abort.signal.aborted});if(!res.headersSent)return reject(500,'Inference failed');res.end()}finally{await context?.dispose()}
}).listen(3858,'127.0.0.1')
