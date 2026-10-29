import { expect, it } from 'vitest'
import { computerDomain, computerSandboxPolicy, sandboxComputerSpec } from './transport'
const spec = { command: 'node', args: ['proxy.mjs', 'tcp://127.0.0.1:32123', 'request-only'], env: {} }
it('adds only the trusted broker port and selects the existing sandbox proxy', () => {
 const policy={allowWrite:[],allowDomains:['example.com']}
 expect(computerSandboxPolicy(policy,spec).allowDomains).toEqual(['example.com','127.0.0.1:32123'])
 expect(policy.allowDomains).toEqual(['example.com'])
 expect(sandboxComputerSpec(spec,'sandbox-runtime')?.env.MIKKA_COMPUTER_SANDBOX_PROXY).toBe('1')
 expect(sandboxComputerSpec(spec,'none')).toBe(spec)
})
it('rejects external, credential-bearing and path-bearing broker endpoints',()=>{
 for(const url of ['tcp://example.com:123','tcp://user@127.0.0.1:123','tcp://127.0.0.1:123/path','tcp://127.0.0.1:123?x=1']) expect(()=>computerDomain({...spec,args:['proxy',url]})).toThrow()
 expect(computerDomain({...spec,args:['proxy','/trusted/unix.sock']})).toBeUndefined()
})
