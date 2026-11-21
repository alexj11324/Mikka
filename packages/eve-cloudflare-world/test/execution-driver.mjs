import { decode, encode } from 'cbor-x'
export { EveWorldAuthority } from '../src/authority.mjs'

export default {
  async fetch(request, env) {
    const [method, ...args] = decode(new Uint8Array(await request.arrayBuffer()))
    const authority = env.WORLD.getByName('execution-test-world')
    const result = await authority[method](...args)
    return new Response(encode(result))
  },
}
