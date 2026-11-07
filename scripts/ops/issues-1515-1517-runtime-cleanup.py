"""Recover only reviewed private candidates left by the E2BIG release failure.

Uses the normal release finalizer, including exact metadata, private visibility,
alias/ID agreement and GET-404 after deletion. No application login or DB writes.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import unittest
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
REPOSITORY = 'alexj11324/Mikka'
BRANCH = 'refs/heads/ops/1515-1517-acceptance'
TARGETS = [{
    'sourceCommit': 'd72227c94eb25174c92d77e4c74e55abe578aa99',
    'runId': '42328947041', 'runAttempt': '1',
    'templates': {
        'desktop': '0a5qaq69lrw2bn7iz7pj',
        'claude': 'g249155wp8lskmgydask',
        'codex': 'xjvt6dck202q4jpaabby',
    },
}, {
    'sourceCommit': '080b14b4b1e098c055f1c6dea021a1c49d3f0131',
    'runId': '42331353700', 'runAttempt': '1',
    'templates': {
        'desktop': 'pq15889g70osb15d1kt8',
        'claude': 'nie7b19posv18cf0ny3p',
        'codex': 'p0dwie1ie0nes5gfmaop',
    },
}, {
    'sourceCommit': 'c594da2b81aac8ff466a94e5050839513a002b0e',
    'runId': '42333305079', 'runAttempt': '1',
    'templates': {
        'desktop': 'k55iu4egu0vsb56mkepl',
        'claude': '5paxyux2zx68jxowmc0r',
        'codex': 'hfpht8fzgbt4jrqpbu1v',
    },
}]


def check(value, code):
    if not value:
        raise ValueError(code)


def verify_failed_run(run, jobs, target):
    check(str(run.get('id')) == target['runId']
          and str(run.get('run_attempt')) == target['runAttempt']
          and run.get('head_sha') == target['sourceCommit']
          and run.get('head_branch') == 'main' and run.get('event') == 'push'
          and run.get('path') == '.github/workflows/e2b-official-runtime.yml'
          and run.get('repository', {}).get('full_name') == REPOSITORY
          and run.get('status') == 'completed' and run.get('conclusion') == 'failure',
          'runtime_cleanup_run_identity_mismatch')
    rows = jobs.get('jobs', [])
    check(jobs.get('total_count') == len(rows) and 0 < len(rows) <= 100,
          'runtime_cleanup_jobs_incomplete')
    for name, conclusion in [('subscriptions', 'failure'), ('cleanup', 'failure'), ('publish', 'skipped')]:
        matches = [row for row in rows if row.get('name') == name]
        check(len(matches) == 1 and matches[0].get('status') == 'completed'
              and matches[0].get('conclusion') == conclusion,
              'runtime_cleanup_failure_not_verified')


def target_report(target):
    check(re.fullmatch(r'[a-f0-9]{40}', target['sourceCommit'])
          and re.fullmatch(r'[1-9][0-9]*', target['runId'])
          and re.fullmatch(r'[1-9][0-9]*', target['runAttempt'])
          and set(target['templates']) == {'desktop', 'claude', 'codex'},
          'runtime_cleanup_target_invalid')
    return {'sourceCommit': target['sourceCommit'], 'templates': {
        kind: {'baseTemplate': kind, 'templateId': template_id,
               'name': f"mikka-{target['sourceCommit'][:12]}-{target['runId']}-{target['runAttempt']}-{kind}"}
        for kind, template_id in target['templates'].items()
    }}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        raise ValueError('runtime_cleanup_github_redirect_refused')


def github(path, token):
    request = urllib.request.Request('https://api.github.com/repos/' + REPOSITORY + path,
        headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                 'X-GitHub-Api-Version': '2022-11-28'})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
        return json.load(response)


def run():
    check(os.environ.get('GITHUB_REPOSITORY') == REPOSITORY and os.environ.get('GITHUB_REF') == BRANCH,
          'runtime_cleanup_driver_scope_mismatch')
    source = os.environ.get('APPLICATION_SHA', '')
    check(re.fullmatch(r'[a-f0-9]{40}', source)
          and re.fullmatch(r'[a-f0-9]{40}', os.environ.get('GITHUB_SHA', '')),
          'runtime_cleanup_source_required')
    subprocess.run(['git', 'merge-base', '--is-ancestor', source, 'HEAD'], cwd=ROOT, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['git', 'diff', '--exit-code', source, 'HEAD', '--',
                    'scripts/e2b/cleanup-template-candidates.py', 'scripts/e2b/build-template.py'],
                   cwd=ROOT, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    token, api_key = os.environ.get('GITHUB_TOKEN'), os.environ.get('E2B_API_KEY')
    check(token and api_key, 'runtime_cleanup_credentials_required')
    spec = importlib.util.spec_from_file_location('issue_runtime_finalizer', ROOT / 'scripts/e2b/cleanup-template-candidates.py')
    finalizer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(finalizer)
    report = {'driverRevision': os.environ['GITHUB_SHA'], 'driverRunId': os.environ.get('GITHUB_RUN_ID'),
              'applicationSha': source, 'mode': 'exact_failed_release_private_candidates', 'targets': []}
    for target in TARGETS:
        receipt = {key: target[key] for key in ['sourceCommit', 'runId', 'runAttempt']}
        receipt.update(sandboxes=[], templates=[], errors=[])
        try:
            subprocess.run(['git', 'merge-base', '--is-ancestor', target['sourceCommit'], source],
                           cwd=ROOT, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            path = '/actions/runs/' + target['runId']
            verify_failed_run(github(path, token), github(path + '/jobs?filter=latest&per_page=100', token), target)
            identity = {'GITHUB_REPOSITORY': REPOSITORY, 'GITHUB_SHA': target['sourceCommit'],
                        'GITHUB_RUN_ID': target['runId'], 'GITHUB_RUN_ATTEMPT': target['runAttempt']}
            metadata, candidates = finalizer.identities(identity, target_report(target))
            receipt['failedReleaseVerified'] = True
            try:
                receipt['sandboxes'] = finalizer.cleanup_sandboxes(metadata, api_key)
            except Exception as error:
                receipt['errors'].append({'phase': 'sandboxes', 'error': type(error).__name__})
            receipt['templates'] = finalizer.builder.cleanup_templates(candidates, api_key)
        except Exception as error:
            receipt['errors'].append({'phase': 'verification_or_templates', 'error': type(error).__name__})
        receipt['complete'] = (not receipt['errors'] and receipt.get('failedReleaseVerified') is True
            and len(receipt['templates']) == 3
            and all(row['status'] in ('deleted', 'absent') for row in receipt['templates'])
            and all(row['status'] == 'killed' for row in receipt['sandboxes']))
        report['targets'].append(receipt)
    report['status'] = 'passed' if all(row['complete'] for row in report['targets']) else 'failed'
    output = ROOT / 'issues-1515-1517-cleanup-report/runtime-candidates.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, separators=(',', ':')))
    return 0 if report['status'] == 'passed' else 1


class BoundaryTests(unittest.TestCase):
    def fixture(self):
        target = TARGETS[0]
        return target, {'id': int(target['runId']), 'run_attempt': 1, 'head_sha': target['sourceCommit'],
            'head_branch': 'main', 'event': 'push', 'path': '.github/workflows/e2b-official-runtime.yml',
            'repository': {'full_name': REPOSITORY}, 'status': 'completed', 'conclusion': 'failure'}, {
            'total_count': 3, 'jobs': [{'name': name, 'status': 'completed', 'conclusion': conclusion}
                for name, conclusion in [('subscriptions', 'failure'), ('cleanup', 'failure'), ('publish', 'skipped')]]}

    def test_only_reviewed_failed_source_and_attempt_are_accepted(self):
        target, run, jobs = self.fixture()
        verify_failed_run(run, jobs, target)
        for change in [{'id': 1}, {'run_attempt': 2}, {'head_sha': 'a' * 40}, {'head_branch': 'other'},
                       {'event': 'pull_request'}, {'status': 'in_progress'}, {'conclusion': 'success'},
                       {'repository': {'full_name': 'other/repository'}}, {'path': '.github/workflows/web-deploy.yml'}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                verify_failed_run({**run, **change}, jobs, target)

    def test_successful_or_incomplete_publication_is_never_reclaimed(self):
        target, run, jobs = self.fixture()
        for index in range(3):
            changed = json.loads(json.dumps(jobs))
            changed['jobs'][index]['conclusion'] = 'success'
            with self.assertRaises(ValueError):
                verify_failed_run(run, changed, target)
        with self.assertRaises(ValueError):
            verify_failed_run(run, {**jobs, 'total_count': 4}, target)

    def test_candidate_identity_contains_exact_reported_ids(self):
        for target in TARGETS:
            with self.subTest(source=target['sourceCommit']):
                report = target_report(target)
                self.assertEqual({key: row['templateId'] for key, row in report['templates'].items()}, target['templates'])
                for kind, row in report['templates'].items():
                    self.assertEqual(row['name'], f"mikka-{target['sourceCommit'][:12]}-{target['runId']}-{target['runAttempt']}-{kind}")
                with self.assertRaises(ValueError):
                    target_report({**target, 'sourceCommit': 'main'})


if __name__ == '__main__':
    if '--self-test' in sys.argv:
        unittest.main(argv=[sys.argv[0]])
    else:
        try:
            sys.exit(run())
        except Exception as error:
            print(json.dumps({'status': 'failed', 'phase': 'driver_preflight', 'error': type(error).__name__}))
            sys.exit(1)
