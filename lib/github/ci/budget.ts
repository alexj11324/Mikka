import type { Pool } from 'pg'

/** Shared conservative budget for CI GitHub reads across cold starts. Each
 * request reserves before I/O; reservations are never refunded on crashes. */
export class CiBudgetDeferred extends Error { constructor(){super('ci_budget_deferred')} }
const LIMIT=600
/** Avoid token-issuance ingress while the shared budget is known to be closed.
 * The eventual request still reserves atomically, so concurrent workers cannot
 * exceed the budget. */
export async function checkCiBudget(pool:Pick<Pool,'query'>):Promise<void> {
  const result=await pool.query(`SELECT 1 FROM github_ci_api_budget WHERE id=true AND (("blockedUntil" IS NOT NULL AND "blockedUntil">now()) OR ("windowStart">now()-interval '1 hour' AND used >= $1))`,[LIMIT])
  if(result.rowCount)throw new CiBudgetDeferred()
}
export function budgetedCiFetch(pool:Pick<Pool,'query'>,fetcher:typeof fetch=fetch):typeof fetch {
  return async (input,init) => {
    const result=await pool.query(`INSERT INTO github_ci_api_budget (id,"windowStart",used) VALUES (true,now(),1)
      ON CONFLICT (id) DO UPDATE SET "windowStart"=CASE WHEN github_ci_api_budget."windowStart"<=now()-interval '1 hour' THEN now() ELSE github_ci_api_budget."windowStart" END, used=CASE WHEN github_ci_api_budget."windowStart"<=now()-interval '1 hour' THEN 1 ELSE github_ci_api_budget.used+1 END
      WHERE (github_ci_api_budget."blockedUntil" IS NULL OR github_ci_api_budget."blockedUntil"<=now()) AND (github_ci_api_budget."windowStart"<=now()-interval '1 hour' OR github_ci_api_budget.used<$1) RETURNING used`,[LIMIT])
    if(!result.rowCount)throw new CiBudgetDeferred()
    const response=await fetcher(input,init)
    if(response.status===429 || (response.status===403 && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining')==='0'))) {
      const retry=response.headers.get('retry-after')
      const seconds=Number(retry), retryDate=retry ? Date.parse(retry) : NaN
      const reset=Number(response.headers.get('x-ratelimit-reset'))*1000
      const wait=retry && Number.isFinite(seconds)&&seconds>0 ? seconds*1000 : Number.isFinite(retryDate)&&retryDate>Date.now() ? retryDate-Date.now() : Number.isFinite(reset)&&reset>Date.now() ? reset-Date.now() : 60000
      await pool.query(`UPDATE github_ci_api_budget SET "blockedUntil"=greatest(coalesce("blockedUntil",now()),now()+($1*interval '1 millisecond')) WHERE id=true`,[Math.max(60000,Math.min(2147483647,wait))])
      await response.body?.cancel()
      throw new CiBudgetDeferred()
    }
    return response
  }
}
