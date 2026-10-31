import 'server-only'
import { pool } from '@/lib/db'
import { AUTH_EMAIL_FROM } from '@/lib/auth-email'
import { abuseLimits, abuseAlertKinds } from './policy'
/** Existing Resend delivery and server error logs; durable keys deduplicate alerts. */
export async function checkAbuseAlerts(
  env = process.env,
  fetchImpl: typeof fetch = fetch,
) {
  const limits = abuseLimits(env)
  const {
    rows: [usage],
  } = await pool.query(
    `SELECT COALESCE(sum("unpaidMicroUsd"),0)::float8 AS spent FROM hosted_usage WHERE "createdAt">now()-interval '24 hours'`,
  )
  const {
    rows: [first],
  } = await pool.query(
    `SELECT count(*)::int AS n FROM (SELECT "workspaceId",min("createdAt") AS first FROM hosted_usage WHERE "reservedFree">0 OR "freeMicroUsd">0 GROUP BY "workspaceId") u WHERE first>now()-interval '1 hour'`,
  )
  const now = Date.now()
  const kinds = abuseAlertKinds(usage.spent, first.n, limits)
  for (const kind of kinds) {
    const key = `${kind}:${Math.floor(now / (kind === 'signup_spike' ? 3_600_000 : 86_400_000))}`
    await pool.query(
      'INSERT INTO hosted_abuse_alerts (key,kind) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [key, kind],
    )
  }
  const alerts = (
    await pool.query(
      'SELECT key,kind FROM hosted_abuse_alerts WHERE "deliveredAt" IS NULL ORDER BY "createdAt" LIMIT 10',
    )
  ).rows
  for (const alert of alerts) {
    console.error('hosted_abuse_alert', {
      kind: alert.kind,
      spentMicroUsd: usage.spent,
      firstUses: first.n,
    })
    if (!env.RESEND_API_KEY) continue // Retained for the next check; never treated as delivered.
    try {
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          'content-type': 'application/json',
          'idempotency-key': `hosted-abuse-${alert.key}`,
        },
        body: JSON.stringify({
          from: AUTH_EMAIL_FROM,
          to: [env.MIKKA_ABUSE_ALERT_EMAIL ?? 'mikka@aspectlylabs.com'],
          subject: `Mikka hosted usage: ${alert.kind}`,
          text: `Rolling 24h free usage: $${(usage.spent / 1e6).toFixed(4)}. Cap: $${limits.dailyMicroUsd / 1e6}. New free workspaces in the last hour: ${first.n}.`,
        }),
        signal: AbortSignal.timeout(10_000),
      })
      if (response.ok)
        await pool.query(
          'UPDATE hosted_abuse_alerts SET "deliveredAt"=now() WHERE key=$1',
          [alert.key],
        )
      else await response.body?.cancel()
    } catch {
      console.error('hosted_abuse_alert_delivery_failed')
    }
  }
}
