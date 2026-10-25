import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { FactoryError, candidateSchema } from "./contract";
import type { PublicationAdapter } from "./approval";
import { digest } from "./evidence";

const configSchema = z
  .object({
    root: z.string().min(1),
    target: z.string().min(1).max(2000),
    repository: z.string().min(1),
    environment: z.string().regex(/^local(?:-|$)/),
    candidateEnvironment: z.string().min(1).max(4000),
  })
  .strict();
export type LocalPublicationConfig = z.infer<typeof configSchema>;
const payloadSchema = z
  .object({ idempotencyKey: z.uuid(), candidate: candidateSchema })
  .strict();

/** Actual local artifact publication, not a cloud deployment or fake provider. */
export function createLocalPublicationAdapter(
  input: LocalPublicationConfig,
): PublicationAdapter {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success || !isAbsolute(input.root))
    throw new FactoryError("factoryLocalTargetInvalid");
  const config = parsed.data;
  return {
    action: "deploy_preview",
    target: config.target,
    environment: config.environment,
    async execute(input) {
      const parsed = payloadSchema.safeParse(input);
      if (!parsed.success) throw new FactoryError("factoryLocalTargetInvalid");
      const payload = parsed.data;
      if (
        payload.candidate.repository !== config.repository ||
        payload.candidate.environment !== config.candidateEnvironment
      )
        throw new FactoryError("factoryLocalTargetMismatch");
      await mkdir(config.root, { recursive: true, mode: 0o700 });
      // The trusted configuration owns the directory. Inputs never choose paths.
      if ((await lstat(config.root)).isSymbolicLink())
        throw new FactoryError("factoryLocalTargetInvalid");
      const root = await realpath(config.root);
      const path = join(root, `${payload.idempotencyKey}.json`);
      const serialized =
        JSON.stringify({
          target: config.target,
          targetEnvironment: config.environment,
          ...payload,
        }) + "\n";
      let file;
      try {
        file = await open(path, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (
          (await lstat(path)).isSymbolicLink() ||
          (await readFile(path, "utf8")) !== serialized
        )
          throw new FactoryError("factoryLocalReceiptMismatch");
      }
      if (file) {
        try {
          await file.writeFile(serialized);
          await file.sync();
        } finally {
          await file.close();
        }
      }
      const observed = await readFile(path, "utf8");
      if (
        observed !== serialized ||
        digest(JSON.parse(observed).candidate) !== digest(payload.candidate)
      )
        throw new FactoryError("factoryLocalReceiptMismatch");
      const sha256 = createHash("sha256").update(observed).digest("hex");
      const reference = `local-artifact:${payload.idempotencyKey}:sha256:${sha256}`;
      return {
        reference,
        verifiedTarget: {
          kind: "local-artifact",
          operationId: payload.idempotencyKey,
          target: config.target,
          repository: payload.candidate.repository,
          environment: config.environment,
          sha: payload.candidate.sha,
          reference,
          observedAt: new Date().toISOString(),
        },
      };
    },
  };
}

/** No cloud credentials, network calls, provider SDKs or production fallback. */
export function configuredLocalPublicationAdapters(
  env: Record<string, string | undefined>,
): PublicationAdapter[] {
  if (!env.FACTORY_PUBLICATION_MODE && !env.FACTORY_LOCAL_PUBLICATION_ROOT)
    return [];
  let origin: URL;
  try {
    origin = new URL(env.BETTER_AUTH_URL ?? "");
  } catch {
    throw new FactoryError("factoryLocalTargetInvalid");
  }
  if (
    env.FACTORY_PUBLICATION_MODE !== "local-artifact" ||
    env.NODE_ENV === "production" ||
    env.VERCEL ||
    env.VERCEL_ENV ||
    origin.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
  )
    throw new FactoryError("factoryLocalTargetInvalid");
  return [
    createLocalPublicationAdapter({
      root: env.FACTORY_LOCAL_PUBLICATION_ROOT ?? "",
      target: env.FACTORY_LOCAL_PUBLICATION_TARGET ?? "",
      repository: env.FACTORY_LOCAL_PUBLICATION_REPOSITORY ?? "",
      environment: env.FACTORY_LOCAL_PUBLICATION_ENVIRONMENT ?? "",
      candidateEnvironment:
        env.FACTORY_LOCAL_PUBLICATION_CANDIDATE_ENVIRONMENT ?? "",
    }),
  ];
}
