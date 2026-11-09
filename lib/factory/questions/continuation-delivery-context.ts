type DeliveryContext = {
  issueId: string | null;
  kind: string;
  readOnly: boolean | undefined;
  gitPush: string | undefined;
  repository?: string;
  branch?: string;
  baseBranch?: string;
};

/**
 * A native question resume sends followUp instead of the full stored prompt.
 * Preserve the accepted answer and restore only the host-admitted publication
 * destination already present in this claim response. This grants no authority.
 */
export function withFactoryQuestionDeliveryContext(
  claim: Record<string, unknown>,
  context: DeliveryContext,
): Record<string, unknown> {
  if (claim.requireSessionResume !== true || typeof claim.questionId !== 'string'
    || typeof claim.followUp !== 'string' || !claim.followUp
    || !context.issueId || !['implement', 'fix'].includes(context.kind)
    || context.readOnly !== false || context.gitPush !== 'allow'
    || !context.branch
    || !context.repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository)) {
    return claim;
  }
  const delivery = {
    source: 'host_admitted_factory_publication',
    issueId: context.issueId,
    repository: `https://github.com/${context.repository}`,
    taskBranch: context.branch,
    ...(context.baseBranch ? { baseBranch: context.baseBranch } : {}),
    pullRequestBodyMarker: `<!-- mikka-issue:${context.issueId} -->`,
  };
  const block = `Host publication context for this existing task:\n${JSON.stringify(delivery)}\nUse the existing task branch and repository for the requested delivery. Keep the original verification and human approval requirements. End the pull request body with the issue marker above. This context grants no new permission.`;
  if (claim.followUp.endsWith(block)) return claim;
  return { ...claim, followUp: `${claim.followUp}\n\n${block}` };
}
