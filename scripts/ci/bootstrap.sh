#!/usr/bin/env bash
# This file is loaded from main by every consumer, not run from the PR checkout.
set -euo pipefail
candidate="$PWD"
trusted="$(mktemp -d)"
trap 'rm -rf "$trusted"' EXIT
# Use the base of a PR (including forks); main push uses its previous version.
# Read event fields as data, never shell interpolation from a PR title/ref.
trusted_sha="$(node --input-type=module -e '
import fs from "node:fs";
const e=JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH));
console.log(e.pull_request?.base?.sha || e.merge_group?.base_sha || (process.env.GITHUB_EVENT_NAME === "push" && e.before) || "origin/main")')"
if ! git cat-file -e "$trusted_sha^{commit}"; then trusted_sha=origin/main; fi
git archive "$trusted_sha" | tar -x -C "$trusted"
if test -f "$trusted/scripts/ci/select.mjs"; then
  # Install only trusted manifests; lifecycle scripts and Nx plugins never run
  # while installing. No PR dependency/configuration can execute in this job.
  pnpm --dir "$trusted" install --frozen-lockfile --ignore-scripts --filter next-app --filter @mikka/protocol
  CI_CANDIDATE_ROOT="$candidate" node "$trusted/scripts/ci/select.mjs"
else
  # Bootstrap PR: full legacy coverage; validate inventory with the old trusted
  # runner before any skip. A later main version enables selective decisions.
  CI_CANDIDATE_ROOT="$candidate" TRUSTED_ROOT="$trusted" node --input-type=module <<'JS'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
const { inventory, readTree } = await import(pathToFileURL(`${process.env.TRUSTED_ROOT}/scripts/run-db-tests.mjs`))
const root = process.env.CI_CANDIDATE_ROOT
const db = inventory(readTree(root), JSON.parse(fs.readFileSync(`${root}/package.json`)).scripts)
const result = { docs_only: false, full: true, core: true, integration: true, source: true, daemon: true, mobile: true, desktop: true, image: true, analytics: true, db: true, units: ['*'], db_suites: db.scripts, db_matrix: { shard: ['1/4','2/4','3/4','4/4'] } }
for (const [key,value] of Object.entries(result)) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}\n`)
fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## CI bootstrap\n\nTrusted selector not present at base: full coverage; complete candidate DB inventory validated.\n')
JS
fi
