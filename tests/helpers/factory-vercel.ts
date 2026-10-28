import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createVercelClient,
  MIKKA_VERCEL,
} from "../../lib/factory/vercel-publication";

/** Real loopback HTTP protocol substitute. This is not a Vercel deployment. */
export async function vercelProtocolFixture() {
  const requests: { method: string; path: string; body: any }[] = [];
  const deployments = new Map<string, any>();
  const state = {
    readyState: "READY",
    dropCreateResponse: false,
    aliasAssigned: true,
    projectDelayMs: 0,
    project: {
      id: MIKKA_VERCEL.projectId,
      accountId: MIKKA_VERCEL.teamId,
      name: MIKKA_VERCEL.projectName,
      link: { type: "github", repoId: Number(MIKKA_VERCEL.repoId) },
    },
  };
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer disposable-protocol-fixture") {
      res.writeHead(401);
      res.end();
      return;
    }
    const url = new URL(req.url!, "http://localhost");
    if (url.searchParams.get("teamId") !== MIKKA_VERCEL.teamId) {
      res.writeHead(403);
      res.end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method!, path: url.pathname, body });
    let data: unknown;
    if (url.pathname === `/v9/projects/${MIKKA_VERCEL.projectId}`) {
      if (state.projectDelayMs)
        await new Promise((resolve) =>
          setTimeout(resolve, state.projectDelayMs),
        );
      data = state.project;
    } else if (req.method === "POST" && url.pathname === "/v13/deployments") {
      const id = `dpl_fixture${deployments.size + 1}`;
      deployments.set(id, {
        id,
        projectId: MIKKA_VERCEL.projectId,
        ownerId: MIKKA_VERCEL.teamId,
        target: body.target ?? null,
        gitSource: body.gitSource,
        meta: { ...body.meta, githubCommitSha: body.gitSource.sha },
        readyState: state.readyState,
        aliasAssigned: state.aliasAssigned,
        url: `mikka-fixture${deployments.size + 1}-mikka-dev.vercel.app`,
      });
      if (state.dropCreateResponse) {
        req.socket.destroy();
        return;
      }
      data = { id };
    } else if (url.pathname === "/v7/deployments")
      data = {
        deployments: [...deployments.values()].map((d) => ({
          ...d,
          uid: d.id,
        })),
        pagination: { next: null },
      };
    else data = deployments.get(url.pathname.split("/").at(-1)!);
    if (!data) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("address");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    requests,
    deployments,
    state,
    origin,
    client: createVercelClient(() => "disposable-protocol-fixture", {
      testOrigin: origin,
    }),
    posts: () => requests.filter((r) => r.method === "POST").length,
    async close() {
      // This closure owns ONLY the loopback listener created by this invocation.
      // User authorized recycling newly created managed test resources; no
      // pre-existing listener/container/schema/log is selected or removed.
      const audit = await mkdtemp(join(tmpdir(), "factory194-protocol-"));
      await writeFile(
        join(audit, "protocol.json"),
        JSON.stringify(
          {
            origin,
            requests,
            deployments: [...deployments.values()],
            state,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      console.info("Factory194 retained protocol audit", audit, origin);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
