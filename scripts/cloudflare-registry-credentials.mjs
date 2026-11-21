import assert from 'node:assert/strict'
import {appendFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const account = 'd8f6630c7869111a5139bc5ed4d24ace'
export async function registryCredentials(mode, env = process.env) {
  assert.ok(['read','publish'].includes(mode))
  assert.ok(env.CLOUDFLARE_API_TOKEN)
  const response = await fetch('https://api.cloudflare.com/client/v4/accounts/' + account + '/containers/registries/registry.cloudflare.com/credentials', {
    method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
    headers:{authorization:'Bearer ' + env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'},
    body:JSON.stringify({expiration_minutes:15,permissions:mode === 'read' ? ['pull'] : ['push','pull']}),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(response.status === 401 || response.status === 403
      ? 'CF_REGISTRY_AUTHORITY_REQUIRED' : 'CF_REGISTRY_CREDENTIAL_REQUEST_FAILED')
  }
  const {success,result} = await response.json()
  assert.equal(success, true)
  assert.equal(result?.account_id, account)
  assert.equal(result.registry_host, 'registry.cloudflare.com')
  // oxlint-disable-next-line no-control-regex -- GitHub output values must be single-line without NUL.
  for (const key of ['username','password']) assert.ok(typeof result[key] === 'string' && result[key].length > 0 && !/[\r\n\x00]/.test(result[key]))
  return {username:result.username,password:result.password}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode,...extra] = process.argv.slice(2)
    assert.equal(extra.length, 0)
    assert.ok(process.env.GITHUB_OUTPUT)
    const credential = await registryCredentials(mode)
    console.log('::add-mask::' + credential.password.replaceAll('%','%25'))
    await appendFile(process.env.GITHUB_OUTPUT, 'username=' + credential.username + '\npassword=' + credential.password + '\n')
    console.log('Cloudflare Registry workload credential issued')
  } catch (error) {
    console.error(['CF_REGISTRY_AUTHORITY_REQUIRED','CF_REGISTRY_CREDENTIAL_REQUEST_FAILED'].includes(error?.message)
      ? error.message : 'CF_REGISTRY_CREDENTIAL_FAILED')
    process.exitCode = 1
  }
}
