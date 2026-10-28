import type { FactoryPublicationReceiptV2 } from "./publication-receipt";

/** Reader output only, obtained under #192's authorized current-task lock.
 * This function validates observation binding, not permission or ancestry. */
export interface MonitorV2Observation {
  startedAt: string;
  finishedAt: string;
  target: FactoryPublicationReceiptV2["verifiedTarget"];
  health: { immutableStatus: number; immutableBodyValid: boolean; aliasStatus: number | null; aliasBodyValid: boolean | null };
  alias: { origin: string; before: string; after: string } | null;
}
export function validateMonitorV2Observation(
  receipt: FactoryPublicationReceiptV2,
  observation: MonitorV2Observation,
  configuredProductionOrigin: string,
): "healthy" | "unhealthy" | "blocked" {
  const r = receipt.verifiedTarget, o = observation.target, p = r.provider, q = o.provider;
  const production = receipt.action === "deploy_production";
  if (receipt.version !== 2 || !["deploy_preview", "deploy_production"].includes(receipt.action) || !p || !q ||
      r.kind !== (production ? "production-deployment" : "preview-deployment") ||
      r.environment !== (production ? "production" : "preview") ||
      r.environment !== receipt.targetEnvironment || r.target !== receipt.target ||
      r.sha !== receipt.candidate.sha || r.repository !== receipt.candidate.repository ||
      r.reference !== receipt.reference || p.publicationId !== receipt.publicationId ||
      p.version !== 2 || p.name !== "vercel" || p.environment !== r.environment ||
      p.deploymentId !== r.operationId || r.target !== `vercel:${p.teamId}:${p.projectId}:${p.environment}`)
    return "blocked";
  for (const key of ["kind", "operationId", "target", "environment", "repository", "sha", "reference"] as const)
    if (o[key] !== r[key]) return "blocked";
  for (const key of ["version", "name", "teamId", "projectId", "deploymentId", "environment", "publicationId", "bindingHash"] as const)
    if (q[key] !== p[key]) return "blocked";
  const published = Date.parse(receipt.publishedAt), started = Date.parse(observation.startedAt), finished = Date.parse(observation.finishedAt), observed = Date.parse(o.observedAt);
  if (![published, started, finished, observed].every(Number.isFinite) || started < published || finished < started || observed < started || observed > finished) return "blocked";
  if (production) {
    const a = observation.alias;
    if (!configuredProductionOrigin.startsWith("https://") || !a || a.origin !== configuredProductionOrigin || a.before !== p.deploymentId || a.after !== p.deploymentId) return "blocked";
  } else if (observation.alias !== null || observation.health.aliasStatus !== null || observation.health.aliasBodyValid !== null) return "blocked";
  const checks = [{ status: observation.health.immutableStatus, valid: observation.health.immutableBodyValid }, ...(production ? [{ status: observation.health.aliasStatus, valid: observation.health.aliasBodyValid }] : [])];
  if (checks.some(c => c.status === null || (c.status !== 200 && !(c.status >= 500 && c.status <= 599)))) return "blocked";
  if (checks.every(c => c.status === 200 && c.valid === true)) return "healthy";
  if (checks.some(c => (c.status !== null && c.status >= 500) || (c.status === 200 && c.valid === false))) return "unhealthy";
  return "blocked";
}
