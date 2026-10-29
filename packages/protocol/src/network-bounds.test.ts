import { expect,it } from 'vitest'
import { intersectNetworkDomains,networkDomainsWithin } from './network-bounds'
it('intersects exact hosts, wildcard subdomains and ports without widening either input',()=>{
 expect(intersectNetworkDomains(['*'],['api.example.com:443'])).toEqual(['api.example.com:443'])
 expect(intersectNetworkDomains(['*.example.com'],['api.example.com:443'])).toEqual(['api.example.com:443'])
 expect(intersectNetworkDomains(['example.com'],['*.example.com'])).toEqual([])
 expect(intersectNetworkDomains(['*.example.com:443'],['*.api.example.com'])).toEqual(['*.api.example.com:443'])
 expect(intersectNetworkDomains(['api.example.com:80'],['*.example.com:443'])).toEqual([])
 expect(networkDomainsWithin(['*.example.com'],['api.example.com'])).toBe(false)
 expect(networkDomainsWithin(['*'],['*.example.com'])).toBe(false)
 expect(networkDomainsWithin([],['example.com'])).toBe(true)
})
