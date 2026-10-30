import { z } from "zod";
import { FactoryError } from "./approval-contract";
import type { PublicationAdapter } from "./approval";
import {
  PublicationDeferred,
  publicationBindingHash,
  type PublicationInput,
} from "./publication-operation";
import { MIKKA_VERCEL, vercelTarget } from "./vercel-target";

// Re-exported for the existing tests and server composition.
export { MIKKA_VERCEL, vercelTarget } from "./vercel-target";
const configSchema = z
  .object({
    teamId: z.string().regex(/^team_[\w]+$/),
    projectId: z.string().regex(/^prj_[\w]+$/),
    projectName: z.string().min(1),
    repository: z.string().min(1),
    repoId: z.string().regex(/^\d+$/),
    environment: z.enum(["preview", "production"]),
  })
  .strict();
export type VercelPublicationConfig = z.infer<typeof configSchema>;
export interface VercelClient {
  request(
    path: string,
    method?: "GET" | "POST",
    body?: unknown,
  ): Promise<unknown>;
}
/** Runtime token is injected through the existing secret-managed binding. No CLI
 * account files, token creation, redirects, response bodies or credentials logged. */
export function createVercelClient(
  token: () => string | undefined,
  options: {
    fetch?: typeof fetch;
    testOrigin?: string;
    timeoutMs?: number;
  } = {},
): VercelClient {
  const origin = options.testOrigin ?? "https://api.vercel.com";
  if (options.testOrigin) {
    const u = new URL(origin);
    if (
      u.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
      u.origin !== origin
    )
      throw new FactoryError("factoryVercelOriginInvalid");
  }
  return {
    async request(path, method = "GET", body) {
      if (!path.startsWith("/") || path.startsWith("//"))
        throw new FactoryError("factoryVercelOriginInvalid");
      const credential = token();
      if (!credential)
        throw new FactoryError("factoryVercelCredentialUnavailable");
      let response: Response;
      try {
        response = await (options.fetch ?? fetch)(origin + path, {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
          headers: {
            Authorization: `Bearer ${credential}`,
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        throw new FactoryError("factoryVercelTransportUncertain");
      }
      if (!response.ok)
        throw new FactoryError(`factoryVercelHttp${response.status}`);
      try {
        return await response.json();
      } catch {
        throw new FactoryError("factoryVercelResponseInvalid");
      }
    },
  };
}
const object = z.object({}).catchall(z.unknown());
const checkpoint = z
  .object({
    version: z.literal(1),
    provider: z.literal("vercel"),
    operationId: z.string().regex(/^dpl_[\w]+$/),
    publicationId: z.uuid(),
    bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
function fail(): never {
  throw new FactoryError("factoryVercelIdentityMismatch");
}

/** Concrete Vercel REST implementation. Vercel does not promise create-request
 * idempotency here: the Factory durable ledger permits one POST; reconciliation
 * uses only GET/list and never interprets 'not found' as permission to create. */
export function createVercelPublicationAdapter(
  raw: VercelPublicationConfig,
  client: VercelClient,
): PublicationAdapter {
  const c = configSchema.parse(raw),
    target = vercelTarget(c);
  const action =
    c.environment === "production" ? "deploy_production" : "deploy_preview";
  const q = `teamId=${encodeURIComponent(c.teamId)}`;
  function context(input: PublicationInput) {
    const hash = publicationBindingHash(input),
      a = input.authorization!;
    if (
      a.action !== action ||
      a.target !== target ||
      a.targetEnvironment !== c.environment ||
      input.candidate.repository !== c.repository
    )
      fail();
    return hash;
  }
  async function project() {
    const p = object.parse(
      await client.request(`/v9/projects/${c.projectId}?${q}`),
    ) as Record<string, any>;
    if (
      p.id !== c.projectId ||
      p.accountId !== c.teamId ||
      p.name !== c.projectName ||
      p.link?.type !== "github" ||
      String(p.link.repoId) !== c.repoId
    )
      fail();
  }
  async function inspect(input: PublicationInput, id: string, hash: string) {
    const d = object.parse(
      await client.request(
        `/v13/deployments/${encodeURIComponent(id)}?${q}&withGitRepoInfo=true`,
      ),
    ) as Record<string, any>;
    const env =
      d.target === "production"
        ? "production"
        : d.target == null || d.target === "preview"
          ? "preview"
          : "custom";
    const projectId = d.projectId ?? d.project?.id;
    const ownerId = d.ownerId ?? d.teamId ?? d.team?.id;
    // Metadata is caller-supplied: it can correlate operations, never prove code.
    const actualSha = d.gitSource?.sha;
    if (
      d.id !== id ||
      projectId !== c.projectId ||
      ownerId !== c.teamId ||
      env !== c.environment ||
      d.customEnvironment ||
      d.customEnvironmentId ||
      actualSha !== input.candidate.sha ||
      d.meta?.factoryPublicationId !== input.idempotencyKey ||
      d.meta?.factoryBindingHash !== hash ||
      d.gitSource?.type !== "github" ||
      !(
        String(d.gitSource.repoId) === c.repoId ||
        (d.gitSource.org === "alexj11324" && d.gitSource.repo === "Mikka")
      ) ||
      (d.gitSource?.repoId != null &&
        String(d.gitSource.repoId) !== c.repoId) ||
      (d.gitSource?.sha &&
        d.meta?.githubCommitSha &&
        d.gitSource.sha !== d.meta.githubCommitSha)
    )
      fail();
    const saved = {
      version: 1 as const,
      provider: "vercel" as const,
      operationId: id,
      publicationId: input.idempotencyKey,
      bindingHash: hash,
    };
    if (d.readyState !== "READY")
      throw new PublicationDeferred(
        input.idempotencyKey,
        ["BUILDING", "QUEUED", "INITIALIZING"].includes(d.readyState)
          ? "pending"
          : // Vercel's terminal non-READY states: the deployment will never serve.
            ["ERROR", "CANCELED"].includes(d.readyState)
            ? "failed"
            : "uncertain",
        saved,
      );
    if (
      typeof d.url !== "string" ||
      !/^[a-z0-9][a-z0-9.-]*\.vercel\.app$/.test(d.url) ||
      d.url.includes("-git-") ||
      (d.gitSource?.org != null && d.gitSource.org !== "alexj11324") ||
      (d.gitSource?.repo != null && d.gitSource.repo !== "Mikka")
    )
      fail();
    if (
      c.environment === "production" &&
      (d.aliasAssigned !== true || d.aliasError)
    )
      throw new PublicationDeferred(input.idempotencyKey, "pending", saved);
    const reference = `https://${d.url}`;
    return {
      reference,
      verifiedTarget: {
        kind:
          c.environment === "production"
            ? ("production-deployment" as const)
            : ("preview-deployment" as const),
        operationId: id,
        target,
        environment: c.environment,
        repository: input.candidate.repository,
        sha: actualSha,
        reference,
        observedAt: new Date().toISOString(),
        provider: {
          version: 2 as const,
          name: "vercel" as const,
          teamId: c.teamId,
          projectId: c.projectId,
          deploymentId: id,
          environment: c.environment,
          publicationId: input.idempotencyKey,
          bindingHash: hash,
        },
      },
    };
  }
  async function reconcile(input: PublicationInput, saved: unknown) {
    const hash = context(input);
    await project();
    const cp = checkpoint.safeParse(saved);
    if (cp.success) {
      if (
        cp.data.publicationId !== input.idempotencyKey ||
        cp.data.bindingHash !== hash
      )
        fail();
      return inspect(input, cp.data.operationId, hash);
    }
    if (saved != null) fail();
    let until: number | undefined;
    const matches = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const path = `/v7/deployments?${q}&projectId=${c.projectId}&limit=100&sha=${input.candidate.sha}${until ? `&until=${until}` : ""}`;
      const list = object.parse(await client.request(path)) as Record<
        string,
        any
      >;
      if (!Array.isArray(list.deployments)) fail();
      for (const d of list.deployments)
        if (
          d.meta?.factoryPublicationId === input.idempotencyKey &&
          d.meta?.factoryBindingHash === hash &&
          typeof d.uid === "string"
        )
          matches.add(d.uid);
        else if (
          d.meta?.factoryPublicationId === input.idempotencyKey &&
          d.meta?.factoryBindingHash === hash &&
          typeof d.id === "string"
        )
          matches.add(d.id);
      const next = list.pagination?.next;
      if (next == null) break;
      if (
        typeof next !== "number" ||
        (until != null && next >= until) ||
        page === 9
      )
        throw new PublicationDeferred(input.idempotencyKey, "uncertain");
      until = next;
    }
    if (matches.size !== 1)
      throw new PublicationDeferred(input.idempotencyKey, "uncertain");
    return inspect(input, [...matches][0], hash);
  }
  return {
    action,
    target,
    environment: c.environment,
    async execute(input) {
      const hash = context(input);
      await project();
      await input.beforeCreate?.();
      if (Date.parse(input.authorization!.expiresAt) <= Date.now())
        throw new FactoryError("factoryApprovalInvalid");
      // Do not use branch tips, project/build overrides, files, forceNew or promotion.
      const d = object.parse(
        await client.request(`/v13/deployments?${q}`, "POST", {
          name: c.projectName,
          project: c.projectId,
          gitSource: {
            type: "github",
            repoId: c.repoId,
            ref: input.candidate.sha,
            sha: input.candidate.sha,
          },
          ...(c.environment === "production" ? { target: "production" } : {}),
          meta: {
            factoryPublicationId: input.idempotencyKey,
            factoryBindingHash: hash,
          },
        }),
      ) as Record<string, any>;
      if (typeof d.id !== "string" || !/^dpl_[\w]+$/.test(d.id))
        throw new PublicationDeferred(input.idempotencyKey, "uncertain");
      try {
        return await inspect(input, d.id, hash);
      } catch (error) {
        if (error instanceof PublicationDeferred) throw error;
        throw new PublicationDeferred(input.idempotencyKey, "uncertain", {
          version: 1,
          provider: "vercel",
          operationId: d.id,
          publicationId: input.idempotencyKey,
          bindingHash: hash,
        });
      }
    },
    reconcile,
  };
}

export function configuredVercelPublicationAdapters(
  env: Record<string, string | undefined>,
): PublicationAdapter[] {
  if (env.FACTORY_VERCEL_PUBLICATION !== "1") return [];
  if (!env.VERCEL_TOKEN)
    throw new FactoryError("factoryVercelCredentialUnavailable");
  const client = createVercelClient(() => env.VERCEL_TOKEN);
  // Existing mikka resources only; enabling production is a separate explicit flag.
  return [
    createVercelPublicationAdapter(
      { ...MIKKA_VERCEL, environment: "preview" },
      client,
    ),
    ...(env.FACTORY_VERCEL_PRODUCTION === "1"
      ? [
          createVercelPublicationAdapter(
            { ...MIKKA_VERCEL, environment: "production" },
            client,
          ),
        ]
      : []),
  ];
}
