import 'server-only'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Sandbox } from 'e2b'

export const OFFICIAL_E2B_TEMPLATES = ['desktop', 'claude', 'codex'] as const
export type OfficialE2BTemplate = typeof OFFICIAL_E2B_TEMPLATES[number]
export function isOfficialE2BTemplate(template: string): template is OfficialE2BTemplate {
  return (OFFICIAL_E2B_TEMPLATES as readonly string[]).includes(template)
}

/** New instances only: all additions live under /opt/mikka (plus the private
 * runtime authority directory). Never edit an E2B template or its packages. */
export async function bootstrapOfficialInstance(sandbox: Pick<Sandbox, 'commands'>, template: OfficialE2BTemplate,
  env: Record<string, string | undefined> = process.env,
  script = () => readFile(join(process.cwd(), 'packages/daemon/scripts/official-e2b-instance-bootstrap.sh'), 'utf8')) {
  const commit = env.MIKKA_CLOUD_WORKER_SOURCE_COMMIT, sha = env.MIKKA_CLOUD_WORKER_SHA
  if (!isOfficialE2BTemplate(template) || !commit || !/^[a-f0-9]{40}$/.test(commit) || !sha || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Official worker release is not configured')
  const source = await script()
  const result = await sandbox.commands.run(`bash -s -- ${commit} ${sha} ${template} <<'MIKKA_OFFICIAL_INSTANCE_BOOTSTRAP'\n${source}\nMIKKA_OFFICIAL_INSTANCE_BOOTSTRAP`, { user: 'root', timeoutMs: 300_000 })
  if (!result.stdout.includes(`mikka-official-instance-ready ${commit} ${sha}`)) {
    // Idempotent creation can return an already-installed instance. Verify its
    // receipt rather than treating command exit alone as successful startup.
    const receipt = await sandbox.commands.run('cat /opt/mikka/worker-source-sha', { user: 'root', timeoutMs: 5_000 })
    if (receipt.stdout.trim() !== sha) throw new Error('Official worker receipt mismatch')
  }
}
