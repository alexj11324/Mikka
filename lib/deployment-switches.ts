/**
 * Deployment-wide feature switches, decided in PostHog (Alex, 2026-11-02:
 * every feature switch goes through a PostHog feature flag).
 *
 * Each switch is one PostHog flag evaluated against one fixed distinct id, as
 * the Linear sync flag is (lib/linear-sync/flags.ts): never against a person or
 * a team. A switch reads, in order:
 *
 * 1. PostHog's explicit answer for its flag (true or false);
 * 2. while PostHog is unreachable, still loading, or the flag does not exist:
 *    the environment variable that used to decide it, so a deployment that set
 *    one keeps behaving as it did until the flag is created;
 * 3. otherwise the switch's default, the behaviour without either.
 *
 * A feature that ships on has a kill flag (`…-off`): true turns it off, so a
 * flag created inactive never turns a shipped feature off by accident. A
 * feature that ships off has a gate flag: true turns it on.
 *
 * Reads are synchronous so the existing call sites stay as they are. PostHog
 * is asked in the background, once a minute at most, all switches in one
 * request; the first read in a fresh process uses steps 2 and 3. Workflow
 * bodies must not read a switch (no network there, and a replay must see the
 * same value): read it in a step and pass the result in.
 */

type Env = Record<string, string | undefined>

interface Switch {
  /** The PostHog flag. */
  flag: string
  /** kill: true turns a shipped feature off. gate: true turns a feature on. */
  kind: 'kill' | 'gate'
  /** What the old environment variable said, or undefined when it is not set. */
  legacy: (env: Env) => boolean | undefined
  /** Without PostHog and without the variable. */
  fallback: boolean
}

const exact = (name: string, on = '1') => (env: Env) => env[name] === undefined ? undefined : env[name] === on
const notZero = (name: string) => (env: Env) => env[name] === undefined ? undefined : env[name] !== '0'
const truthy = (name: string) => (env: Env) => {
  const value = env[name]
  return value === undefined ? undefined : value === '1' || value.toLowerCase() === 'true'
}

export const DEPLOYMENT_SWITCHES = {
  /** Saved logins for Bot browsers (lib/credentials). */
  credentialVault: { flag: 'mikka-credential-vault-off', kind: 'kill', legacy: exact('CREDENTIAL_VAULT_ENABLED'), fallback: true },
  /** Versioned Agent definitions and executions (lib/agent-kit). */
  agentKit: { flag: 'mikka-agent-kit-off', kind: 'kill', legacy: notZero('MIKKA_AGENT_KIT'), fallback: true },
  /** Live model judgment in Agent Kit evaluations; spends model calls. */
  agentKitLiveEval: { flag: 'mikka-agent-kit-live-eval', kind: 'gate', legacy: exact('MIKKA_AGENT_KIT_LIVE_EVAL'), fallback: false },
  /** Bot cloud computers and their thread machines. */
  cloudComputerTasks: { flag: 'mikka-cloud-computer-tasks-off', kind: 'kill', legacy: notZero('MIKKA_CLOUD_COMPUTER_TASKS'), fallback: true },
  /** The Coordinator's create_issue and update_issue. */
  issueTools: { flag: 'mikka-issue-tools-off', kind: 'kill', legacy: (env: Env) => env.MIKKA_ISSUE_TOOLS_ENABLED === undefined ? undefined : env.MIKKA_ISSUE_TOOLS_ENABLED === '1', fallback: true },
  /** Factory intake and routing. */
  factoryRouting: { flag: 'mikka-factory-routing', kind: 'gate', legacy: exact('MIKKA_FACTORY_ROUTING_ENABLED'), fallback: false },
  /** Factory run lifecycle (questions, check recovery, dispatch). */
  factoryLifecycle: { flag: 'mikka-factory-lifecycle', kind: 'gate', legacy: exact('MIKKA_FACTORY_LIFECYCLE_ENABLED'), fallback: false },
  /** The personal mailbox tools. */
  personalMailbox: { flag: 'mikka-personal-mailbox-off', kind: 'kill', legacy: notZero('MIKKA_PERSONAL_MAILBOX_ENABLED'), fallback: true },
  /** Writes to the person's connected apps. */
  personalWrites: { flag: 'mikka-personal-writes-off', kind: 'kill', legacy: exact('MIKKA_PERSONAL_WRITES_ENABLED'), fallback: true },
  /** Model-judged Skill evaluations; spends model calls. */
  skillModelEvaluation: { flag: 'mikka-skill-model-evaluation', kind: 'gate', legacy: exact('MIKKA_SKILL_MODEL_EVALUATION'), fallback: false },
  /** Proactive profile building for the whole deployment; each person also needs mikka-proactive-profile. */
  proactiveProfile: { flag: 'mikka-proactive-profile-deployment', kind: 'gate', legacy: truthy('PROACTIVE_PROFILE_ENABLED'), fallback: false },
  /** Factory's Vercel deployment publication. */
  factoryVercelPublication: { flag: 'mikka-factory-vercel-publication', kind: 'gate', legacy: exact('FACTORY_VERCEL_PUBLICATION'), fallback: false },
  /** Factory publication to the production Vercel target. */
  factoryVercelProduction: { flag: 'mikka-factory-vercel-production', kind: 'gate', legacy: exact('FACTORY_VERCEL_PRODUCTION'), fallback: false },
} as const satisfies Record<string, Switch>

export type DeploymentSwitch = keyof typeof DEPLOYMENT_SWITCHES

/** The one identity every switch is evaluated for. */
export const DEPLOYMENT_DISTINCT_ID = 'mikka-deployment'
export const SWITCH_REFRESH_MS = 60_000
const SWITCH_TIMEOUT_MS = 2_000

type Answers = Partial<Record<string, boolean>>
const state: { answers: Answers; at: number; pending: Promise<void> | null } = { answers: {}, at: 0, pending: null }

/** PostHog's answer for one switch, as on/off for the feature, or undefined when it gave none. */
function answered(entry: Switch, answers: Answers): boolean | undefined {
  const value = answers[entry.flag]
  if (value === undefined) return undefined
  return entry.kind === 'kill' ? !value : value
}

/** Whether the switch's feature is on now. Never throws, never waits. */
export function deploymentSwitch(name: DeploymentSwitch, env: Env = process.env, now = Date.now()): boolean {
  const entry: Switch = DEPLOYMENT_SWITCHES[name]
  if (env === process.env) scheduleRefresh(now)
  return answered(entry, state.answers) ?? entry.legacy(env) ?? entry.fallback
}

function scheduleRefresh(now: number) {
  if (state.pending || now - state.at < SWITCH_REFRESH_MS) return
  const token = process.env.NEXT_PUBLIC_POSTHOG_KEY
  if (!token || typeof fetch !== 'function') return
  state.at = now
  state.pending = refreshDeploymentSwitches(token).catch(() => undefined).finally(() => { state.pending = null })
}

/**
 * Asks PostHog for every switch's flag in one request and keeps the explicit
 * answers. A failed or partial evaluation keeps the previous answers: an
 * outage never flips a switch. Exported for tests and for callers that want
 * the answers before their first read.
 */
export async function refreshDeploymentSwitches(token: string | undefined = process.env.NEXT_PUBLIC_POSTHOG_KEY, fetcher: typeof fetch = fetch, timeoutMs = SWITCH_TIMEOUT_MS): Promise<void> {
  if (!token) return
  const response = await fetcher('https://us.i.posthog.com/flags?v=2', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'posthog-node/mikka-deployment-switches' },
    body: JSON.stringify({ api_key: token, distinct_id: DEPLOYMENT_DISTINCT_ID, flag_keys_to_evaluate: Object.values(DEPLOYMENT_SWITCHES).map(entry => entry.flag) }),
    // Never follow a redirect with the project token.
    cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) return
  const result = await response.json() as { errorsWhileComputingFlags?: boolean; quotaLimited?: string[]; flags?: Record<string, { enabled?: unknown; variant?: unknown }> }
  if (result.errorsWhileComputingFlags !== false || result.quotaLimited?.includes('feature_flags') || !result.flags || typeof result.flags !== 'object' || Array.isArray(result.flags)) return
  const answers: Answers = {}
  for (const entry of Object.values(DEPLOYMENT_SWITCHES) as Switch[]) {
    const flag = result.flags[entry.flag]
    // A multivariate flag is not a switch: no answer.
    if (flag && typeof flag === 'object' && !Array.isArray(flag) && flag.variant == null && typeof flag.enabled === 'boolean') answers[entry.flag] = flag.enabled
  }
  state.answers = answers
}

/** Forgets PostHog's answers; for tests. */
export function resetDeploymentSwitches() {
  state.answers = {}
  state.at = 0
  state.pending = null
}
