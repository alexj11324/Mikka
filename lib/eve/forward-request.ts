/** Nitro/srvx requests expose Request's public API without Undici's private
 * Request state. Copy public fields when rewriting a native protocol request. */
export function forwardEveRequest(request:Request,url:string|URL,body?:string) {
  return new Request(url,{method:request.method,headers:request.headers,signal:request.signal,...body === undefined ? {} : {body}})
}
