import type { Pool } from 'pg'
import { CredentialError } from './contracts.js'
import { awsKms, open, sealSession, type Kms } from './kms.js'
import { CredentialStore, hashNonce, rowEnvelope, type BrowserTarget } from './store.js'
import { Cdp, gatewayGuard, type BrowserGuard } from './browser.js'

/** Imported only by services/credential-broker, which runs under the broker
 * project identity. No endpoint returns plaintext or arbitrary browser output. */
export async function fillCredential(pool: Pool, lease: string, options: { kms?: Kms; guard?: BrowserGuard; connect?: typeof Cdp.connect } = {}) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(lease)) throw new CredentialError('credential_denied', 404)
  const kms = options.kms ?? awsKms('broker'), guard = options.guard ?? gatewayGuard
  // Consume durably before external effects. A crash cannot replay insertion.
  const claimed = (await pool.query(`WITH candidate AS MATERIALIZED (
    SELECT * FROM credential_fill_leases WHERE nonce_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE
  ), consumed AS (
    UPDATE credential_fill_leases l SET consumed_at=now(),input_envelope=NULL FROM candidate c WHERE l.nonce_hash=c.nonce_hash RETURNING l.nonce_hash
  ) SELECT c.* FROM candidate c JOIN consumed USING(nonce_hash)`, [hashNonce(lease)])).rows[0]
  if (!claimed) throw new CredentialError('credential_denied', 404)
  const caller = { userId: claimed.user_id, workspaceId: claimed.workspace_id, botId: claimed.bot_id, subagentId: claimed.subagent_id, runId: claimed.run_id }
  const context = { userId: caller.userId, credentialId: claimed.credential_id, origin: claimed.origin }
  const target = claimed.target as BrowserTarget
  const client = await pool.connect()
  let cdp: Cdp | undefined, guardToken: string | undefined, completed = false
  let plaintext: Buffer | undefined
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`credentials:${caller.userId}:${context.origin}`])
    await new CredentialStore(pool, kms).authorize(caller, client)
    const credential = (await client.query(`SELECT s.*,c.username FROM credentials c JOIN credential_secrets s ON s.credential_id=c.id WHERE c.id=$1 AND c.user_id=$2 AND c.origin=$3 AND c.revoked_at IS NULL AND c.unattended_allowed=true FOR UPDATE OF c`, [context.credentialId, context.userId, context.origin])).rows[0]
    if (!credential || target.expiresAt <= Date.now()) throw new CredentialError('credential_denied', 404)
    const guarded = await guard.begin(target)
    guardToken = guarded.guardToken
    cdp = await (options.connect ?? Cdp.connect)(guarded.cdpUrl)
    await cdp.attach(guarded.targetId)
    await cdp.origin(context.origin)
    const initialUrl = (await cdp.call('Page.getFrameTree')).frameTree.frame.url as string
    // Only this broker process ever receives cookie/password plaintext.
    const session = (await client.query('SELECT * FROM browser_sessions WHERE credential_id=$1 AND expires_at>now()', [context.credentialId])).rows[0]
    let restored = false
    if (session && claimed.input_kind !== 'otp') {
      try {
        plaintext = await open(kms, context, rowEnvelope(session), 'session')
        const state = JSON.parse(plaintext.toString('utf8'))
        plaintext.fill(0); plaintext = undefined
        await cdp.origin(context.origin)
        await cdp.call('Network.setCookies', { cookies: state.cookies })
        if (Array.isArray(state.localStorage)) {
          const root = await cdp.call('Runtime.evaluate', { expression: 'globalThis', returnByValue: false })
          if (!root.result?.objectId) throw new CredentialError()
          await cdp.call('Runtime.callFunctionOn', { objectId: root.result.objectId,
            functionDeclaration: 'function(entries){localStorage.clear();for(const [k,v] of entries)localStorage.setItem(k,v)}',
            arguments: [{ value: state.localStorage }], returnByValue: true })
        }
        // HttpOnly cookies only. Login restoration is verified after reload;
        // if the login form remains, fall back to the saved password.
        await cdp.call('Page.reload')
        const deadline = Date.now() + 5000
        do {
          await new Promise(resolve => setTimeout(resolve, 250))
          await cdp.origin(context.origin)
          restored = await cdp.evaluate(`document.readyState==='complete'&&!document.querySelector('input[type="password"]')`) === true
        } while (!restored && Date.now() < deadline)
      } catch { restored = false } finally { plaintext?.fill(0); plaintext = undefined }
    }
    if (claimed.input_kind === 'otp') {
      plaintext = await open(kms, context, claimed.input_envelope, 'otp')
      await cdp.fillOtp(context.origin, plaintext.toString())
      plaintext.fill(0); plaintext = undefined
    } else if (!restored) {
      plaintext = await open(kms, context, rowEnvelope(credential))
      let value = JSON.parse(plaintext.toString('utf8'))
      plaintext.fill(0); plaintext = undefined
      if (typeof value.username !== 'string' || typeof value.password !== 'string') throw new CredentialError()
      await cdp.fill(context.origin, value.username, value.password)
      value = null
    }
    // Never resume viewing merely because insertion succeeded. On failure the
    // gateway stays locked, including across broker timeout or process death.
    const deadline = Date.now() + 8000
    let safe = false
    do {
      await new Promise(resolve => setTimeout(resolve, 250))
      safe = await cdp.safeToResume(initialUrl)
    } while (!safe && Date.now() < deadline)
    if (!safe) throw new CredentialError('credential_login_pending', 409)
    await cdp.origin(context.origin)
    const needsCode = await cdp.evaluate(`Boolean([...document.querySelectorAll('input[autocomplete="one-time-code"],input[name="code"],input[name="otp"]')].find(e=>!e.disabled&&e.getClientRects().length))`) === true
    if (!needsCode) {
      const cookies = (await cdp.call('Network.getCookies', { urls: [context.origin] })).cookies
      const localStorage = await cdp.evaluate('Object.entries(localStorage)')
      const sessionEnvelope = await sealSession(kms, context, credential.wrapped_dek, Buffer.from(JSON.stringify({ cookies, localStorage })))
      await client.query(`INSERT INTO browser_sessions(credential_id,wrapped_dek,nonce,ciphertext,expires_at) VALUES($1,$2,$3,$4,now()+interval '7 days') ON CONFLICT(credential_id) DO UPDATE SET wrapped_dek=$2,nonce=$3,ciphertext=$4,expires_at=excluded.expires_at`, [context.credentialId, sessionEnvelope.wrappedDek, sessionEnvelope.nonce, sessionEnvelope.ciphertext])
    }
    await client.query('UPDATE credentials SET last_used_at=now() WHERE id=$1', [context.credentialId])
    await client.query(`INSERT INTO credential_access_events(credential_id,user_id,bot_id,run_id,subagent_id,origin_seen,decision) VALUES($1,$2,$3,$4,$5,$6,$7)`, [context.credentialId, context.userId, caller.botId, caller.runId, caller.subagentId, context.origin, restored ? 'session_restored' : 'password_filled'])
    await client.query('COMMIT'); completed = true
    await guard.end(target, guardToken)
    if (caller.subagentId) {
      const needs = needsCode ? { kind: 'code', site: new URL(context.origin).hostname, account: credential.username } : null
      // State and its data-subagent event are one statement: viewers never miss
      // the credential continuation or a second-factor request.
      await pool.query(`WITH changed AS (
        UPDATE bot_subagents SET status=$5,needs=$6,step=$7
        WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "botId"=$4 AND status IN ('running','needs_you') RETURNING *
      ) INSERT INTO subagent_events("ownerId","workspaceId","botId","subagentId",event)
      SELECT "ownerId","workspaceId","botId",id,jsonb_build_object('type','data-subagent','data',jsonb_build_object('botId',"botId",'subagentId',id,'task',task,'state',status,'step',step,'needs',needs)) FROM changed`,
      [caller.subagentId, caller.userId, caller.workspaceId, caller.botId, needsCode ? 'needs_you' : 'running', needs ? JSON.stringify(needs) : null, needsCode ? 'needs_code' : 'running'])
    }
    return { status: needsCode ? 'needs_code' as const : 'submitted' as const, origin: context.origin }
  } catch (error) {
    if (!completed) await client.query('ROLLBACK')
    await pool.query(`INSERT INTO credential_access_events(user_id,bot_id,run_id,subagent_id,origin_seen,decision) VALUES($1,$2,$3,$4,$5,'denied_or_failed')`, [context.userId, caller.botId, caller.runId, caller.subagentId, context.origin])
    if (error instanceof CredentialError) throw error
    throw new CredentialError()
  } finally { plaintext?.fill(0); cdp?.close(); client.release() }
}
