import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { PERMISSION_DECISIONS, PERMISSION_DEFAULTS, type PermissionDecision } from '@mikka/protocol/agent-policy'
import { cliPolicyValuesSchema } from '@/lib/agent-tool-approval/policy-store'
import { writePolicySettingsSchema } from '@/lib/operations/write-policy-settings'
import { writeTransaction } from '@/lib/operations/write-transaction'
import { coordinatorBot, type CoordinatorBot } from '@/lib/coordinator/coordinator-bot'

/**
 * GitHub's two writes on Plugins › GitHub, for the person's own Coordinator
 * (agent_kit_heads of its bot row, lib/coordinator/coordinator-bot.ts). Neither has a second store:
 *
 * - 推送分支 is the Coordinator's `git_push` in `cli_run_policy`, the same
 *   setting the daemon applies (ask → approval card), the run admission reads
 *   and the run-token issuer refuses on deny.
 * - 创建 Pull Request is `github_pull_request` in `external_write_permissions`,
 *   read by publishRunResult before it opens the pull request. Unset keeps
 *   today's behaviour: once the push was approved, the pull request opens.
 */
export const PULL_REQUEST_PERMISSION = 'github_pull_request'
export const PULL_REQUEST_DEFAULT: PermissionDecision = 'allow'

const decision = z.enum(PERMISSION_DECISIONS)
/** One version over both columns, so a stale page cannot overwrite either. */
const versionSchema = z.string().regex(/^(0|[1-9]\d*):(0|[1-9]\d*)$/)
export const githubPermissionsPatchSchema = z.strictObject({
  version: versionSchema,
  // No push-time card exists, so for 推送分支 询问 would act as 允许: only allow / deny are offered.
  push: z.enum(['allow', 'deny']).optional(),
  pullRequest: decision.optional(),
}).refine(value => value.push !== undefined || value.pullRequest !== undefined)

export interface GitHubPermissions { push: PermissionDecision; pullRequest: PermissionDecision; version: string }

export class GitHubPermissionsError extends Error {
  constructor(readonly code: 'githubPermissionsChanged' | 'githubPermissionsUnavailable') { super(code); this.name = 'GitHubPermissionsError' }
}

type Head = { cli: unknown; cliVersion: string; external: unknown; externalVersion: string }

function view(row: Head | undefined): GitHubPermissions & { cli: z.infer<typeof cliPolicyValuesSchema>; external: z.infer<typeof writePolicySettingsSchema> } {
  // A row an older build left malformed is unavailable, never a default that widens it.
  const cli = cliPolicyValuesSchema.safeParse(row?.cli ?? {})
  const external = writePolicySettingsSchema.safeParse(row?.external ?? {})
  const version = `${row?.cliVersion ?? '0'}:${row?.externalVersion ?? '0'}`
  if (!cli.success || !external.success || !versionSchema.safeParse(version).success) throw new GitHubPermissionsError('githubPermissionsUnavailable')
  return {
    cli: cli.data, external: external.data, version,
    push: cli.data.permissions?.git_push ?? PERMISSION_DEFAULTS.git_push,
    pullRequest: external.data[PULL_REQUEST_PERMISSION] ?? PULL_REQUEST_DEFAULT,
  }
}

async function lockHead(tx: PoolClient, userId: string, coordinator: CoordinatorBot, create: boolean): Promise<Head | undefined> {
  // The same lock lockCliAgentPolicy takes before it reads this row.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`agent-cli-policy:${userId}:${coordinator.botId}`])
  if (create) await tx.query(`INSERT INTO agent_kit_heads (owner_id,bot_key,bot_id,workspace_id) VALUES ($1,$2,$3,$4) ON CONFLICT (owner_id,bot_key) DO NOTHING`, [userId, coordinator.botId, coordinator.botId, coordinator.workspaceId])
  const { rows: [row] } = await tx.query<Head>(`SELECT cli_run_policy AS cli, cli_run_policy_version::text AS "cliVersion", external_write_permissions AS external, external_write_policy_version::text AS "externalVersion"
    FROM agent_kit_heads WHERE owner_id=$1 AND bot_key=$2 AND bot_id=$3 AND workspace_id=$4 FOR UPDATE`, [userId, coordinator.botId, coordinator.botId, coordinator.workspaceId])
  return row
}

/** `userId` is the authenticated session's; nothing here is read from the request. */
export async function readGitHubPermissions(pool: Pick<Pool, 'connect'>, userId: string): Promise<GitHubPermissions> {
  const coordinator = await coordinatorBot(userId)
  return writeTransaction(pool, async tx => {
    const { push, pullRequest, version } = view(await lockHead(tx, userId, coordinator, false))
    return { push, pullRequest, version }
  })
}

export async function setGitHubPermissions(pool: Pick<Pool, 'connect'>, userId: string, raw: unknown): Promise<GitHubPermissions> {
  const input = githubPermissionsPatchSchema.parse(raw)
  const coordinator = await coordinatorBot(userId)
  return writeTransaction(pool, async tx => {
    const current = view(await lockHead(tx, userId, coordinator, true))
    if (current.version !== input.version) throw new GitHubPermissionsError('githubPermissionsChanged')
    const cli = input.push === undefined ? current.cli : cliPolicyValuesSchema.parse({ ...current.cli, permissions: { ...current.cli.permissions, git_push: input.push } })
    const external = input.pullRequest === undefined ? current.external : writePolicySettingsSchema.parse({ ...current.external, [PULL_REQUEST_PERMISSION]: input.pullRequest })
    // Both columns version themselves (triggers), only when they change.
    const { rows: [row] } = await tx.query<Head>(`UPDATE agent_kit_heads SET cli_run_policy=$2, external_write_permissions=$3 WHERE owner_id=$1 AND bot_key=$4
      RETURNING cli_run_policy AS cli, cli_run_policy_version::text AS "cliVersion", external_write_permissions AS external, external_write_policy_version::text AS "externalVersion"`, [userId, cli, external, coordinator.botId])
    const { push, pullRequest, version } = view(row)
    return { push, pullRequest, version }
  })
}
