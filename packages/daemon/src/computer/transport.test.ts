import { expect, it } from 'vitest'
import { computerDomain } from './transport'
const spec = { command: 'node', args: ['proxy.mjs', 'tcp://127.0.0.1:32123', 'request-only'], env: {} }
it('names only the trusted loopback broker port', () => {
 expect(computerDomain(spec)).toBe('127.0.0.1:32123')
})
it('rejects external, credential-bearing and path-bearing broker endpoints',()=>{
 for(const url of ['tcp://example.com:123','tcp://user@127.0.0.1:123','tcp://127.0.0.1:123/path','tcp://127.0.0.1:123?x=1']) expect(()=>computerDomain({...spec,args:['proxy',url]})).toThrow()
 expect(computerDomain({...spec,args:['proxy','/trusted/unix.sock']})).toBeUndefined()
})
