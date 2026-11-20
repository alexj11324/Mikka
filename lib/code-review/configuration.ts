import type { CodeReviewConfiguration } from './settings-contract'

/** These preferences shape findings, never waive task criteria, security checks or missing evidence. */
export function codeReviewInstructions(config: CodeReviewConfiguration) {
  return [
    'Workspace code review preferences:',
    `Report findings at severity ${config.severity} or higher (low < medium < high < critical). Required task acceptance criteria and security/tenant/data-integrity findings still apply at every threshold.`,
    `Ignore paths matching these repository-relative globs for optional line-by-line commentary: ${JSON.stringify(config.ignoredPaths)}. Do not omit a required acceptance criterion or a demonstrated security defect because of a glob.`,
    config.output === 'summary'
      ? 'Return one review summary with evidence and unverified observations. Do not post inline comments or GitHub review comments.'
      : 'Return concrete findings with repository path, line, severity and evidence; group repeated findings. When the task explicitly authorizes GitHub comments, post only these findings through the existing authorized GitHub capability, never approve or merge.',
  ].join('\n')
}
