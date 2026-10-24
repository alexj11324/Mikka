// Linux-only deterministic CPA acceptance. No cloud credentials or E2B calls.
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { createServer } from "node:net"
import { fileURLToPath } from "node:url"
import { Pool } from "pg"

if (process.platform !== "linux")
  throw new Error("Run BYOS acceptance on the cloud Agent's Linux environment")
const root = fileURLToPath(new URL("../", import.meta.url))
const worker = fileURLToPath(
  new URL("../packages/subscription-worker/", import.meta.url)
)
const baseEnv = { PATH: process.env.PATH, LANG: "C.UTF-8" }
const networkEnv = { ...baseEnv }
for (const name of [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR"
])
  if (process.env[name]) networkEnv[name] = process.env[name]
const run = (command, args, env = baseEnv) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: ["ignore", "inherit", "inherit"]
    })
    child.on("error", () =>
      reject(new Error("BYOS test subprocess could not start"))
    )
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`BYOS test subprocess exited ${code}`))
    )
  })
const reserve = createServer()
await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve))
const port = reserve.address().port
await new Promise((resolve) => reserve.close(resolve))
const suffix = randomUUID()
const name = `mikka-cpa-test-${suffix}`
const password = `fixture-${suffix}`
const database = `mikka_cpa_e2e`
const url = `postgresql://mikka_test:${password}@127.0.0.1:${port}/${database}`
const pool = new Pool({
  connectionString: url,
  max: 1,
  connectionTimeoutMillis: 500
})
let started = false
try {
  await run(
    process.execPath,
    ["packages/subscription-worker/bootstrap.mjs"],
    networkEnv
  )
  await run("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "--memory=256m",
    "--cpus=1",
    "-p",
    `127.0.0.1:${port}:5432`,
    "-e",
    "POSTGRES_USER=mikka_test",
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    `POSTGRES_DB=${database}`,
    "postgres:17-alpine@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb"
  ])
  started = true
  let ready = false
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await pool.query("select 1")
      ready = true
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  if (!ready) throw new Error("Disposable BYOS Postgres did not become ready")
  const migrationEnv = {
    ...baseEnv,
    MIGRATE: "1",
    MIKKA_DATABASE_URL: url,
    DATABASE_URL: url
  }
  await run(process.execPath, ["scripts/migrate.mjs"], migrationEnv)
  mkdirSync(`${worker}.cache/build`, { recursive: true })
  mkdirSync(`${worker}.cache/mod`, { recursive: true })
  const ca = "/etc/ssl/certs/ca-certificates.crt"
  const dockerArgs = [
    "run",
    "--rm",
    "--memory=6g",
    "--cpus=4",
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--network",
    "host",
    "-v",
    `${worker}:/work`,
    "-w",
    "/work",
    "-e",
    "GOCACHE=/work/.cache/build",
    "-e",
    "GOMODCACHE=/work/.cache/mod",
    "-e",
    "GOTOOLCHAIN=local",
    "-e",
    `MIKKA_BYOS_TEST_DATABASE_URL=${url}`,
    "-e",
    "MIKKA_BYOS_WORKER_BINARY=/work/bin/mikka-subscription-worker"
  ]
  if (existsSync(ca))
    dockerArgs.push(
      "-v",
      `${ca}:/etc/ssl/certs/mikka-host-ca.crt:ro`,
      "-e",
      "SSL_CERT_FILE=/etc/ssl/certs/mikka-host-ca.crt"
    )
  dockerArgs.push(
    "golang:1.26.10-bookworm@sha256:632dff7351799a5a9954a48dc06670ade72ee44e8c351cdc0e5a57af2fea21af",
    "sh",
    "-c",
    "go build -mod=readonly -o bin/mikka-subscription-worker ./cmd/mikka-subscription-worker && go test -mod=readonly -race -timeout 90s -count=1 -v ./... && go vet -mod=readonly ./... && ./bin/mikka-subscription-worker --version"
  )
  await run("docker", dockerArgs)
  await run(process.execPath, ["scripts/migrate.mjs"], migrationEnv)
  const { rows } = await pool.query(
    "select count(*)::int as migrations from schema_migrations"
  )
  console.log(
    `BYOS acceptance passed: ${rows[0].migrations} migrations; repeat migration passed; disposable Postgres + TLS fakes only`
  )
} finally {
  await pool.end()
  if (started) await run("docker", ["stop", "--timeout", "2", name])
}
