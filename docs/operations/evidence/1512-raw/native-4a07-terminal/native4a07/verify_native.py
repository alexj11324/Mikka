#!/usr/bin/env python3
"""Independently reconcile unmodified Native artifacts; no requests or edits."""
import argparse
import hashlib
import json
import pathlib
import statistics
from datetime import datetime, timezone


parser = argparse.ArgumentParser()
parser.add_argument("native", type=pathlib.Path)
parser.add_argument("package", type=pathlib.Path)
parser.add_argument("--revision", required=True)
parser.add_argument("--labels", type=pathlib.Path, required=True)
args = parser.parse_args()


def read(directory, path):
    return json.loads((directory / path).read_text())


def integer(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def iso(value):
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


labels = json.loads(args.labels.read_text())
life = read(args.native, "lifecycle.json")
smoke = read(args.native, "smoke.json")
parity = read(args.native, "parity/parity.json")
crypto = read(args.package, "native-crypto.json")
package = read(args.package, "mac-acceptance-package.json")
for actual in [life["revision"], smoke["revision"], parity["appRevision"], parity["harnessRevision"],
               crypto["revision"], life["queryCounts"]["source"]["revision"],
               *[value["revision"] for value in life["renderers"].values()]]:
    assert actual == args.revision, ("source mismatch", actual)
assert life["result"] == smoke["result"] == parity["result"] == "passed"
assert len(life["checks"]) == 8 and all(row["result"] == "passed" for row in life["checks"])
assert len(smoke["checks"]) == 10 and all(row["result"] == "passed" for row in smoke["checks"])
assert len(parity["screens"]) == len(parity["requiredScreens"]) * len(parity["themes"])
assert all(row["passed"] is True for row in parity["screens"])
assert parity["pageErrors"] == []

expected_phases = {
    "nativeLogin": ["common-email-authentication", "native-pkce-and-automatic-renderer-to-public-session", "workspace-selection-to-usable"],
    "webLogin": ["common-email-authentication", "web-navigation-to-dom-content-loaded", "workspace-selection-to-usable"],
    "startup-bundled": ["launch-to-usable"], "startup-hosted": ["launch-to-usable"],
}
counts = life["queryCounts"]
windows = counts["windows"]
assert set(windows) == set(expected_phases)
assert counts["login"]["comparable"] is True
fields = ["queryCalls", "pgProtocolReceiveBytes", "pgProtocolSendBytes", "closedConnections", "unknownReadings"]
snapshots = []
checks = {"snapshots": 0, "segments": 0, "totals": 0, "bucketConservation": 0}


def buckets(value):
    operations, sources = value["queryOperations"], value["unattributedSources"]
    assert set(operations) == set(labels["operations"]) and len(operations) == 17
    assert set(sources) == set(labels["sources"]) and len(sources) == 78
    assert all(integer(n) for n in [*operations.values(), *sources.values()])
    assert sum(operations.values()) == value["queryCalls"]
    assert sum(sources.values()) == operations["unattributed"]
    checks["bucketConservation"] += 1


def compare_delta(actual, before, after):
    assert before["pid"] == after["pid"]
    assert before["startedAt"] == after["startedAt"]
    assert before["runtime"] == after["runtime"]
    assert after["endedAt"] >= before["endedAt"]
    assert actual["startedAt"] == iso(before["endedAt"])
    assert actual["finishedAt"] == iso(after["endedAt"])
    assert actual["durationMs"] == after["endedAt"] - before["endedAt"]
    for field in fields:
        assert integer(actual[field]) and actual[field] == after[field] - before[field], field
    assert actual["unknownReadings"] == 0
    for key in ["queryOperations", "unattributedSources"]:
        assert actual[key] == {name: after[key][name] - before[key][name] for name in before[key]}
    buckets(actual)


sql = {}
for name, phases in expected_phases.items():
    window = windows[name]
    assert window["status"] == "complete"
    if name.startswith("startup-"):
        assert window["pair"] == 1
    points = window["checkpoints"]
    assert [item["phase"] for item in points] == ["before", *phases]
    assert [item["phase"] for item in window["segments"]] == phases
    for point in points:
        snapshot = point["snapshot"]
        assert all(integer(snapshot[field]) for field in fields)
        assert snapshot["unknownReadings"] == 0
        buckets(snapshot)
        snapshots.append(snapshot)
        checks["snapshots"] += 1
    for index, segment in enumerate(window["segments"]):
        compare_delta(segment, points[index]["snapshot"], points[index + 1]["snapshot"])
        checks["segments"] += 1
    total = window["total"]
    compare_delta(total, points[0]["snapshot"], points[-1]["snapshot"])
    checks["totals"] += 1
    assert all(sum(segment[field] for segment in window["segments"]) == total[field] for field in fields)
    for field in ["queryOperations", "unattributedSources"]:
        assert all(sum(segment[field][key] for segment in window["segments"]) == value for key, value in total[field].items())
    sql[name] = {"total": total["queryCalls"], "segments": [segment["queryCalls"] for segment in window["segments"]],
                 "otherScopedDelta": total["unattributedSources"]["otherScoped"], "noScopeDelta": total["unattributedSources"]["noScope"],
                 "startedAt": total["startedAt"], "finishedAt": total["finishedAt"]}
assert checks == {"snapshots": 12, "segments": 8, "totals": 4, "bucketConservation": 24}
ordered = sorted(snapshots, key=lambda value: value["endedAt"])
assert len({(value["pid"], value["startedAt"], value["runtime"]) for value in ordered}) == 1
for before, after in zip(ordered, ordered[1:]):
    assert all(after[field] >= before[field] for field in fields)
    for field in ["queryOperations", "unattributedSources"]:
        assert all(after[field][key] >= before[field][key] for key in before[field])

rpc = counts["rpcActions"]
rpc_summary = {}
for kind, report in [("physical", rpc), ("logical", rpc["logical"])]:
    assert report["status"] == "complete" and report["reasons"] == []
    assert report["duplicateRecords"] == report["conflictingInvocations"] == 0
    rpc_summary[kind] = {}
    for name, phases in expected_phases.items():
        window = report["windows"][name]
        assert window["status"] == window["segmentStatus"] == "complete"
        assert window["startedAt"] == windows[name]["total"]["startedAt"]
        assert window["finishedAt"] == windows[name]["total"]["finishedAt"]
        assert [segment["phase"] for segment in window["segments"]] == phases
        metrics = ["startedInWindow", "completedInWindow", "crossesStart", "crossesEnd", "completionNotObserved", "completionWithoutStart"]
        for index, segment in enumerate(window["segments"]):
            for edge in ["startedAt", "finishedAt"]:
                assert segment[edge] == windows[name]["segments"][index][edge]
        for group in [window, *window["segments"]]:
            for row in group["actions"]:
                assert all(integer(row[key]) for key in metrics)
                assert all(integer(status["count"]) and 100 <= status["status"] <= 599 for status in row["statusCounts"])
                # Closed, paired reports must reconcile arrivals/departures, but
                # boundary crossings remain visible and are never required zero.
                assert row["completionNotObserved"] == row["completionWithoutStart"] == 0
                assert row["startedInWindow"] + row["crossesStart"] == row["completedInWindow"] + row["crossesEnd"]
                assert sum(status["count"] for status in row["statusCounts"]) == row["completedInWindow"] + row["crossesEnd"]
        for metric in ["startedInWindow", "completedInWindow"]:
            assert sum(row[metric] for row in window["actions"]) == sum(row[metric] for segment in window["segments"] for row in segment["actions"])
            whole = {(row["route"], row["rpcAction"]): row[metric] for row in window["actions"]}
            parts = {}
            for segment in window["segments"]:
                for row in segment["actions"]:
                    key = (row["route"], row["rpcAction"])
                    parts[key] = parts.get(key, 0) + row[metric]
            assert all(whole.get(key, 0) == parts.get(key, 0) for key in set(whole) | set(parts))
        rpc_summary[kind][name] = {key: sum(row[key] for row in window["actions"]) for key in metrics}
        rpc_summary[kind][name]["nullActionRows"] = [row for row in window["actions"] if row["rpcAction"] is None]
        rpc_summary[kind][name]["non200Rows"] = [row for row in window["actions"] if any(status["status"] != 200 for status in row["statusCounts"])]

for report in [life, smoke]:
    assert all(row["result"] == "passed" for row in report["cleanupStages"])
    assert report["nativeCleanup"]["cleaned"] is True
    released = report["accountObservation"]
    assert released["observed"] is True and released["state"] == "released"
    for owner in ["owner", "peer"]:
        assert isinstance(released[owner]["matchesSealedBaselineBefore"], bool)
        assert released[owner]["matchesSealedBaselineAfter"] is True
assert parity["cleanup"] == "passed" and parity["nativeCleanup"]["cleaned"] is True
for report in [life, smoke, parity]:
    assert report["workspaceNameCleanup"]["ownerMatchesSealedBaseline"] is True
    assert report["workspaceNameCleanup"]["peerMatchesSealedBaseline"] is True
assert crypto["passed"] is True and crypto["sameImmutablePackage"] is True and crypto["distinctProcesses"] == 3
assert len(crypto["launches"]) == 3 and all(launch["passed"] and launch["crypto"]["passed"] and launch["processExited"] for launch in crypto["launches"])
assert crypto["cleanup"] == "passed" and package["passed"] is True and package["signatureVerifiedStrictDeep"] is True
assert crypto["package"] == package

pairs = life["coldStart"]["pairs"]
assert pairs >= 5 and len(life["samples"]) == pairs * 2
for pair in range(1, pairs + 1):
    samples = [sample for sample in life["samples"] if sample["pair"] == pair]
    assert [sample["mode"] for sample in samples] == (["bundled", "hosted"] if pair % 2 else ["hosted", "bundled"])
    assert [sample["order"] for sample in samples] == [1, 2]
medians = {mode: statistics.median(sample["milliseconds"] for sample in life["samples"] if sample["mode"] == mode) for mode in ["bundled", "hosted"]}
assert medians["bundled"] == life["coldStart"]["bundledMedianMs"]
assert medians["hosted"] == life["coldStart"]["hostedMedianMs"]

print(json.dumps({"version": 1, "revision": args.revision, "independentReconciliation": "passed", "counts": checks,
                  "counter": {"pid": ordered[0]["pid"], "startedAt": ordered[0]["startedAt"], "runtime": ordered[0]["runtime"]},
                  "sql": sql, "budget": {"login": sql["nativeLogin"]["total"] <= sql["webLogin"]["total"],
                                           "startup": sql["startup-bundled"]["total"] <= sql["startup-hosted"]["total"]},
                  "rpc": rpc_summary, "coldStart": {"pairs": pairs, "mediansMs": medians},
                  "checks": {"lifecycle": len(life["checks"]), "smoke": len(smoke["checks"]), "parity": len(parity["screens"])},
                  "cleanup": {"lifecycleStages": len(life["cleanupStages"]), "smokeStages": len(smoke["cleanupStages"]), "parity": parity["cleanup"], "accountLeasesReleased": True},
                  "accountBaselinesBeforeRelease": {name: {owner: report["accountObservation"][owner]["matchesSealedBaselineBefore"] for owner in ["owner", "peer"]}
                                                    for name, report in [("lifecycle", life), ("smoke", smoke)]},
                  "sourceFileHashes": {str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest()
                                       for directory in [args.native, args.package] for path in sorted(directory.rglob("*.json"))},
                  "note": "A true SQL budget result is only the unmodified relative criterion for this source/workload; it is not proof of improved performance or completed production acceptance."}, indent=2))
