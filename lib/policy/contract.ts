import { z } from "zod";
import {
  CONFIGURABLE_ACTIONS,
  defaultRunPolicy,
  networkAllowSchema,
  storedPermissionsSchema,
  type RunPolicy,
} from "@mikka/protocol/agent-policy";

export class PolicyError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
  }
}
export const endpointSchema = z
  .string()
  .max(300)
  .transform((value, ctx) => {
    try {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.port ||
        /[%\\]/.test(value)
      )
        throw new Error();
      return url.toString().replace(/\/$/, "");
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "Exact HTTPS endpoint without credentials, query or fragment required",
      });
      return z.NEVER;
    }
  });
export const modelRouteSchema = z.strictObject({
  provider: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/),
  endpoint: endpointSchema,
  // unknown explicitly means no geographic restriction or compliance claim.
  region: z.enum(["unknown", "us", "eu"]),
});
export type ModelRoute = z.infer<typeof modelRouteSchema>;
const layerSchema = z.strictObject({
  scope: z.enum(["workspace", "team", "project", "user"]),
  id: z.string().min(1).max(200),
  defaults: storedPermissionsSchema.optional(),
  ceiling: storedPermissionsSchema.optional(),
  networkAllow: networkAllowSchema.optional(),
  models: z.array(modelRouteSchema).max(64).optional(),
  readOnly: z.boolean().optional(),
});
export const documentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    state: z.enum(["enforce", "revoked"]),
    offlineTtlSeconds: z.number().int().min(30).max(300),
    layers: z.array(layerSchema).min(1).max(128),
  })
  .superRefine((doc, ctx) => {
    const keys = doc.layers.map((l) => `${l.scope}:${l.id}`);
    if (
      new Set(keys).size !== keys.length ||
      doc.layers.filter((l) => l.scope === "workspace").length !== 1
    )
      ctx.addIssue({
        code: "custom",
        message: "Exactly one workspace layer and no duplicate scope required",
      });
  });
export type PolicyDocument = z.infer<typeof documentSchema>;
export type PolicyContext = {
  workspaceId: string;
  userId: string;
  teamIds?: string[];
  projectIds?: string[];
};
export type EffectivePolicy = {
  policy: RunPolicy;
  modelCeilings: ModelRoute[][];
  sources: { scope: string; id: string }[];
  ttlSeconds: number;
};
const rank = { deny: 0, ask: 1, allow: 2 };
const order = { workspace: 0, team: 1, project: 2, user: 3 };
export function resolvePolicy(
  document: PolicyDocument,
  context: PolicyContext,
  requested?: RunPolicy,
): EffectivePolicy {
  const doc = documentSchema.parse(document);
  if (doc.state === "revoked") throw new PolicyError("policyRevoked", 403);
  if (
    !doc.layers.some(
      (l) => l.scope === "workspace" && l.id === context.workspaceId,
    )
  )
    throw new PolicyError("policyScopeMismatch", 403);
  const layers = doc.layers
    .filter(
      (l) =>
        l.scope === "workspace" ||
        (l.scope === "user" && l.id === context.userId) ||
        (l.scope === "team" && context.teamIds?.includes(l.id)) ||
        (l.scope === "project" && context.projectIds?.includes(l.id)),
    )
    .sort(
      (a, b) => order[a.scope] - order[b.scope] || a.id.localeCompare(b.id),
    );
  const policy = defaultRunPolicy();
  for (const layer of layers) Object.assign(policy.permissions, layer.defaults);
  if (requested) Object.assign(policy.permissions, requested.permissions);
  // Ceilings are accumulated separately, so a lower default can never erase one.
  for (const layer of layers)
    for (const action of CONFIGURABLE_ACTIONS) {
      const ceiling = layer.ceiling?.[action];
      if (ceiling && rank[ceiling] < rank[policy.permissions[action]])
        policy.permissions[action] = ceiling;
    }
  // Use intersection, including explicit empty sets. Never broaden a wildcard by text substitution.
  const networkSets = layers.flatMap((l) =>
    l.networkAllow === undefined ? [] : [l.networkAllow],
  );
  if (requested) networkSets.push(requested.networkAllow);
  if (networkSets.length) {
    policy.networkAllow = [...new Set(networkSets[0])].filter((d) =>
      networkSets.every((set) => set.includes(d)),
    );
    if (policy.permissions.network === "allow")
      policy.permissions.network = "ask";
  }
  if (layers.some((l) => l.readOnly) || requested?.readOnly) {
    policy.readOnly = true;
    for (const action of [
      "install_dependency",
      "write_outside_repo",
      "git_push",
    ] as const)
      policy.permissions[action] = "deny";
  }
  return {
    policy,
    modelCeilings: layers.flatMap((l) =>
      l.models === undefined ? [] : [l.models],
    ),
    sources: layers.map(({ scope, id }) => ({ scope, id })),
    ttlSeconds: doc.offlineTtlSeconds,
  };
}
export function admitModel(
  effective: EffectivePolicy,
  input: ModelRoute,
): ModelRoute {
  const route = modelRouteSchema.parse(input);
  // A managed policy must explicitly allow a route. Empty/absent is deny.
  if (
    !effective.modelCeilings.length ||
    !effective.modelCeilings.every((list) =>
      list.some(
        (r) =>
          r.provider === route.provider &&
          r.model === route.model &&
          r.endpoint === route.endpoint &&
          r.region === route.region,
      ),
    )
  )
    throw new PolicyError("modelRouteDenied", 403);
  return route;
}
