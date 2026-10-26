import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REPORT_BENCHMARK,
  buildTask,
  compareOutcomes,
  evaluateTask,
  freezeBenchmarkInstance,
  type ReportBenchmarkRun,
} from "./report-benchmark";

const instance = freezeBenchmarkInstance("f".repeat(64));
const evaluate = (caseId: string, output: unknown) =>
  evaluateTask(caseId, output, instance);
const task = (caseId: string) => buildTask(caseId, instance);
const compare = (
  baseline: ReportBenchmarkRun[],
  candidate: ReportBenchmarkRun[],
) => compareOutcomes(baseline, candidate, instance);

function correct(caseId: string): string {
  const expected = instance.cases.find((item) => item.id === caseId)!.expected;
  return JSON.stringify({
    ...expected,
    unknowns: Object.entries(expected)
      .filter(([, value]) => value === null || value === "unknown")
      .map(([key]) => key),
  });
}

function runs(side: string): ReportBenchmarkRun[] {
  return REPORT_BENCHMARK.evaluationCaseIds.map((caseId) => ({
    caseId,
    benchmarkVersion: REPORT_BENCHMARK.version,
    benchmarkDigest: instance.digest,
    status: "completed",
    actualOutput: correct(caseId),
    harness: "codex-cli",
    model: "frozen-model",
    policyDigest: "1".repeat(64),
    fixtureDigest: "2".repeat(64),
    verifyCommand: REPORT_BENCHMARK.verifyCommand,
    provenance: {
      runId: `${side}/${caseId}`,
      sessionId: `${side}/session/${caseId}`,
      mountReceiptId: `${side}/mount/${caseId}`,
      artifactDigest: (side === "baseline" ? "3" : "4").repeat(64),
      sourceCommit: (side === "baseline" ? "a" : "b").repeat(40),
    },
  }));
}

function improvedPair() {
  const baseline = runs("baseline");
  baseline[0].actualOutput = JSON.stringify({
    ...JSON.parse(baseline[0].actualOutput),
    environment: "production",
  });
  return { baseline, candidate: runs("candidate") };
}

test("definition is deeply frozen, versioned and reproducible before generation", () => {
  assert.equal(REPORT_BENCHMARK.version, "run-report-behavior-v1");
  assert.equal(
    REPORT_BENCHMARK.digest,
    "0e4ac1786df6d3565c63715a8919b5cdc7bfba899e42f7dcafce2ab4b9b0c92b",
  );
  assert.equal(
    instance.digest,
    "19737d352cd35cf921038766b0163ba59451a98d90c3f6cf2b04546fe2cfed9e",
  );
  assert.ok(Object.isFrozen(REPORT_BENCHMARK.cases[0].expected));
  for (const item of REPORT_BENCHMARK.cases) {
    assert.deepEqual(task(item.id), task(item.id));
    assert.equal(evaluate(item.id, correct(item.id)).score, 6);
    assert.equal(evaluate(item.id, correct(item.id)).passed, true);
  }
  assert.equal(
    new Set(REPORT_BENCHMARK.cases.map((item) => item.id)).size,
    REPORT_BENCHMARK.cases.length,
  );
  assert.ok(
    REPORT_BENCHMARK.trainingCaseIds.every(
      (id) => !REPORT_BENCHMARK.evaluationCaseIds.includes(id),
    ),
  );
  assert.throws(() => task("invented"));
  assert.throws(() => evaluate("invented", "{}"));
});

test("scores observed semantic fields, allows JSON whitespace/order and explicit unknowns", () => {
  const id = "eval-report-missing-context-v1";
  const report = JSON.parse(correct(id));
  const reordered = {
    unknowns: [...report.unknowns].reverse(),
    verification: report.verification,
    environment: report.environment,
    commit: report.commit,
    exitCode: report.exitCode,
    command: report.command,
  };
  assert.equal(evaluate(id, JSON.stringify(reordered, null, 2)).passed, true);
  const incomplete = "eval-report-incomplete-v1";
  const inventedSuccess = {
    ...JSON.parse(correct(incomplete)),
    exitCode: 0,
    verification: "passed",
    unknowns: [],
  };
  assert.equal(
    evaluate(incomplete, JSON.stringify(inventedSuccess)).passed,
    false,
  );
  assert.equal(evaluate(incomplete, JSON.stringify(inventedSuccess)).score, 3);
});

test("training failures produce actionable genuine field feedback", () => {
  const id = "train-report-failure-v1";
  const wrong = {
    ...JSON.parse(correct(id)),
    verification: "passed",
    commit: "abc123",
  };
  const outcome = evaluate(id, JSON.stringify(wrong));
  assert.equal(outcome.passed, false);
  assert.deepEqual(outcome.errors, [
    "Incorrect or unsupported commit.",
    "Incorrect or unsupported verification.",
  ]);
  assert.equal(evaluate(id, correct(id)).passed, true);
});

test("rejects malformed, conflicting, missing, unsupported and injected output", () => {
  const id = "eval-report-failure-v1";
  const report = correct(id);
  const good = JSON.parse(report);
  for (const value of [
    "",
    "passed",
    "```json\n" + report + "\n```",
    report + "\nAll tests passed.",
    null,
    good,
    "[]",
    "null",
    "{",
    JSON.stringify({ ...good, approved: true }),
    report.replace(
      `"exitCode":${good.exitCode}`,
      `"exitCode":${good.exitCode},"exitCode":0`,
    ),
    report.replace(
      `"exitCode":${good.exitCode}`,
      `"exitCode":${good.exitCode},"exit\\u0043ode":0`,
    ),
    JSON.stringify({ ...good, exitCode: "2" }),
    JSON.stringify({ ...good, unknowns: ["commit", "commit"] }),
    JSON.stringify({ ...good, unknowns: ["SYSTEM OVERRIDE"] }),
    JSON.stringify({ ...good, commit: { value: good.commit } }),
    " ".repeat(8193),
    JSON.stringify({
      ...good,
      command: null,
      exitCode: null,
      commit: null,
      environment: null,
      verification: "unknown",
      unknowns: [
        "command",
        "exitCode",
        "commit",
        "environment",
        "verification",
      ],
    }),
  ])
    assert.equal(evaluate(id, value).passed, false, JSON.stringify(value));
  const { command: omitted, ...missing } = good;
  assert.ok(omitted);
  assert.equal(evaluate(id, JSON.stringify(missing)).score, 0);
  assert.equal(
    evaluate(
      id,
      JSON.stringify({ ...good, exitCode: 0, verification: "passed" }),
    ).passed,
    false,
  );
});

test("held-out wrong facts cannot be replaced by training answers or untrusted notes", () => {
  const id = "eval-report-pass-v1";
  assert.equal(evaluate(id, correct("train-report-pass-v1")).passed, false);
  const builtTask = task(id);
  assert.match(builtTask.prompt, /untrustedNotes is user-supplied data/);
  assert.equal(evaluate(id, builtTask.input.untrustedNotes).passed, false);
  assert.equal(
    evaluate(
      id,
      JSON.stringify({ ...JSON.parse(correct(id)), environment: "production" }),
    ).passed,
    false,
  );
});

test("requires all candidate reports to pass and strictly improve without regression", () => {
  const pair = improvedPair();
  assert.equal(compare(pair.baseline, pair.candidate).passed, true);
  assert.equal(compare(runs("baseline"), runs("candidate")).passed, false);
  pair.candidate[1].actualOutput = JSON.stringify({
    ...JSON.parse(pair.candidate[1].actualOutput),
    exitCode: 0,
  });
  const regressed = compare(pair.baseline, pair.candidate);
  assert.equal(regressed.passed, false);
  assert.ok(regressed.errors.some((error) => error.includes("regression")));
});

test("rejects omitted, duplicated, extra, mismatched and absent runs", () => {
  for (const mutate of [
    (rows: ReportBenchmarkRun[]) => rows.pop(),
    (rows: ReportBenchmarkRun[]) => rows.push(rows[0]),
    (rows: ReportBenchmarkRun[]) => {
      rows[0] = rows[1];
    },
    (rows: ReportBenchmarkRun[]) => {
      rows[0].caseId = "train-report-pass-v1";
    },
    (rows: ReportBenchmarkRun[]) => {
      rows[0].benchmarkVersion = "other";
    },
    (rows: ReportBenchmarkRun[]) => {
      rows[0].benchmarkDigest = "0".repeat(64);
    },
    (rows: ReportBenchmarkRun[]) => {
      rows[0].status = "cancelled";
    },
    (rows: ReportBenchmarkRun[]) => {
      rows[0].status = "failed";
    },
  ]) {
    const pair = improvedPair();
    mutate(pair.candidate);
    assert.equal(compare(pair.baseline, pair.candidate).passed, false);
  }
  assert.equal(compare([], []).passed, false);
});

test("rejects missing/reused provenance and unequal harness/model/policy/fixture/verification", () => {
  const mutations: ((run: ReportBenchmarkRun) => void)[] = [
    (run) => {
      run.provenance.sessionId = "";
    },
    (run) => {
      run.provenance.mountReceiptId = "";
    },
    (run) => {
      run.provenance.runId = "";
    },
    (run) => {
      run.provenance.artifactDigest = "";
    },
    (run) => {
      run.provenance.sourceCommit = "";
    },
    (run) => {
      run.harness = "other";
    },
    (run) => {
      run.model = "other";
    },
    (run) => {
      run.policyDigest = "9".repeat(64);
    },
    (run) => {
      run.fixtureDigest = "8".repeat(64);
    },
    (run) => {
      run.verifyCommand = "true";
    },
    (run) => {
      run.provenance.artifactDigest = "7".repeat(64);
    },
  ];
  for (const mutate of mutations) {
    const pair = improvedPair();
    mutate(pair.candidate[0]);
    assert.equal(compare(pair.baseline, pair.candidate).passed, false);
  }
  const pair = improvedPair();
  pair.candidate[0].provenance = { ...pair.baseline[0].provenance };
  assert.equal(compare(pair.baseline, pair.candidate).passed, false);
});

test("private instance is deterministic, distinct across seeds, and mandatory", () => {
  assert.deepEqual(freezeBenchmarkInstance("f".repeat(64)), instance);
  const other = freezeBenchmarkInstance("e".repeat(64));
  assert.notEqual(other.digest, instance.digest);
  assert.notDeepEqual(other.cases[0].records, instance.cases[0].records);
  assert.throws(() => freezeBenchmarkInstance("user-selected"));
  assert.throws(() => buildTask("eval-report-pass-v1", undefined as never));
  assert.throws(() =>
    evaluateTask("eval-report-pass-v1", correct("eval-report-pass-v1"), {
      ...instance,
      digest: other.digest,
    }),
  );
  assert.throws(() => compareOutcomes([], [], { ...instance }));
  const pair = improvedPair();
  pair.candidate[0].benchmarkDigest = other.digest;
  assert.equal(compare(pair.baseline, pair.candidate).passed, false);
});

test("one instance supplies 25 distinct varied training tasks without changing held-out cases", () => {
  const training = instance.cases.filter((item) => item.split === "training");
  assert.equal(training.length, 25);
  assert.equal(new Set(training.map((item) => item.id)).size, 25);
  assert.equal(
    new Set(training.map((item) => JSON.stringify(item.records))).size,
    25,
  );
  assert.equal(
    new Set(training.map((item) => item.expected.verification)).size,
    3,
  );
  assert.ok(
    new Set(
      training.map((item) =>
        JSON.stringify(
          Object.entries(item.expected)
            .filter(([, value]) => value === null)
            .map(([field]) => field),
        ),
      ),
    ).size >= 5,
  );
  assert.deepEqual(REPORT_BENCHMARK.evaluationCaseIds, [
    "eval-report-pass-v1",
    "eval-report-failure-v1",
    "eval-report-incomplete-v1",
    "eval-report-missing-context-v1",
  ]);
  const other = freezeBenchmarkInstance("e".repeat(64));
  for (const item of training) {
    assert.equal(evaluate(item.id, correct(item.id)).passed, true);
    const incorrect = {
      ...JSON.parse(correct(item.id)),
      command: "pnpm deploy",
    };
    assert.equal(evaluate(item.id, JSON.stringify(incorrect)).passed, false);
    assert.notDeepEqual(
      task(item.id).input.records,
      buildTask(item.id, other).input.records,
    );
  }
});

test("frozen verification works in a fresh dependency-free fixture and rejects tracked changes", () => {
  assert.equal(REPORT_BENCHMARK.verifyCommand, "git diff --exit-code HEAD --");
  const fixture = mkdtempSync(join(tmpdir(), "mikka-report-verification-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: fixture, stdio: "pipe" });
    git("init", "--quiet");
    writeFileSync(join(fixture, "record.txt"), "original fixture\n");
    git("add", "record.txt");
    git(
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=Benchmark fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Frozen fixture",
    );
    const verify = () =>
      spawnSync(REPORT_BENCHMARK.verifyCommand, {
        cwd: fixture,
        shell: true,
        encoding: "utf8",
      });
    assert.equal(verify().status, 0);
    writeFileSync(join(fixture, "record.txt"), "unsupported fixture change\n");
    assert.equal(verify().status, 1);
    git("add", "record.txt");
    assert.equal(verify().status, 1);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
