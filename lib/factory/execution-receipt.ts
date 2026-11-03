import type { RunReport } from '@mikka/protocol/run'

/** Execution fixes the candidate; independent review/verify still gate acceptance.
 * Without an executor verify command, only a daemon-confirmed push can proceed. */
export function repositoryExecutionMatches(report: Pick<RunReport,'publish'|'verify'> | null | undefined, sha: string | null | undefined) {
  return typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha) && report?.publish?.commit === sha &&
    (report.verify?.status === 'passed' || (report.verify?.status === 'not_run' && report.publish.pushed === true))
}
