import { criterionVerificationStatus, runCriterion, type RunReport, type ReviewVerdict } from '@mikka/protocol/run';

/** A completed review is not a claim that every acceptance observation passed. */
export function factoryReviewVerdict(report: RunReport): ReviewVerdict {
  if (report.verify.status === 'failed') return 'changes_requested';
  if (report.reviewVerdict === 'needs_judgment') return 'needs_judgment';
  if (report.reviewVerdict === 'changes_requested' || report.criteria?.some(c => criterionVerificationStatus(c) === 'failed'))
    return 'changes_requested';
  return 'passed';
}

/** Unknown/malformed observations cannot pass the provenance gate. */
export function factoryReviewCriteriaComplete(report: RunReport): boolean {
  if (!report.criteria?.length || report.criteria.length > 200) return false;
  return report.criteria.every(value => {
    const parsed = runCriterion.safeParse(value);
    if (!parsed.success) return false;
    const criterion = parsed.data, status = criterionVerificationStatus(criterion);
    if (status === 'unverified') return !!criterion.reason?.trim();
    return !!criterion.evidence?.trim() && (status === 'passed' || report.reviewVerdict === 'needs_judgment');
  });
}
