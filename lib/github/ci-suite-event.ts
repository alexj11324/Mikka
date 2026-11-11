import { z } from 'zod'

// This projection is only a wake hint after the caller has verified GitHub's
// raw-body signature. It is not a required-check rollup or an approval.
const id = z.number().int().positive().refine(Number.isSafeInteger)
const source = z.object({
  action: z.literal('completed'),
  installation: z.object({ id }),
  repository: z.object({
    id,
    full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  }),
  check_suite: z.object({
    id,
    status: z.literal('completed'),
    head_sha: z.string().regex(/^[a-f0-9]{40}$/i),
    conclusion: z.string().regex(/^[a-z_]{1,40}$/),
    pull_requests: z.array(z.object({ number: id })).max(100),
  }),
})

export type CompletedCiSuite = {
  installationId: number
  repositoryId: number
  repository: string
  suiteId: number
  headSha: string
  conclusion: string
  numbers: number[]
}

export function completedCiSuite(event: string, payload: unknown): CompletedCiSuite | null {
  if (event !== 'check_suite') return null
  const parsed = source.safeParse(payload)
  if (!parsed.success) return null
  const { installation, repository, check_suite: suite } = parsed.data
  return {
    installationId: installation.id,
    repositoryId: repository.id,
    repository: repository.full_name.toLowerCase(),
    suiteId: suite.id,
    headSha: suite.head_sha.toLowerCase(),
    conclusion: suite.conclusion,
    numbers: [...new Set(suite.pull_requests.map(pr => pr.number))],
  }
}

export type LinkedCiSuiteRun = {
  runId: string
  userId: string
  botId: string | null
  issueId: string | null
  pullUrl: string
  headSha: string | null
  state: string | null
}

/** A source-bound, existing publication; incoming webhook text cannot select its session. */
export function linkedCiSuiteRun(suite: CompletedCiSuite, row: LinkedCiSuiteRun): boolean {
  const prefix = `https://github.com/${suite.repository}/pull/`
  if (!row.botId || !row.runId || !row.userId || !['open', 'draft'].includes(row.state ?? '')
    || row.headSha?.toLowerCase() !== suite.headSha || !row.pullUrl.startsWith(prefix)) return false
  const number = row.pullUrl.slice(prefix.length)
  if (!/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number))) return false
  return suite.numbers.length === 0 || suite.numbers.includes(Number(number))
}
