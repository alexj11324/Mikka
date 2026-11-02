/**
 * Deployment-wide feature switches, decided in PostHog (Alex, 2026-11-02:
 * every feature switch goes through a PostHog feature flag).
 *
 * A deployment switch is one PostHog flag evaluated against one fixed distinct
 * id, as the Linear sync flag is (lib/linear-sync/flags.ts). A person switch
 * (PERSON_SWITCHES, personSwitch) is evaluated for the person's user id, so it
 * can be on for some people first. Either reads, in order:
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

export interface Switch {
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
  /** Subscription (BYOS) enrollment custody. */
  byosEnrollment: { flag: 'mikka-byos-enrollment', kind: 'gate', legacy: exact('MIKKA_BYOS_ENROLLMENT_ENABLED'), fallback: false },
  /** Factory's Vercel deployment publication. */
  factoryVercelPublication: { flag: 'mikka-factory-vercel-publication', kind: 'gate', legacy: exact('FACTORY_VERCEL_PUBLICATION'), fallback: false },
  /** Factory publication to the production Vercel target. */
  factoryVercelProduction: { flag: 'mikka-factory-vercel-production', kind: 'gate', legacy: exact('FACTORY_VERCEL_PRODUCTION'), fallback: false },
} as const satisfies Record<string, Switch>

export type DeploymentSwitch = keyof typeof DEPLOYMENT_SWITCHES

/**
 * Which deployment asks (production, preview or local), sent as the person
 * property `deployment` so one PostHog project can hold a flag on for
 * production only.
 */
export function deploymentName(env: Env = process.env): string {
  return env.VERCEL_ENV === 'production' || env.VERCEL_ENV === 'preview' ? env.VERCEL_ENV : env.VERCEL_ENV ? 'development' : 'local'
}

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
 * PostHog's explicit answers for `flags`, evaluated for one distinct id, or
 * null when it gave none: an error, a partial evaluation or the quota limit.
 * A flag it does not have, or a multivariate one, gets no answer.
 */
async function evaluate(token: string, distinctId: string, flags: readonly string[], fetcher: typeof fetch, timeoutMs: number, personProperties?: Record<string, string>): Promise<Answers | null> {
  const response = await fetcher('https://us.i.posthog.com/flags?v=2', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'posthog-node/mikka-deployment-switches' },
    body: JSON.stringify({ api_key: token, distinct_id: distinctId, flag_keys_to_evaluate: flags, ...(personProperties ? { person_properties: personProperties } : {}) }),
    // Never follow a redirect with the project token.
    cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) return null
  const result = await response.json() as { errorsWhileComputingFlags?: boolean; quotaLimited?: string[]; flags?: Record<string, { enabled?: unknown; variant?: unknown }> }
  if (result.errorsWhileComputingFlags !== false || result.quotaLimited?.includes('feature_flags') || !result.flags || typeof result.flags !== 'object' || Array.isArray(result.flags)) return null
  const answers: Answers = {}
  for (const flag of flags) {
    const value = result.flags[flag]
    if (value && typeof value === 'object' && !Array.isArray(value) && value.variant == null && typeof value.enabled === 'boolean') answers[flag] = value.enabled
  }
  return answers
}

/**
 * Asks PostHog for every deployment switch in one request and keeps the
 * explicit answers. A failed or partial evaluation keeps the previous answers:
 * an outage never flips a switch. Exported for tests and for callers that want
 * the answers before their first read.
 */
export async function refreshDeploymentSwitches(token: string | undefined = process.env.NEXT_PUBLIC_POSTHOG_KEY, fetcher: typeof fetch = fetch, timeoutMs = SWITCH_TIMEOUT_MS): Promise<void> {
  if (!token) return
  const answers = await evaluate(token, DEPLOYMENT_DISTINCT_ID, Object.values(DEPLOYMENT_SWITCHES).map(entry => entry.flag), fetcher, timeoutMs, { deployment: deploymentName() })
  if (answers) state.answers = answers
}

/**
 * Switches decided per person: the flag is evaluated for the person's Mikka
 * user id (the distinct id the browser uses), so it can be on for some people
 * and not others. The same order applies: PostHog's explicit answer, else the
 * old variable, else the default.
 */
export const PERSON_SWITCHES = {} as const satisfies Record<string, Switch>

export type PersonSwitch = keyof typeof PERSON_SWITCHES

const PERSON_CACHE_MAX = 5_000
const personAnswers = new Map<string, { value: boolean | undefined; at: number }>()

/** Whether the switch's feature is on for this person. Never throws; waits at most SWITCH_TIMEOUT_MS. */
export async function personSwitch(name: PersonSwitch, userId: string, options: SwitchLookup = {}): Promise<boolean> {
  return switchForPerson(PERSON_SWITCHES[name], userId, options)
}

export interface SwitchLookup { env?: Env; token?: string; fetcher?: typeof fetch; now?: number; timeoutMs?: number }

/** The lookup behind personSwitch, for any switch entry; exported for tests. */
export async function switchForPerson(entry: Switch, userId: string, { env = process.env, token = process.env.NEXT_PUBLIC_POSTHOG_KEY, fetcher = fetch, now = Date.now(), timeoutMs = SWITCH_TIMEOUT_MS }: SwitchLookup = {}): Promise<boolean> {
  const key = `${entry.flag}|${userId}`
  let cached = personAnswers.get(key)
  if (!cached || now - cached.at >= SWITCH_REFRESH_MS) {
    let value: boolean | undefined = cached?.value
    if (token) {
      try {
        const answers = await evaluate(token, userId, [entry.flag], fetcher, timeoutMs)
        // An outage keeps what was known for this person.
        if (answers) value = answers[entry.flag]
      } catch { /* keeps the previous answer */ }
    }
    if (personAnswers.size >= PERSON_CACHE_MAX) personAnswers.clear()
    cached = { value, at: now }
    personAnswers.set(key, cached)
  }
  return answered(entry, cached.value === undefined ? {} : { [entry.flag]: cached.value }) ?? entry.legacy(env) ?? entry.fallback
}

/** Forgets PostHog's answers; for tests. */
export function resetDeploymentSwitches() {
  personAnswers.clear()
  state.answers = {}
  state.at = 0
  state.pending = null
}
