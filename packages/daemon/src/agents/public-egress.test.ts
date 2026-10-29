import { describe, expect, it, vi } from 'vitest'
import { request } from 'node:http'
import { egressDestination, resolvePublicDestination, startPublicEgress } from './public-egress'

describe('public-only hosted egress', () => {
  it('rejects non-public literals, unusual IPv4 forms and transition addresses', async () => {
    for (const host of ['127.0.0.1','10.1.2.3','169.254.169.254','100.100.100.200','192.168.1.1','0.0.0.0','::1','[::ffff:127.0.0.1]','fc00::1','fe80::1','2002:7f00:1::','2001:db8::1','localhost','metadata.internal','host.local']) {
      await expect(resolvePublicDestination(host)).rejects.toThrow('egressDestinationDenied')
    }
    expect(egressDestination('http://2130706433/',false).host).toBe('127.0.0.1')
    expect(egressDestination('http://0x7f000001/',false).host).toBe('127.0.0.1')
  })
  it('pins the validated public DNS answer and refuses mixed DNS answers', async () => {
    const resolver=vi.fn(async()=>[{address:'93.184.216.34',family:4}])
    expect(await resolvePublicDestination('example.com',resolver)).toEqual({address:'93.184.216.34',family:4})
    expect(resolver).toHaveBeenCalledOnce()
    await expect(resolvePublicDestination('example.com',async()=>[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}])).rejects.toThrow()
    await expect(resolvePublicDestination('example.com',async()=>[])).rejects.toThrow()
  })
  it('does not accept credentials, non-HTTP URLs or CONNECT paths', () => {
    for(const value of ['http://user:pass@example.com/','file:///etc/passwd','https://example.com/','http://example.com/#secret','http://example.com/\r\nHost: x']) expect(()=>egressDestination(value,false)).toThrow()
    for(const value of ['example.com','example.com:0','example.com:65536','example.com:443/path','user@example.com:443']) expect(()=>egressDestination(value,true)).toThrow()
    expect(egressDestination('example.com:443',true)).toMatchObject({host:'example.com',port:443})
  })
  it('runs a real Unix HTTP proxy, rejects private targets and closes on revoke', async () => {
    const stop=new AbortController(),authorize=vi.fn(async()=>true)
    const proxy=await startPublicEgress({authorize,signal:stop.signal})
    const status=await new Promise<number|undefined>((resolve,reject)=>{
      const call=request({socketPath:proxy.socketPath,path:'http://127.0.0.1:43199/',headers:{host:'127.0.0.1:43199'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode))})
      call.on('error',reject);call.end()
    })
    expect(status).toBe(403)
    expect(authorize).toHaveBeenCalledOnce()
    stop.abort();await proxy.close();await proxy.close()
  })
})
