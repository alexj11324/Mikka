import { disposableDatabase } from '../../../tests/helpers/e2e-target.mjs'
/** Test-only URL, never application/production fallback. Existing retained local
 * resources are not reclaimed; hosted CI uses its freshly provisioned service. */
export function projectionTestTarget(env:NodeJS.ProcessEnv):URL {
  const value=env.SKILL_COMPARISON_TEST_URL??(env.REQUIRE_DB==='1'&&disposableDatabase(env)?env.E2E_DATABASE_URL:undefined)
  if(!value)throw Error('Explicit dedicated projection target required; refusing to skip')
  const target=new URL(value)
  if(!['postgres:','postgresql:'].includes(target.protocol)||!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||target.search||target.hash)throw Error('Dedicated loopback projection target required')
  if(target.port==='55439'&&target.pathname==='/mikka_improvement'&&target.username==='improvement'&&target.password==='')return target
  // mikka_improvement is not *_e2e: only the hosted job's fresh service proves it disposable.
  if(env.CI==='true'&&env.GITHUB_ACTIONS==='true'&&target.hostname==='127.0.0.1'&&target.port==='5432'&&value===env.IMPROVEMENT_TEST_URL&&target.pathname==='/mikka_improvement'&&target.username==='improvement')return target
  if(env.REQUIRE_DB==='1'&&disposableDatabase(env)&&value===env.E2E_DATABASE_URL&&value===env.DATABASE_URL&&value===env.MIKKA_DATABASE_URL)return target
  throw Error('Dedicated retained local or current ephemeral Actions projection target required')
}
