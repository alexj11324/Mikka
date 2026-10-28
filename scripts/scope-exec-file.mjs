// Preserve execFile's callback/promisify contract across the supervised IPC hop.
import { EventEmitter } from 'node:events'
import { promisify } from 'node:util'

export function scopeExecFile(launch) {
  function execFile(file, args, options, callback) {
    if (typeof args === 'function') { callback=args;args=[];options={} }
    else if (!Array.isArray(args)) { callback=options;options=args??{};args=[] }
    if (typeof options === 'function') { callback=options;options={} }
    options??={}
    const encoding=options.encoding===undefined?'utf8':options.encoding
    if(encoding!==null&&encoding!=='buffer'&&!Buffer.isEncoding(encoding))throw Error('unsupported scope output encoding')
    const maxBuffer=options.maxBuffer??(1<<20)
    if(!Number.isSafeInteger(maxBuffer)||maxBuffer<0)throw Error('invalid scope maxBuffer')
    const child=new EventEmitter();child.killed=false;child.exitCode=null;child.signalCode=null
    child.on('error',()=>{})
    let backend,done=false,cancelled,timer
    const abortError=()=>Object.assign(Error('The operation was aborted'),{name:'AbortError',code:'ABORT_ERR',killed:true,signal:options.killSignal??'SIGTERM'})
    const cancel=error=>{
      if(done||cancelled)return false
      cancelled=error;child.killed=true;backend?.cancel?.(error.signal??options.killSignal??'SIGTERM');return true
    }
    child.kill=(signal=options.killSignal??'SIGTERM')=>cancel(Object.assign(Error('Scope subprocess killed'),{killed:true,signal,code:null}))
    const abort=()=>cancel(abortError())
    const finish=(failure,result={})=>{
      if(done)return
      done=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort)
      let stdout=Buffer.from(result.stdout??failure?.stdout??[]),stderr=Buffer.from(result.stderr??failure?.stderr??[])
      let error=cancelled??failure??result.error
      if(stdout.length>maxBuffer||stderr.length>maxBuffer){error??=Object.assign(RangeError('scope stdio maxBuffer exceeded'),{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',killed:true});stdout=stdout.subarray(0,maxBuffer);stderr=stderr.subarray(0,maxBuffer)}
      const output=bytes=>encoding===null||encoding==='buffer'?bytes:bytes.toString(encoding)
      stdout=output(stdout);stderr=output(stderr)
      if(error){error.stdout=stdout;error.stderr=stderr;child.killed=Boolean(error.killed);child.exitCode=typeof error.code==='number'?error.code:null;child.signalCode=error.signal??null;child.emit('error',error)}else child.exitCode=0
      callback?.(error??null,stdout,stderr)
      child.emit('exit',child.exitCode,child.signalCode);child.emit('close',child.exitCode,child.signalCode)
    }
    if(options.signal?.aborted){cancelled=abortError();queueMicrotask(()=>finish(cancelled));return child}
    options.signal?.addEventListener('abort',abort,{once:true})
    backend=launch(file,args,options)
    if(options.timeout>0)timer=setTimeout(()=>cancel(Object.assign(Error('Scope subprocess timed out'),{code:'ETIMEDOUT',killed:true,signal:options.killSignal??'SIGTERM'})),options.timeout)
    Promise.resolve(backend.promise).then(result=>finish(null,result),error=>finish(error))
    return child
  }
  // Native execFile has this custom promisifier. Generic util.promisify would
  // resolve stdout alone, which was the failed runner's adapter bug.
  Object.defineProperty(execFile,promisify.custom,{value:(...args)=>{
    let child
    const promise=new Promise((resolve,reject)=>{child=execFile(...args,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr}))})
    promise.child=child
    return promise
  }})
  return execFile
}
export function scopeWireOutput(result) {
  return {stdoutBase64:Buffer.from(result.stdout??[]).toString('base64'),stderrBase64:Buffer.from(result.stderr??[]).toString('base64')}
}
export function scopeOutputFromWire(result) {
  return {stdout:Buffer.from(result.stdoutBase64??'','base64'),stderr:Buffer.from(result.stderrBase64??'','base64')}
}
export function scopeRpcError(payload) {
  const error=Error(typeof payload==='string'?payload:payload.message)
  if(payload&&typeof payload==='object'){
    for(const key of ['code','signal','killed'])if(Object.hasOwn(payload,key))error[key]=payload[key]
    Object.assign(error,scopeOutputFromWire(payload))
  }
  return error
}
