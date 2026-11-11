import { defineEval } from 'eve/evals'
import { equals } from 'eve/evals/expect'

/** Run against an authorized isolated target with EVE_EVAL_AUTH_TOKEN. */
export default defineEval({
  async test(t) {
    const foreign = await t.target.fetch('/eve/v1/session/wrun_not_owned/stream')
    t.check(foreign.status,equals(404))
    const created = await t.target.fetch('/eve/v1/session',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})
    t.check(created.status,equals(200))
    const id = (await created.json()).sessionId
    const resumed = await t.target.fetch('/eve/v1/session',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})
    t.check((await resumed.json()).sessionId,equals(id))
  },
})
