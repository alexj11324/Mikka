"""Replay three archived public-CA observations through the real policy matcher.

This never scans or accesses the observed /etc or /usr paths. It is not a
whole-filesystem conservation check, a CLI check, or a new provider control.
"""
import copy
import hashlib
import importlib.util
import json
import platform
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.dont_write_bytecode = True
BASE = Path('/workspace/scratch/263e36984c81')
OUT = Path(__file__).parent
EVIDENCE = BASE / 'Mikka-1505-ca-relinks/docs/operations/evidence/1782-official-claude-certificate-relinks-20261109.json'
OLD = BASE / 'claude-ca-relink-candidate-1505/original/scripts/e2b'
NEW = BASE / 'Mikka-1505-ca-relinks/scripts/e2b'
PATHS = ('/etc/ssl/certs/1560546e.0', '/etc/ssl/certs/e2b-ca.pem', '/usr/local/share/ca-certificates/e2b-ca.crt')
PHASES = ('before', 'pre_finalization', 'ready', 'fresh')
OLD_CA = '4e04ce0bc2dcacdcc12cbf8b5ea06d12efb0fbffd80c77a13e08660cf8255aa1'
OPS = '7fd8a2681cd71bb6603a485854c8beda2044911b'


def fingerprint(raw):
    return {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
            'gitBlob': hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()}


def utc(ns):
    seconds, nanos = divmod(ns, 1_000_000_000)
    return datetime.fromtimestamp(seconds, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S') + f'.{nanos:09d}Z'


def project(node):
    # Exact fields emitted by official-files.entry for a regular file or link.
    fields = ('path', 'kind', 'mode', 'uid', 'gid', 'sha256' if node['kind'] == 'file' else 'target')
    return {field: node[field] for field in fields}


raw = EVIDENCE.read_bytes()
assert len(raw) == 18164 and fingerprint(raw)['sha256'] == 'dc69062c8376cb2a10cf47b7455ff478f7872c709c31c128c1384ecfc7696632'
document = json.loads(raw)
control, summary = document['controls']['claude'], document['summary']
members = {}
for name, value in [('claude.json', control), ('summary.json', summary)]:
    encoded = (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()
    measured = fingerprint(encoded)
    declared = document['artifact']['files'][name]
    assert measured['bytes'] == declared['bytes'] and measured['sha256'] == declared['sha256']
    members[name] = measured

identity = {'application': 'mikka-1782-official-claude-control', 'opsCommit': OPS,
            'ref': 'refs/heads/ops/self-hosted-vault-closeout-20261108', 'repository': 'alexj11324/Mikka',
            'runAttempt': '1', 'runId': '42661569263',
            'sourceCommit': '623a1afd8715433a58c3e88ce88f8fbcc29d1761',
            'sourceTree': '193c7c1a101a56a889f7b22eb615e903981942af'}
assert control['identity'] == summary['identity'] == identity
assert document['source']['opsCommit'] == OPS and document['source']['opsTree'] == 'e7152cf5bd7b348f92904d9aa7ea87ec5e532a83'
assert document['source']['soleParent'] == '32d3afecbeb1f8d433f9a91c51f3980995207d30'
assert document['source']['runId'] == document['job']['run_id'] == 42661569263
assert document['runAttempt'] == document['source']['attempt'] == 1
assert document['jobId'] == document['job']['id'] == 129314204150
assert document['job']['status'] == 'completed' and document['jobConclusion'] == document['job']['conclusion'] == 'success'
assert document['source']['event'] == 'push' and document['source']['actor'] == 'alexj11324'
assert control['kind'] == document['template'] == 'claude'
assert control['name'] == 'mikka-1782-official-claude-control-42661569263-1-claude'
assert control['buildStarted'] is True and control['createStarted'] is True
assert control['probe'] == {'phase': 'complete', 'status': 'observed'}
assert summary['failure'] is None
for value in (document, control, summary):
    assert value['targetedOnly'] is True and value['releaseAccepted'] is False and value['policyChanged'] is False

observations = control['observations']
assert set(observations) == set(PHASES)
phase_summary, projections = [], {}
for phase in PHASES:
    observation = observations[phase]
    assert set(observation) == {'version', 'kind', 'phase', 'utcNs', 'monotonicNs', 'bootId', 'nodes', 'certificates'}
    assert observation['version'] == 1 and observation['kind'] == 'claude' and observation['phase'] == phase
    assert type(observation['utcNs']) is int and type(observation['monotonicNs']) is int
    assert re.fullmatch(r'[a-f0-9-]{36}', observation['bootId'])
    nodes = observation['nodes']
    assert len(nodes) == 3 and tuple(row['path'] for row in nodes) == PATHS
    by_path = {row['path']: row for row in nodes}
    for index, row in enumerate(nodes):
        assert row['status'] == 'present' and (row['mode'], row['uid'], row['gid']) == (511, 0, 0)
        expected_kind = 'link' if phase == 'fresh' and index < 2 else 'file'
        assert row['kind'] == expected_kind
        expected_fields = {'path', 'status', 'mode', 'uid', 'gid', 'device', 'inode', 'size', 'mtimeNs', 'ctimeNs', 'kind',
                           'sha256' if expected_kind == 'file' else 'target'}
        assert set(row) == expected_fields
        if expected_kind == 'file':
            assert re.fullmatch(r'[a-f0-9]{64}', row['sha256'])
            if index < 2:
                assert row['sha256'] == OLD_CA
        else:
            assert row['target'] == ('e2b-ca.pem', PATHS[2])[index]
    expected_refs = []
    for index, origin in enumerate(PATHS[:2]):
        chain = list(PATHS[index:]) if phase == 'fresh' else [origin]
        terminal = chain[-1]
        expected_refs.append({'path': origin, 'status': 'observed', 'chain': chain,
                              'terminalPath': terminal, 'terminalSha256': by_path[terminal]['sha256']})
    assert observation['certificates'] == expected_refs
    projections[phase] = [project(node) for node in nodes]
    phase_summary.append({'phase': phase, 'utc': utc(observation['utcNs']), 'utcNs': observation['utcNs'],
                          'monotonicNs': observation['monotonicNs'], 'bootId': observation['bootId'],
                          'nodeKinds': [node['kind'] for node in nodes], 'modeUidGid': [511, 0, 0],
                          'rootSha256': nodes[2]['sha256']})
assert projections['before'] == projections['pre_finalization'] == projections['ready']
assert observations['before']['bootId'] == observations['pre_finalization']['bootId']
assert observations['ready']['bootId'] == observations['fresh']['bootId']
assert observations['before']['bootId'] != observations['fresh']['bootId']

cleanup = control['cleanup']
assert cleanup == summary['cleanup']['claude'] and set(summary['cleanup']) == {'claude'}
assert cleanup['status'] == 'complete' and cleanup['errors'] == []
assert cleanup['sandbox'] == {'absenceConfirmedById': True, 'id': control['sandboxId']}
assert cleanup['templates'] == [{'kind': 'claude', 'name': control['name'], 'status': 'absent', 'templateId': control['templateId']}]
assert control['sandboxId'] == 'iui98zldpl4fxszi3c2nv' and control['templateId'] == 'ivedr9vpyweketvct677'
assert control['buildId'] == '4161f161-aadb-4bf0-a82f-e6970f981e87'

sources = {}
for label, directory in [('original', OLD), ('candidate', NEW)]:
    sources[label] = {name: fingerprint((directory / name).read_bytes())
                      for name in ('official-files.py', 'e2b-finalization-files.json', 'e2b-certificate-relinks.json')}
assert (OLD / 'official-files.py').read_bytes() == (NEW / 'official-files.py').read_bytes()
assert sources['candidate']['official-files.py']['sha256'] == '66911624af52df59ef715eb105af9a3025bacf12460105fadc7f87e4d2dd63b5'
assert sources['candidate']['e2b-certificate-relinks.json']['sha256'] == '16f3341cf64a4c7fd739a50439e558db4643f23fdd1ec16a51b062c30f037b52'
old_rows = json.loads((OLD / 'e2b-certificate-relinks.json').read_text())
new_rows = json.loads((NEW / 'e2b-certificate-relinks.json').read_text())
assert len(old_rows) == 320 and len(new_rows) == 322 and new_rows[:320] == old_rows
assert new_rows[320:] == [{'path': PATHS[index], 'sha256': OLD_CA,
                         'target': ('e2b-ca.pem', PATHS[2])[index], 'providerRoot': True, 'templates': ['claude']}
                        for index in range(2)]
old_policy = json.loads((OLD / 'e2b-finalization-files.json').read_text())
new_policy = json.loads((NEW / 'e2b-finalization-files.json').read_text())
normalized_policy = copy.deepcopy(new_policy)
added_control = normalized_policy['supplementalControls'].pop()
assert len(new_policy['supplementalControls']) == len(old_policy['supplementalControls']) + 1
normalized_policy['certificateRelinksSha256'] = old_policy['certificateRelinksSha256']
assert normalized_policy == old_policy
assert added_control['controlOpsCommit'] == OPS and added_control['controlRun'] == document['controlRun']
assert added_control['evidenceSha256'] == fingerprint(raw)['sha256'] and added_control['evidenceBytes'] == len(raw)
assert added_control['artifactZipSha256'] == document['artifact']['sha256']
assert added_control['artifactId'] == document['artifact']['artifactId'] and added_control['artifactZipBytes'] == document['artifact']['bytes']


def replay(label, directory):
    spec = importlib.util.spec_from_file_location('replayed_official_files_' + label, directory / 'official-files.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    rows = {row['path']: row for row in projections['fresh']}
    terminals = {row['path']: row['terminalPath'] for row in observations['fresh']['certificates']}
    resolved, reads, decisions = [], [], []

    class RecordedPath:
        def __init__(self, path):
            self.path = str(path)
        def __str__(self):
            return self.path
        def __eq__(self, other):
            return isinstance(other, RecordedPath) and self.path == other.path
        def resolve(self, strict=False):
            assert strict is True and self.path in terminals
            resolved.append(self.path)
            return RecordedPath(terminals[self.path])

    def recorded_entry(path):
        path = str(path)
        assert path in rows
        reads.append(path)
        return copy.deepcopy(rows[path])

    real_matcher = module.permitted_provider_change
    def observed_matcher(change, rules):
        accepted = real_matcher(change, rules)
        decisions.append({'path': change['path'], 'accepted': accepted, 'change': copy.deepcopy(change)})
        return accepted

    # Only metadata access is substituted. verify, finalization_policy,
    # permitted_provider_change and receipt are the actual unmodified source.
    module.Path, module.entry = RecordedPath, recorded_entry
    module.permitted_provider_change = observed_matcher
    result = {'inputPaths': list(PATHS), 'beforePhase': 'before', 'afterPhase': 'fresh'}
    try:
        proof = module.verify({'version': 1, 'entries': copy.deepcopy(projections['before'])}, e2b_finalization='claude')
    except RuntimeError as error:
        prefix = 'official_files_changed '
        assert str(error).startswith(prefix)
        result.update(accepted=False, errorCode='official_files_changed', refusedPaths=[row['path'] for row in json.loads(str(error)[len(prefix):])])
    else:
        assert proof['before'] == proof['after'] and proof['originalBefore']['entries'] == proof['originalAfter']['entries'] == 3
        result.update(accepted=True, refusedPaths=[], metadataOnlyFinalization=proof)
    result.update(realMatcherDecisions=decisions, recordedEntryLookups=reads, recordedResolutionLookups=resolved,
                  filesystemScanning=False, protectedPathFilesystemAccess=False)
    return result


red = replay('original', OLD)
green = replay('candidate', NEW)
assert red['accepted'] is False and red['refusedPaths'] == list(PATHS[:2])
assert [row['accepted'] for row in red['realMatcherDecisions']] == [False, False, True]
assert green['accepted'] is True and [row['accepted'] for row in green['realMatcherDecisions']] == [True, True, True]
assert green['recordedResolutionLookups'] == list(PATHS[:2])
assert green['metadataOnlyFinalization']['policySha256'] == sources['candidate']['e2b-finalization-files.json']['sha256']
for label, directory in [('original', OLD), ('candidate', NEW)]:
    for name, before_fingerprint in sources[label].items():
        assert fingerprint((directory / name).read_bytes()) == before_fingerprint
assert fingerprint(EVIDENCE.read_bytes()) == fingerprint(raw)

result = {'version': 1, 'result': 'original_rejects_candidate_accepts',
          'scope': 'read-only replay of three archived CA paths; not whole-filesystem conservation or a new control',
          'evidence': {'path': str(EVIDENCE), 'immutableCommit': 'f845bd90fee2b34a53677d868c45b906a46375ef',
                       **fingerprint(raw), 'reconstructedMembers': members, 'zipReadDuringReplay': False},
          'identity': identity, 'sourceFiles': sources,
          'conservation': {'matcherBytesUnchanged': True, 'originalCertificateRowsPreserved': 320,
                           'appendedClaudeRows': 2, 'otherFinalizationFieldsPreserved': True,
                           'supplementalControlAppendOnly': True, 'aliasModeOverrideAdded': False},
          'phases': phase_summary, 'firstThreeEntryProjectionsEqual': True,
          'freshCertificateChains': observations['fresh']['certificates'],
          'cleanup': {'ledgerAndSummaryExactlyEqual': True, 'archivedReceipt': cleanup,
                      'privateDerivativeBuildId': control['buildId'], 'providerApiQueriedDuringReplay': False},
          'original': red, 'candidate': green,
          'unknown': ['official base immutable template ID', 'official base build ID', 'envd version'],
          'execution': {'command': 'python -B replay.py', 'executable': sys.executable, 'cwd': str(OUT), 'python': platform.python_version(),
                        'replayScript': fingerprint(Path(__file__).read_bytes()), 'tests34Rerun': False,
                        'productFilesModified': False, 'resourcesCreated': False, 'gitOrArchiveMutation': False}}
(OUT / 'receipt.json').write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')
print(json.dumps({'result': result['result'], 'paths': 3, 'originalRejected': red['refusedPaths'],
                  'candidateAccepted': True, 'cleanup': 'both archived receipts exact and complete',
                  'receipt': str(OUT / 'receipt.json')}, sort_keys=True))
