import type { Pool } from 'pg'
import { CredentialError } from './contracts'
import { awsKms, open, type Kms } from './kms'
import { CredentialStore, hashNonce, rowEnvelope, type BrowserTarget } from './store'
import { Cdp, gatewayGuard, type BrowserGuard } from './browser'
import { assertCredentialPageBinding } from './page-binding'

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
  const target = claimed.target as BrowserTarget & { credentialMode?: 'password' | 'session-first' }
  const client = await pool.connect()
  let cdp: Cdp | undefined, guardToken: string | undefined, completed = false
  let plaintext: Buffer | undefined
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`credentials:${caller.userId}:${context.origin}`])
    await new CredentialStore(pool, kms).authorize(caller, client)
    // Policy changes take the same lock in the computer host. The signed
    // gateway capability must additionally be issued by the trusted host
    // after its existing computer_use decision; this query is not approval.
    if (!caller.subagentId || caller.runId || !target.observedInput) throw new CredentialError('credential_denied', 404)
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${caller.workspaceId}`])
    const bound = (await client.query(`SELECT s."targetId",s.epoch,COALESCE(p.version,0) AS "permissionVersion",p.permission
      FROM bot_subagents s LEFT JOIN workspace_computer_policies p ON p."workspaceId"=s."workspaceId"
      WHERE s.id=$1 AND s."ownerId"=$2 AND s."workspaceId"=$3 AND s."botId"=$4 AND s.status IN ('running','needs_you')`,
    [caller.subagentId, caller.userId, caller.workspaceId, caller.botId])).rows[0]
    if (!bound || bound.permission === 'deny') throw new CredentialError('credential_denied', 404)
    const observed = target.observedInput
    if (!Number.isSafeInteger(observed.backendNodeId) || observed.backendNodeId < 1 || !['username','password'].includes(observed.credentialRole)) throw new CredentialError('credential_denied', 404)
    const common = { userId: caller.userId, workspaceId: caller.workspaceId, botId: caller.botId, subagentId: caller.subagentId, origin: context.origin, loaderId: observed.loaderId, permissionAction: 'computer_use' as const }
    assertCredentialPageBinding({ ...common, targetId: target.targetId, epoch: observed.epoch, permissionVersion: observed.permissionVersion, expiresAt: target.expiresAt }, { ...common, targetId: bound.targetId, epoch: bound.epoch, permissionVersion: bound.permissionVersion })
    if (target.origin !== context.origin) throw new CredentialError('credential_denied', 404)
    const credential = (await client.query(`SELECT s.*,c.username FROM credentials c JOIN credential_secrets s ON s.credential_id=c.id WHERE c.id=$1 AND c.user_id=$2 AND c.origin=$3 AND c.revoked_at IS NULL AND c.unattended_allowed=true FOR UPDATE OF c`, [context.credentialId, context.userId, context.origin])).rows[0]
    if (!credential || target.expiresAt <= Date.now()) throw new CredentialError('credential_denied', 404)
    const guarded = await guard.begin(target)
    guardToken = guarded.guardToken
    cdp = await (options.connect ?? Cdp.connect)(guarded.cdpUrl)
    await cdp.attach(guarded.targetId)
    await cdp.origin(context.origin)
    const frame = (await cdp.call('Page.getFrameTree')).frameTree?.frame
    if (!frame || frame.loaderId !== observed.loaderId) throw new CredentialError('credential_denied', 404)
    const initialUrl = frame.url as string
    // Only this broker process ever receives cookie/password plaintext.
    const session = (await client.query('SELECT * FROM browser_sessions WHERE credential_id=$1 AND expires_at>now()', [context.credentialId])).rows[0]
    let sessionApplied = false
    if (session && claimed.input_kind !== 'otp' && target.credentialMode !== 'password') {
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
        // Applying state is mechanical; only the caller's visual model may
        // decide whether the site accepted it or needs another login step.
        await cdp.call('Page.reload')
        sessionApplied = true
      } finally { plaintext?.fill(0); plaintext = undefined }
    }
    if (claimed.input_kind === 'otp') throw new CredentialError('credential_denied', 404)
    if (!sessionApplied) {
      plaintext = await open(kms, context, rowEnvelope(credential))
      let value = JSON.parse(plaintext.toString('utf8'))
      plaintext.fill(0); plaintext = undefined
      if (typeof value.username !== 'string' || typeof value.password !== 'string') throw new CredentialError()
      await cdp.insertAtObservedInput(context.origin, observed.loaderId, observed.backendNodeId, observed.credentialRole, observed.credentialRole === 'password' ? value.password : value.username)
      value = null
      await client.query(`INSERT INTO credential_access_events(credential_id,user_id,bot_id,run_id,subagent_id,origin_seen,decision) VALUES($1,$2,$3,$4,$5,$6,$7)`, [context.credentialId, context.userId, caller.botId, caller.runId, caller.subagentId, context.origin, 'input_inserted_guarded'])
      await client.query('COMMIT'); completed = true
      // The guard must stay closed while an inserted value may be visible.
      // A subsequent trusted host action is needed to submit or clear it.
      return { status: 'guarded' as const, origin: context.origin }
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
    await client.query('UPDATE credentials SET last_used_at=now() WHERE id=$1', [context.credentialId])
    await client.query(`INSERT INTO credential_access_events(credential_id,user_id,bot_id,run_id,subagent_id,origin_seen,decision) VALUES($1,$2,$3,$4,$5,$6,$7)`, [context.credentialId, context.userId, caller.botId, caller.runId, caller.subagentId, context.origin, sessionApplied ? 'session_applied' : claimed.input_kind === 'otp' ? 'otp_submitted' : 'password_submitted'])
    await client.query('COMMIT'); completed = true
    await guard.end(target, guardToken)
    if (caller.subagentId) {
      // Resume the caller to observe the page after the guard ends. The
      // broker does not decide whether login succeeded or MFA is required.
      await pool.query(`WITH changed AS (
        UPDATE bot_subagents SET status=$5,needs=$6,step=$7
        WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "botId"=$4 AND status IN ('running','needs_you') RETURNING *
      ) INSERT INTO subagent_events("ownerId","workspaceId","botId","subagentId",event)
      SELECT "ownerId","workspaceId","botId",id,jsonb_build_object('type','data-subagent','data',jsonb_build_object('botId',"botId",'subagentId',id,'task',task,'state',status,'step',step,'needs',needs)) FROM changed`,
      [caller.subagentId, caller.userId, caller.workspaceId, caller.botId, 'running', null, 'running'])
    }
    return { status: sessionApplied ? 'session_applied' as const : 'submitted' as const, origin: context.origin }
  } catch (error) {
    if (!completed) await client.query('ROLLBACK')
    await pool.query(`INSERT INTO credential_access_events(user_id,bot_id,run_id,subagent_id,origin_seen,decision) VALUES($1,$2,$3,$4,$5,'denied_or_failed')`, [context.userId, caller.botId, caller.runId, caller.subagentId, context.origin])
    if (error instanceof CredentialError) throw error
    throw new CredentialError()
  } finally { plaintext?.fill(0); cdp?.close(); client.release() }
}
