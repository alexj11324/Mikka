import { FactoryError } from "./contract";
import type { MonitorProbeAdapter, MonitorPublication } from "./monitor-probe";
import { MIKKA_VERCEL, vercelTarget } from "./vercel-publication";

export const FACTORY_HEALTH_PATH = "/mikka/api/health";
export const MIKKA_PRODUCTION_ORIGIN = "https://app.aspectlylabs.com";
const API_ORIGIN = "https://api.vercel.com";
type Environment = "preview" | "production";
type Options = { testOrigin?: string; timeoutMs?: number; maxBytes?: number };
class ProbeFailure extends Error {
  constructor(readonly category: string) {
    super(category);
  }
}
function fail(category: string): never {
  throw new ProbeFailure(category);
}
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("response-invalid");
  return value as Record<string, any>;
}

/** Read-only observation. No request can create, promote or reconcile a deployment.
 * Runtime destinations are fixed; the loopback override is constructor-only test infrastructure. */
export function createVercelMonitorProbe(
  environment: Environment,
  token: () => string | undefined,
  options: Options = {},
): MonitorProbeAdapter {
  if (!["preview", "production"].includes(environment))
    throw new FactoryError("factoryMonitorTargetInvalid");
  if (options.testOrigin) {
    const u = new URL(options.testOrigin);
    if (
      u.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
      u.origin !== options.testOrigin
    )
      throw new FactoryError("factoryMonitorTargetInvalid");
  }
  const target = vercelTarget({ ...MIKKA_VERCEL, environment });
  const kind =
    environment === "production"
      ? "production-deployment"
      : "preview-deployment";
  const action =
    environment === "production" ? "deploy_production" : "deploy_preview";
  return {
    kind,
    target,
    environment,
    repository: MIKKA_VERCEL.repository,
    async execute(receipt: MonitorPublication) {
      const provider = receipt.verifiedTarget.provider;
      const health = {
        path: FACTORY_HEALTH_PATH as typeof FACTORY_HEALTH_PATH,
        immutableStatus: 0,
        immutableBodyValid: false,
        aliasBodyValid: environment === "production" ? false : null,
        aliasOrigin:
          environment === "production" ? MIKKA_PRODUCTION_ORIGIN : null,
        aliasBefore: null as string | null,
        aliasAfter: null as string | null,
        aliasStatus: null as number | null,
      };
      const observation = {
        observedSha: "unknown",
        observedTarget: "unknown",
        observedEnvironment: "unknown",
        observedOperationId: "unknown",
        observedReference: "unknown",
      };
      const signal = AbortSignal.timeout(
        Math.min(options.timeoutMs ?? 10000, 15000),
      );
      let errorCode: string | null = null;
      async function json(
        url: string,
        api: boolean,
        status?: (value: number) => void,
      ) {
        const credential = api ? token() : undefined;
        if (api && !credential) fail("credential-unavailable");
        const response = await fetch(url, {
          method: "GET",
          redirect: "error",
          signal,
          headers: api
            ? {
                Authorization: `Bearer ${credential}`,
                Accept: "application/json",
              }
            : { Accept: "application/json" },
        });
        status?.(response.status);
        if (response.status !== 200) {
          await response.body?.cancel();
          fail(
            api
              ? `provider-http-${response.status}`
              : `health-http-${response.status}`,
          );
        }
        const limit = Math.min(options.maxBytes ?? 131072, 131072);
        const reader = response.body?.getReader();
        if (!reader) fail("response-invalid");
        let size = 0;
        const chunks: Uint8Array[] = [];
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > limit) fail("response-too-large");
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        try {
          return {
            status: response.status,
            value: object(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
          };
        } catch (error) {
          if (error instanceof ProbeFailure) throw error;
          fail("response-invalid");
        }
      }
      const api = async (path: string) =>
        (
          await json(
            options.testOrigin
              ? `${options.testOrigin}/api${path}`
              : API_ORIGIN + path,
            true,
          )
        ).value;
      const q = `teamId=${encodeURIComponent(MIKKA_VERCEL.teamId)}`;
      async function inspect(
        idOrHost: string,
        aliasSlot?: "aliasBefore" | "aliasAfter",
      ) {
        const d = await api(
          `/v13/deployments/${encodeURIComponent(idOrHost)}?${q}&withGitRepoInfo=true`,
        );
        if (aliasSlot)
          health[aliasSlot] =
            typeof d.id === "string" && /^dpl_[\w]+$/.test(d.id)
              ? d.id
              : "unknown";
        const actualEnvironment =
          d.target === "production"
            ? "production"
            : d.target == null || d.target === "preview"
              ? "preview"
              : "custom";
        const git = d.gitSource;
        if (
          d.id !== provider!.deploymentId ||
          (d.projectId ?? d.project?.id) !== MIKKA_VERCEL.projectId ||
          (d.ownerId ?? d.teamId ?? d.team?.id) !== MIKKA_VERCEL.teamId ||
          actualEnvironment !== environment ||
          d.customEnvironment ||
          d.customEnvironmentId ||
          d.readyState !== "READY" ||
          git?.type !== "github" ||
          git.sha !== receipt.candidate.sha ||
          !(
            String(git.repoId) === MIKKA_VERCEL.repoId ||
            (git.org === "alexj11324" && git.repo === "Mikka")
          ) ||
          (git.repoId != null && String(git.repoId) !== MIKKA_VERCEL.repoId) ||
          (git.org != null && git.org !== "alexj11324") ||
          (git.repo != null && git.repo !== "Mikka") ||
          (d.meta?.githubCommitSha && d.meta.githubCommitSha !== git.sha) ||
          d.meta?.factoryPublicationId !== receipt.publicationId ||
          d.meta?.factoryBindingHash !== provider!.bindingHash ||
          typeof d.url !== "string" ||
          !/^[a-z0-9][a-z0-9.-]*\.vercel\.app$/.test(d.url) ||
          d.url.includes("-git-") ||
          `https://${d.url}` !== receipt.reference ||
          (environment === "production" &&
            (d.aliasAssigned !== true || d.aliasError))
        )
          fail("deployment-identity-mismatch");
        return {
          id: d.id as string,
          sha: git.sha as string,
          reference: `https://${d.url}`,
        };
      }
      async function checkHealth(origin: string, slot: "immutable" | "alias") {
        const url = options.testOrigin
          ? `${options.testOrigin}/health/${slot}${FACTORY_HEALTH_PATH}`
          : origin + FACTORY_HEALTH_PATH;
        const response = await json(url, false, (status) => {
          if (slot === "immutable") health.immutableStatus = status;
          else health.aliasStatus = status;
        });
        const valid = response.value.status === "ok" && response.value.service === "mikka";
        if (slot === "immutable") health.immutableBodyValid = valid;
        else health.aliasBodyValid = valid;
        if (!valid) fail("health-invalid");
        return response.status;
      }
      try {
        if (
          receipt.version !== 2 ||
          receipt.action !== action ||
          receipt.target !== target ||
          receipt.targetEnvironment !== environment ||
          receipt.candidate.repository !== MIKKA_VERCEL.repository ||
          receipt.verifiedTarget.kind !== kind ||
          receipt.verifiedTarget.target !== target ||
          receipt.verifiedTarget.environment !== environment ||
          receipt.verifiedTarget.repository !== MIKKA_VERCEL.repository ||
          receipt.verifiedTarget.sha !== receipt.candidate.sha ||
          receipt.verifiedTarget.reference !== receipt.reference ||
          !/^[a-f0-9]{40}$/.test(receipt.candidate.sha) ||
          !provider ||
          provider.version !== 2 ||
          provider.name !== "vercel" ||
          provider.teamId !== MIKKA_VERCEL.teamId ||
          provider.projectId !== MIKKA_VERCEL.projectId ||
          provider.environment !== environment ||
          provider.publicationId !== receipt.publicationId ||
          !/^[a-f0-9]{64}$/.test(provider.bindingHash) ||
          !/^dpl_[\w]+$/.test(provider.deploymentId) ||
          provider.deploymentId !== receipt.verifiedTarget.operationId
        )
          fail("receipt-identity-mismatch");
        const reference = new URL(receipt.reference);
        if (
          reference.origin !== receipt.reference ||
          reference.protocol !== "https:" ||
          reference.username ||
          reference.password ||
          reference.search ||
          reference.hash
        )
          fail("receipt-identity-mismatch");
        const project = await api(
          `/v9/projects/${MIKKA_VERCEL.projectId}?${q}`,
        );
        if (
          project.id !== MIKKA_VERCEL.projectId ||
          project.accountId !== MIKKA_VERCEL.teamId ||
          project.name !== MIKKA_VERCEL.projectName ||
          project.link?.type !== "github" ||
          String(project.link.repoId) !== MIKKA_VERCEL.repoId
        )
          fail("project-identity-mismatch");
        const deployment = await inspect(provider.deploymentId);
        Object.assign(observation, {
          observedSha: deployment.sha,
          observedTarget: target,
          observedEnvironment: environment,
          observedOperationId: deployment.id,
          observedReference: deployment.reference,
        });
        if (environment === "production")
          await inspect(
            new URL(MIKKA_PRODUCTION_ORIGIN).hostname,
            "aliasBefore",
          );
        // An application failure is actionable only while the provider still
        // identifies this exact deployment. Preserve the first health failure,
        // but always attempt the final identity read; a moved/unknown target
        // must override it rather than authorize repairing an old deployment.
        let healthFailure: { error: unknown } | undefined;
        try {
          health.immutableStatus = await checkHealth(
            receipt.reference,
            "immutable",
          );
        } catch (error) {
          healthFailure = { error };
        }
        if (environment === "production") {
          try {
            health.aliasStatus = await checkHealth(
              MIKKA_PRODUCTION_ORIGIN,
              "alias",
            );
          } catch (error) {
            healthFailure ??= { error };
          }
          await inspect(
            new URL(MIKKA_PRODUCTION_ORIGIN).hostname,
            "aliasAfter",
          );
        } else await inspect(provider.deploymentId);
        if (healthFailure) throw healthFailure.error;
      } catch (error) {
        errorCode = signal.aborted
          ? "probe-timeout"
          : error instanceof ProbeFailure
            ? error.category
            : "probe-transport-error";
      }
      return {
        command: "GET vercel deployment identity + fixed application health v2",
        exitCode: errorCode ? 1 : 0,
        signal: null,
        timedOut: signal.aborted,
        ...observation,
        errorCode,
        provider,
        health,
        stdout: JSON.stringify({
          result: errorCode ?? "healthy",
          kind,
          immutableStatus: health.immutableStatus,
          aliasStatus: health.aliasStatus,
        }),
        stderr: "",
      };
    },
  };
}

export function configuredVercelMonitorProbes(
  env: Record<string, string | undefined>,
): MonitorProbeAdapter[] {
  // Publication remains an explicit resource/cost choice. Its finished GET-only
  // observer follows that configuration, unless the operator explicitly stops it.
  if (env.FACTORY_VERCEL_MONITOR === "0") return [];
  if (env.FACTORY_VERCEL_PUBLICATION !== "1") {
    if (env.FACTORY_VERCEL_MONITOR === "1")
      throw new FactoryError("factoryMonitorTargetInvalid");
    return [];
  }
  if (!env.VERCEL_TOKEN)
    throw new FactoryError("factoryVercelCredentialUnavailable");
  return [
    createVercelMonitorProbe("preview", () => env.VERCEL_TOKEN),
    ...(env.FACTORY_VERCEL_PRODUCTION === "1"
      ? [createVercelMonitorProbe("production", () => env.VERCEL_TOKEN)]
      : []),
  ];
}
