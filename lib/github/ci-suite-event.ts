import { z } from 'zod'

// This projection is only a wake hint after the caller has verified GitHub's
// raw-body signature. It is not a required-check rollup or an approval.
const id = z.number().int().positive().refine(Number.isSafeInteger)
const source = z.object({
  action: z.literal('completed'),
  installation: z.object({ id }),
  repository: z.object({
    id,
    full_name: z.string().regex(/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[\w.-]{1,100}$/i)
      .refine(name => !['.', '..'].includes(name.split('/')[1])),
  }),
  check_suite: z.object({
    id,
    status: z.literal('completed'),
    head_sha: z.string().regex(/^[a-f0-9]{40}$/i),
    conclusion: z.string().regex(/^[a-z_]{1,40}$/),
    pull_requests: z.array(z.object({ number: id, head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/i) }).optional() })).max(100),
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
  /** PR source HEAD from the suite's association, when GitHub provides it. */
  heads: Record<string, string>
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
    heads: Object.fromEntries(suite.pull_requests.flatMap(pr => pr.head ? [[String(pr.number), pr.head.sha.toLowerCase()]] : [])),
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
    || !row.headSha || !/^[a-f0-9]{40}$/i.test(row.headSha)
    || !row.pullUrl.toLowerCase().startsWith(prefix)) return false
  const number = row.pullUrl.slice(prefix.length)
  if (!/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number))) return false
  // PR checks may run against GitHub's synthetic merge SHA. Use the PR's
  // associated head.sha when present, not the check suite's merge SHA.
  if (suite.numbers.length === 0) return row.headSha.toLowerCase() === suite.headSha
  if (!suite.numbers.includes(Number(number))) return false
  const associatedHead = suite.heads[number]
  return !associatedHead || row.headSha.toLowerCase() === associatedHead
}
