// No new periodic data polling (docs/design/decisions/2026-11-05-0200-no-new-polling.md).
// Data changes reach the screen by live push (hooks/use-live-key.tsx, lib/live/*),
// tracked in #1212. Every poller that exists today is listed in pollingAllowlist,
// with its reason and its hit count, so the list only shrinks: a new poller fails,
// a replaced one must leave the list.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";

export const pollingMessage =
  "不要新增轮询；数据变化用 live push（`hooks/use-live-key.tsx` / `lib/live/*`），见 #1212；确实只是界面计时器或外部 API 才加入 allowlist 并写明原因。";

export const pollingRoots = [
  "app/",
  "components/",
  "hooks/",
  "lib/",
  "packages/",
  "apps/",
  "workflows/",
  "cloudflare/",
  "scripts/",
  "services/",
  "deploy/",
];

const daemon = "lib/device-gateway-notify.ts";
const server = "lib/live/notify.ts";
const db = (replaceWith, reason, hits) => ({
  tracking: "#1212",
  replaceWith,
  reason,
  hits,
});
const ui = (reason, hits) => ({ kind: "ui-timer", reason, hits });
const external = (reason, hits) => ({ kind: "external", reason, hits });
const local = (reason, hits) => ({ kind: "local", reason, hits });
const harness = (reason, hits) => ({ kind: "harness", reason, hits });

/**
 * Files allowed to poll, and why. `hits` is the number of findings the file has
 * today; more fails (new polling), fewer fails too (lower it, or drop the entry).
 * - kind 'ui-timer': reads no data (animations, clocks, loaders).
 * - kind 'external': polls a third-party API, not our database.
 * - kind 'local': waits on state on the same machine (a file lock, a local browser), no network.
 * - kind 'harness': explicit bounded acceptance/test operation, not a shipped idle runtime.
 * - kind 'keepalive': keeps the live push connection itself open.
 * - tracking '#1212': a database poll still waiting to be replaced by push, through `replaceWith`.
 */
export const pollingAllowlist = {
  "packages/subscription-worker/native_broker.go": db(
    daemon,
    "active native request authorization rechecked every second while upstream is silent; must replace with revocation events without widening authorization in #2820",
    1,
  ),
  "packages/subscription-worker/stream.go": db(
    daemon,
    "active stream authorization rechecked every second; pending cancellation/revocation event integration in #2820",
    1,
  ),
  "packages/daemon/scripts/refresh-cloud-worker.py": external(
    "release utility waits for a Cloudflare worker operation; audit event or bounded completion in #2820",
    1,
  ),
  "scripts/e2b/mock-device-server.py": local(
    "explicit fixture simulates paced output, not product state polling",
    2,
  ),
  "scripts/e2b/subagent-gateway.py": local(
    "broker/socket readiness and file-backed child state waits plus real grant expiry; replace local state reads with lifecycle events in #2820",
    5,
  ),
  "scripts/e2b/viewer-gateway.py": local(
    "bounded local viewer socket ready wait; replace with process readiness event in #2820",
    1,
  ),
  "scripts/e2b/subagent-live-acceptance.py": local(
    "explicit live acceptance pacing and bounded ready waits, not idle product reads",
    4,
  ),
  "scripts/e2b/viewer-probe.py": local(
    "explicit visual probe paces pointer and capture actions; no product state polling",
    3,
  ),
  // scripts/: explicit acceptance harnesses keep bounded, task-scoped state checks visible
  // to the scanner without treating them as idle production readers.
  "scripts/acceptance/cloud-lease-probe.py": harness(
    "waits once for the real lease-expiry window, then performs one verification read; explicit acceptance only",
    1,
  ),
  "scripts/acceptance/cloud-startup.mjs": harness(
    "bounded cleanup retries after a revision conflict in explicit startup acceptance; no idle service reader",
    1,
  ),
  "scripts/acceptance/device-closeout.mjs": harness(
    "bounded acceptance wait for a requested device-closeout result",
    1,
  ),
  "scripts/acceptance/factory-continuation.mjs": harness(
    "bounded test waits while an explicitly created factory task runs; not background product polling",
    1,
  ),
  "scripts/acceptance/inbox-production.mjs": {
    kind: "keepalive",
    reason: "heartbeat keeps the explicit live-inbox acceptance WebSocket open; no business state reads",
    hits: 1,
  },
  "scripts/acceptance/model-provider-fallback.mjs": harness(
    "bounded integration acceptance observes its owned test request and protects its test order from mutation",
    1,
  ),
  "scripts/acceptance/owned-process-supervisor.py": local(
    "bounded wait for an owned child process to exit during explicit supervisor acceptance",
    1,
  ),
  "scripts/acceptance/owned-process-tree.mjs": local(
    "bounded process-tree teardown wait after explicit acceptance sends SIGTERM",
    1,
  ),
  "scripts/acceptance/project-decisions.mjs": harness(
    "bounded integration acceptance observes its owned test request and protects its test order from mutation",
    1,
  ),
  "scripts/acceptance/run-observability.mjs": {
    kind: "keepalive",
    reason: "WebSocket heartbeat and one-shot capability renewal for a live acceptance connection; reconnect triggers one catch-up read",
    hits: 2,
  },
  "scripts/acceptance/runtime-performance.mjs": local(
    "samples OS process memory during an explicit performance test; no application or database reads",
    1,
  ),
  "scripts/acceptance/wake-consumer-closeout.mjs": harness(
    "waits until the persisted nextWakeAt deadline during explicit wake-recovery acceptance",
    1,
  ),
  "scripts/acceptance/workflow-migration-production.mjs": harness(
    "bounded integration acceptance checks its own schedule create/cancel actions and persisted results",
    3,
  ),
  "scripts/dev-local.mjs": local(
    "local developer fixture refresh retries account linking and seed setup; not a shipped runtime or production reader",
    1,
  ),
  "scripts/dev-local/acceptance.mjs": harness(
    "explicit local acceptance runner emits progress heartbeats and checks its owned acceptance session/lease",
    3,
  ),
  "scripts/dev-local/factory-watchdog-acceptance.mjs": harness(
    "bounded local watchdog acceptance observes its owned run and cancellation state",
    2,
  ),
  "scripts/dev-local/mailbox-acceptance.mjs": harness(
    "explicit mailbox acceptance waits on its own test predicate with cancellation support",
    1,
  ),
  "scripts/dev-local/seed-model-keys-loop.ts": local(
    "local development fixture loop refreshes seeded model keys; not a deployed product runtime",
    1,
  ),
  "scripts/dev-local/worker-mailbox-acceptance.mjs": harness(
    "explicit worker mailbox acceptance waits on its own test predicate with cancellation support",
    1,
  ),
  "scripts/device-gateway/deploy.mjs": external(
    "bounded deploy-time release-status checks for an explicit gateway deployment, not an idle app reader",
    1,
  ),
  "scripts/ops/group-factory-acceptance.mjs": harness(
    "bounded acceptance checks for explicitly created factory tasks, reports and stop outcome",
    5,
  ),
  "scripts/ops/group-production-acceptance.mjs": harness(
    "bounded production acceptance waits for its explicitly created group conversation result",
    1,
  ),
  "scripts/ops/issues-1516-welcome-acceptance.mjs": harness(
    "bounded acceptance cleanup verifies only its owned bot and work state",
    1,
  ),
  "scripts/ops/posthog-export-evidence.mjs": external(
    "bounded wait for an explicit third-party PostHog export job to finish",
    1,
  ),
  "scripts/ops/production-mobile-daemon.mjs": harness(
    "bounded production acceptance verifies its own device revocation after an explicit uninstall",
    1,
  ),
  "scripts/release/ci-gate.mjs": external(
    "bounded release gate reads GitHub Actions status during an explicit release operation",
    1,
  ),
  "scripts/release/web-deploy.mjs": external(
    "bounded release-time checks for the deployed build and source identity",
    1,
  ),
  "scripts/run-factory-http-tests.mjs": local(
    "bounded readiness check for the local test server immediately after starting it",
    1,
  ),
  "scripts/start-app.mjs": local(
    "bounded local server startup readiness check immediately after process start",
    1,
  ),
  "scripts/suggestions-cron/deploy.mjs": external(
    "bounded deploy-time release-status checks for an explicit suggestions-cron deployment",
    1,
  ),
  "scripts/test-accounts/run-http.mjs": local(
    "bounded readiness wait for the owned local HTTP test server after spawn",
    1,
  ),
  "scripts/test-accounts/session.mjs": harness(
    "renews a short-lived lease held by an explicit account test session; stops when the session closes",
    1,
  ),
  "scripts/test-auth-email.mjs": local(
    "bounded readiness check for the isolated local PostgreSQL test database after startup",
    1,
  ),
  "scripts/test-subscription-enrollment-app.mjs": local(
    "bounded readiness check for the local test container immediately after startup",
    1,
  ),
  "scripts/test-subscription-worker-pull.mjs": external(
    "bounded retry of an explicit Docker image pull after transient registry failures",
    1,
  ),
  "scripts/test-subscription-worker.mjs": local(
    "bounded readiness check for the isolated local PostgreSQL test database after startup",
    1,
  ),
  "packages/daemon/src/main.ts": db(
    daemon,
    "recursive heartbeat renews active run leases and reconciles offline state; migrate exact lease deadlines and gateway recovery together in #2820",
    1,
  ),
  "lib/mcp/reply-signals.ts": {
    kind: "keepalive",
    reason:
      "backoff reconnects failed LISTEN transports only; current-state read is requested once after successful registration; no status timer",
    hits: 1,
  },
  "packages/protocol/src/relay-client.ts": {
    kind: "keepalive",
    reason:
      "relay WebSocket ping and bounded-backoff reconnect; no business state polling",
    hits: 2,
  },
  "hooks/use-list-expiry.ts": ui(
    "one-shot deadlines repaint local age filters; no server request",
    1,
  ),
  "lib/builtin-gateway/hub.ts": local(
    "one-shot presence expiration based on the last received frame; reschedules only when that deadline changes",
    1,
  ),
  "lib/builtin-gateway/presence.ts": local(
    "one-shot watch or heartbeat expiration; refreshes authorized presence at its real expiration boundary",
    1,
  ),
  "lib/db/device-scope.ts": local(
    "ends an idle transaction fence once after its last in-flight operation; not a business-state check",
    1,
  ),
  "packages/daemon/src/agents/machine-github.ts": external(
    "credential refresh at its actual expiration deadline, including the platform maximum timer boundary",
    1,
  ),
  "packages/daemon/src/subscription-credentials.ts": external(
    "subscription credential refresh at the active lease expiration, not a fixed status interval",
    1,
  ),
  "packages/daemon/src/outbox.ts": local(
    "retries persisted undelivered output after an actual delivery failure; no timer while the outbox is empty",
    1,
  ),
  "apps/desktop/scripts/notarize.mjs": external(
    "bounded notarization job status wait during an explicit release; inspect provider callback alternatives in #2820",
    1,
  ),
  "packages/daemon/scripts/release.mjs": external(
    "bounded GitHub Actions release job wait during an explicit release, not an idle runtime reader",
    1,
  ),
  "scripts/e2b/cloud-local-acceptance.mjs": local(
    "acceptance-only bounded ready wait and output heartbeat; not shipped product runtime",
    2,
  ),
  "scripts/e2b/worker-live.ts": local(
    "acceptance-only bounded machine and run waits; not shipped product runtime",
    3,
  ),
  "lib/builtin-gateway/scheduler.ts": local(
    "自托管 cron 调度器替代 Cloudflare cron，不是数据轮询；复用已有 due-timer 和 15 分钟 safety sweep",
    1,
  ),
  // Web: SWR polling that reads our database.
  // Server: loops that re-query our database.
  "app/v1/devices/[deviceId]/commands/route.ts": db(
    daemon,
    "long poll fallback timer only: with the gateway configured it waits on LISTEN for the device (re-check per NOTIFY, one final check at the deadline); every 5 s without push or if LISTEN drops",
    1,
  ),
  "lib/coordinator/group-turns.ts": db(
    server,
    "untilStopped fallback only: 15 s for best-effort subscriptions or a failed reliable-push read, 1 s if LISTEN is unavailable",
    1,
  ),
  // Daemon: loops that call our server, which reads the database.
  "packages/daemon/src/agents/tool-approval.ts": db(
    daemon,
    "ToolApprovalGate fallback timer only: none while the device gateway pushes run control, every 20 s while it is down (always so for a cloud computer, whose server pushes), 1 s against a server older than run-control push; a watcher with timedFloorMs runs at most that often on timer ticks",
    2,
  ),
  "packages/daemon/src/login.ts": db(
    daemon,
    "device login polls the token endpoint at the server-given interval until approved (RFC 8628)",
    1,
  ),
  "packages/daemon/src/runs/supervisor.ts": db(
    daemon,
    "CHECKPOINT_EVERY_MS: a periodic write, not a read; saves an idle run's checkpoint to the server at most every 2 min",
    1,
  ),
  // Third-party APIs.
  "apps/desktop/src/main/index.ts": external(
    "the existing published GitHub desktop-release update check; no Mikka database request and disabled in Mikka Dev",
    1,
  ),
  "apps/desktop/src/main/ssh-install.ts": external(
    "bounded SSH installation handshake (30 attempts) reads remote daemon status after an explicit user install; not idle application polling",
    1,
  ),
  // Same machine only.
  "packages/daemon/src/lock.ts": local("waits for the daemon file lock", 1),
  "packages/daemon/src/repositories.ts": local(
    "waits for the repository cache file lock",
    1,
  ),
  "packages/daemon/src/adapters/mock.ts": local(
    "mock adapter paces scripted output",
    1,
  ),
  "lib/db/transport-sample.ts": local(
    "flushes the in-process database transfer counter to the log once a minute; runs no query",
    1,
  ),
  "lib/schedules/claim-child.mts": local(
    "keeps a database-test child process alive until it is killed; reads nothing",
    1,
  ),
  // The push channel's own keepalive.
  "packages/daemon/src/device-gateway.ts": {
    kind: "keepalive",
    reason:
      "pings the device gateway WebSocket so live push stays connected; reads no data",
    hits: 1,
  },
  // UI timers: read no data.
  "components/motion/loader.tsx": ui("loader animation frames", 3),
  "components/ui/thinking-loader-clean.tsx": ui("thinking loader animation", 1),
  "components/workspace/agent-demo.tsx": ui("types out the demo code", 1),
  "components/onboarding/onboarding.tsx": ui(
    "onboarding waits up to 5 s for data another hook is already loading; no read of its own",
    2,
  ),
  "apps/mobile/components/beui/components/loader/loader.tsx": ui(
    "loader animation frames",
    3,
  ),
  "apps/mobile/components/beui/components/loading-states/agent-progress.tsx":
    ui("progress animation", 1),
  "apps/mobile/components/beui/components/loading-states/reasoning-text.tsx":
    ui("reasoning text animation", 2),
  "apps/mobile/components/beui/components/tool-result/tool-result.tsx": ui(
    "elapsed-time clock",
    1,
  ),
  "hooks/settings/use-subscriptions.ts": external(
    'RFC 8628 device authorization uses the provider interval until expiry; the 30 s setInterval only ages the meters\' "updated" label; the meters themselves read on the model_settings push and on focus once older than 5 min',
    2,
  ),
  "apps/mobile/features/chat/screens/chat-screen.tsx": ui(
    "the 1 s elapsed clock of a reply in progress; the chat and its proposals are pushed (lib/live.ts)",
    1,
  ),
};

const delayCall =
  /\bawait\s+(?:(?:sleep|delay|wait|pause|setTimeout|scheduler\.wait)\s*\(|new\s+Promise\b[\s\S]{0,300}?\bsetTimeout\b)/;
// The interval may be the literal 0 or false; anything else (a number, a constant, a function) polls.
const off = String.raw`\s*(?:0|false)\s*(?:[,}\n)]|$)`;

const definition = /^\s*(?:export\s+)?(?:async\s+)?function\s*$/;
const rules = [
  {
    rule: "polling/refresh-interval",
    pattern: new RegExp(
      String.raw`\b(?:refreshInterval|refetchInterval)\s*:(?!${off})`,
      "g",
    ),
  },
  {
    rule: "polling/refresh-interval",
    pattern: new RegExp(
      String.raw`\b(?:refreshInterval|refetchInterval)\s*=\s*\{(?!\s*(?:0|false)\s*\})`,
      "g",
    ),
  },
  {
    rule: "polling/refresh-interval",
    pattern: /[{,]\s*(?:refreshInterval|refetchInterval)\s*(?=[,}])/g,
  },
  { rule: "polling/set-interval", pattern: /\bsetInterval\s*\(/g },
  {
    rule: "polling/poll-constant",
    pattern:
      /\b[A-Z][A-Z0-9_]*(?:_POLL_MS|POLL_INTERVAL[A-Z0-9_]*|_EVERY_MS)\s*=(?!=)/g,
  },
  { rule: "polling/helper", skip: definition, pattern: /\bpollUntil\(/g },
];

/** Where a loop body ends: a braced block, or the rest of its single-statement line. */
function loopBody(source, from) {
  const lead = source.slice(from).match(/^\s*/)[0].length;
  const start = from + lead;
  const lineEnd = source.indexOf("\n", start);
  if (source[start] !== "{")
    return source.slice(start, lineEnd < 0 ? source.length : lineEnd);
  for (let depth = 0, i = start; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0)
      return source.slice(start, i + 1);
  }
  return source.slice(start);
}

/**
 * A `while` or `for` loop that awaits a delay: sleep, delay, wait, pause, setTimeout.
 * Skipped: `for…of`/`for…in`, and short retries bounded by a literal of 10 or less
 * (`attempt < 3`), which back off rather than poll.
 */
function sleepLoops(source) {
  const found = [];
  for (const match of source.matchAll(/\b(?:while|for)\s*\(/g)) {
    let i = match.index + match[0].length;
    for (let depth = 1; depth > 0 && i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
    }
    const header = source.slice(match.index, i);
    if (/^for\s*\(\s*(?:const|let|var)\s+[^;]*?\b(?:of|in)\b/.test(header))
      continue;
    if (/<=?\s*(?:10|[0-9])\s*[;)&|]/.test(header)) continue;
    if (delayCall.test(loopBody(source, i))) found.push(match.index);
  }
  return found;
}

// The one-shot mobile API accepts a named decoder. The old positional interval
// and any unrecognized options still fail, even with nested calls in the path.
function mobilePollingCalls(file, source) {
  if (!source.includes("useApi")) return [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const positions = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "useApi" &&
      node.arguments.length > 1
    ) {
      const option = node.arguments[1];
      const disabled =
        option.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(option) && option.text === "undefined") ||
        (ts.isNumericLiteral(option) && Number(option.text) === 0);
      const property =
        ts.isObjectLiteralExpression(option) && option.properties.length === 1
          ? option.properties[0]
          : null;
      const reader =
        property &&
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "read" &&
        ts.isIdentifier(property.initializer);
      if (node.arguments.length !== 2 || !(disabled || reader))
        positions.push(node.expression.getStart(tree));
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return positions;
}

/** Follow local function calls to find timers that can schedule their owning
 * function again, including an arrow callback or mutually recursive helpers.
 * Unlike a text search, comments, strings and type mentions aren't executable. */
function recursiveTimers(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const functions = new Map();
  const functionName = (node) => {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node))
      return node.name?.getText(tree);
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      ts.isVariableDeclaration(node.parent)
    )
      return node.parent.name.getText(tree);
  };
  function collect(node) {
    const name = functionName(node);
    if (name && node.body) {
      const entries = functions.get(name) ?? [];
      entries.push(node.body);
      functions.set(name, entries);
    }
    ts.forEachChild(node, collect);
  }
  collect(tree);
  const nameOf = (expression) =>
    ts.isIdentifier(expression)
      ? expression.text
      : ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : "";
  function reaches(node, target, seen = new Set()) {
    if (!node) return false;
    if (ts.isCallExpression(node)) {
      const name = nameOf(node.expression);
      if (name === target) return true;
      if (!seen.has(name)) {
        const next = new Set([...seen, name]);
        if (
          (functions.get(name) ?? []).some((body) =>
            reaches(body, target, next),
          )
        )
          return true;
      }
    }
    return (
      ts.forEachChild(node, (child) => reaches(child, target, seen)) === true
    );
  }
  const found = [];
  function visit(node, owners = []) {
    const name = functionName(node);
    if (name) owners = [...owners, name];
    if (ts.isCallExpression(node) && nameOf(node.expression) === "setTimeout") {
      const callback = node.arguments[0];
      const bodies =
        callback && ts.isIdentifier(callback)
          ? (functions.get(callback.text) ?? [])
          : [callback];
      if (
        owners.some(
          (owner) =>
            (callback &&
              ts.isIdentifier(callback) &&
              callback.text === owner) ||
            bodies.some((body) => reaches(body, owner)),
        )
      )
        found.push(node.expression.getStart(tree));
    }
    ts.forEachChild(node, (child) => visit(child, owners));
  }
  visit(tree);
  return found;
}

/** Queue libraries may poll even when application code has no timer. Explicit
 * settings (including zero, which some libraries interpret as a default) must
 * be reviewed with their locked dependency, not silently exempted. */
function queueConfiguration(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found = [];
  function visit(node) {
    if (
      (ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node)) &&
      /^(?:WORKFLOW_POSTGRES_POLL_INTERVAL_MS|pollInterval|poll_interval)$/.test(
        node.name.getText(tree).replace(/^['"]|['"]$/g, ""),
      )
    )
      found.push(node.name.getStart(tree));
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}

function at(file, source, index, rule) {
  const before = source.slice(0, index);
  return {
    file,
    line: before.split("\n").length,
    column: index - before.lastIndexOf("\n"),
    rule,
    message: pollingMessage,
  };
}

/** Every polling site in one file, allowlisted or not. */
export function findPolling(file, source) {
  const found = [];
  if (/\.(?:py|go)$/.test(file)) {
    const pattern = file.endsWith(".go")
      ? /\btime\.(?:Sleep|NewTicker|Tick)\s*\(/g
      : /\b(?:asyncio|time)\.sleep\s*\(/g;
    for (const match of source.matchAll(pattern)) {
      const prefix = source.slice(
        source.lastIndexOf("\n", match.index) + 1,
        match.index,
      );
      if (/^\s*(?:#|\/\/)/.test(prefix)) continue;
      found.push(at(file, source, match.index, "polling/native-wait"));
    }
    return found;
  }
  for (const { rule, pattern, skip } of rules) {
    for (const match of source.matchAll(pattern)) {
      if (
        skip &&
        skip.test(
          source.slice(source.lastIndexOf("\n", match.index) + 1, match.index),
        )
      )
        continue;
      found.push(at(file, source, match.index, rule));
    }
  }
  for (const index of mobilePollingCalls(file, source))
    found.push(at(file, source, index, "polling/helper"));
  for (const index of recursiveTimers(file, source))
    found.push(at(file, source, index, "polling/recursive-timer"));
  for (const index of queueConfiguration(file, source))
    found.push(at(file, source, index, "polling/queue-configuration"));
  for (const index of sleepLoops(source))
    found.push(at(file, source, index, "polling/sleep-loop"));
  return found.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** Findings that fail: polling in a file not on the allowlist, or more than its entry allows. */
export function auditPolling(file, source, allowlist = pollingAllowlist) {
  const found = findPolling(file, source);
  const entry = allowlist[file];
  if (!entry) return found;
  if (found.length > entry.hits)
    return found.map((d) => ({
      ...d,
      message: `${pollingMessage}（allowlist 只允许这个文件 ${entry.hits} 处，现在 ${found.length} 处）`,
    }));
  return [];
}

export function pollingPolicyFiles() {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter(
      (file) =>
        pollingRoots.some((root) => file.startsWith(root)) &&
        /\.(?:[cm]?[jt]sx?|py|go)$/.test(file) &&
        !/(?:^|\/)(?:node_modules|\.next|dist|out|build|__tests__|tests?|e2e)\//.test(
          file,
        ) &&
        !/\.(?:test|spec|fixture|stories)\.[cm]?[jt]sx?$/.test(file) &&
        !file.endsWith("_test.go") &&
        !/\.(?:test|spec|fixture)\.py$/.test(file) &&
        !file.endsWith(".d.ts") &&
        existsSync(file),
    );
}

/** Tests are not shipped code: test files by name, and files that import a test runner. */
export const isTestSource = (source) =>
  /\bfrom\s+['"](?:node:test|vitest|bun:test|@playwright\/test)['"]/.test(
    source,
  );

export function auditRepository() {
  return pollingPolicyFiles().flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return isTestSource(source) ? [] : auditPolling(file, source);
  });
}

/** Allowlist entries that no longer match the code: a replaced poller, or a count to lower. */
export function staleAllowlistEntries(allowlist = pollingAllowlist) {
  return Object.entries(allowlist).flatMap(([file, entry]) => {
    if (!existsSync(file))
      return [
        `${file}: file no longer exists; delete its pollingAllowlist entry`,
      ];
    const hits = findPolling(file, readFileSync(file, "utf8")).length;
    if (hits === 0)
      return [`${file}: no polling left; delete its pollingAllowlist entry`];
    if (hits < entry.hits)
      return [
        `${file}: ${hits} polling sites, allowlist says ${entry.hits}; lower it`,
      ];
    return [];
  });
}
