#!/usr/bin/env python3
"""Prepared-only unless --reviewed-run. Real binaries, owned loopback PG17 only.

This probe does not create a container, migrate, seed, invoke Go, contact a secret
store, or register a provider. The reviewed runner must prepare the two exact
binaries and one new labeled PostgreSQL container with tracked migrations.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import struct
import subprocess
import threading
import time

PG_IMAGE = "postgres:17-alpine@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb"
PG_DATABASE = "mikka_cpa_e2e"
PG_USER = "mikka_test"
PG_PASSWORD = "startup-wire-fixture-only"
MAX_FRAME = 1 << 20


def require(ok, code):
    if not ok:
        raise RuntimeError(code)


def file_sha(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for part in iter(lambda: stream.read(1 << 20), b""):
            h.update(part)
    return h.hexdigest()


def exact(sock, length):
    data = bytearray()
    while len(data) < length:
        part = sock.recv(length - len(data))
        if not part:
            raise EOFError()
        data.extend(part)
    return bytes(data)


def frame(sock):
    tag = exact(sock, 1)
    size = struct.unpack("!I", exact(sock, 4))[0]
    require(4 <= size <= MAX_FRAME, "pg_frame_invalid")
    payload = exact(sock, size - 4)
    return tag, payload, tag + struct.pack("!I", size) + payload


def close_socket(sock):
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    sock.close()


class WireProxy:
    def __init__(self, upstream_port, mode):
        self.port = upstream_port
        self.mode = mode
        self.stopped = threading.Event()
        self.startup_seen = threading.Event()
        self.lock = threading.Lock()
        self.connections = []
        self.sockets = []
        self.threads = []
        self.accept_thread = None
        self.injection_used = False
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(4)
        self.address = self.listener.getsockname()[1]
        self.accept_thread = threading.Thread(target=self.accept, daemon=True)
        self.accept_thread.start()

    def accept(self):
        while not self.stopped.is_set():
            try:
                downstream, _ = self.listener.accept()
            except OSError:
                return
            with self.lock:
                self.sockets.append(downstream)
                row = {"id": len(self.connections) + 1, "startup": False,
                       "authenticationOk": False, "ready": False,
                       "pingObserved": 0, "pingForwarded": 0,
                       "businessSqlSha256": [], "sqlParseFrames": 0,
                       "executeFrames": 0, "backendErrorFrames": 0,
                       "injectedAfterReady": False, "closed": False,
                       "proxyError": None}
                self.connections.append(row)
            thread = threading.Thread(target=self.connection, args=(downstream, row), daemon=True)
            self.threads.append(thread)
            thread.start()

    def connection(self, downstream, row):
        upstream = None
        relay = None
        downstream.settimeout(15)
        try:
            size = struct.unpack("!I", exact(downstream, 4))[0]
            require(8 <= size <= 65536, "startup_length_invalid")
            payload = exact(downstream, size - 4)
            require(struct.unpack("!I", payload[:4])[0] == 196608, "only_plain_loopback_pg_startup_allowed")
            row["startup"] = True
            self.startup_seen.set()
            if self.mode == "stall_startup":
                self.stopped.wait(15)
                return
            upstream = socket.create_connection(("127.0.0.1", self.port), timeout=5)
            upstream.settimeout(15)
            with self.lock:
                self.sockets.append(upstream)
            upstream.sendall(struct.pack("!I", size) + payload)

            def server_to_client():
                try:
                    while not self.stopped.is_set():
                        tag, body, raw = frame(upstream)
                        if tag == b"R" and body[:4] == b"\x00\x00\x00\x00":
                            row["authenticationOk"] = True
                        if tag == b"Z":
                            require(row["authenticationOk"], "ready_without_authentication")
                            row["ready"] = True
                        if tag == b"E":
                            row["backendErrorFrames"] += 1
                        downstream.sendall(raw)
                except (EOFError, OSError):
                    pass
                except RuntimeError as error:
                    row["proxyError"] = str(error)
                finally:
                    close_socket(downstream)

            relay = threading.Thread(target=server_to_client, daemon=True)
            self.threads.append(relay)
            relay.start()
            while not self.stopped.is_set():
                tag, body, raw = frame(downstream)
                sql = None
                if tag == b"Q":
                    require(body.endswith(b"\0"), "simple_query_invalid")
                    sql = body[:-1]
                elif tag == b"P":
                    pieces = body.split(b"\0", 2)
                    require(len(pieces) == 3, "parse_query_invalid")
                    sql = pieces[1]
                    row["sqlParseFrames"] += 1
                elif tag == b"E":
                    row["executeFrames"] += 1
                if sql is not None:
                    require(row["ready"], "query_before_authenticated_ready")
                    if sql.strip() == b"-- ping":
                        row["pingObserved"] += 1
                        with self.lock:
                            inject = self.mode == "disconnect_first_ping" and not self.injection_used
                            if inject:
                                self.injection_used = True
                        if inject:
                            row["injectedAfterReady"] = True
                            return  # Drop this one post-handshake Ping, not a SQL/body rewrite.
                        row["pingForwarded"] += 1
                    else:
                        row["businessSqlSha256"].append(hashlib.sha256(sql).hexdigest())
                upstream.sendall(raw)
        except (EOFError, OSError):
            pass
        except RuntimeError as error:
            row["proxyError"] = str(error)
        finally:
            close_socket(downstream)
            if upstream is not None:
                close_socket(upstream)
            row["closed"] = True

    def close(self):
        self.stopped.set()
        close_socket(self.listener)
        with self.lock:
            sockets = list(self.sockets)
        for sock in sockets:
            close_socket(sock)
        self.accept_thread.join(2)
        for thread in list(self.threads):
            thread.join(2)
        require(not self.accept_thread.is_alive() and not any(t.is_alive() for t in self.threads), "proxy_cleanup_incomplete")
        require(all(r["closed"] for r in self.connections), "connection_cleanup_incomplete")


class NoSecretTraffic:
    """A local tripwire only; production provider executors are never registered."""
    def __init__(self):
        self.count = 0
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(2)
        self.port = self.listener.getsockname()[1]
        self.thread = threading.Thread(target=self.accept, daemon=True)
        self.thread.start()

    def accept(self):
        while True:
            try:
                client, _ = self.listener.accept()
            except OSError:
                return
            self.count += 1
            close_socket(client)

    def close(self):
        close_socket(self.listener)
        self.thread.join(2)
        require(not self.thread.is_alive(), "secret_tripwire_cleanup_incomplete")


def owned_postgres_port(name, candidate):
    require(re.fullmatch(r"mikka-startup-ping-proof-[a-z0-9-]{1,64}", name) is not None, "owned_container_name_invalid")
    data = subprocess.run(["docker", "inspect", name], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          timeout=10, check=False)
    require(data.returncode == 0, "owned_container_not_available")
    items = json.loads(data.stdout)
    require(len(items) == 1, "owned_container_count_invalid")
    item = items[0]
    require(item["Name"] == "/" + name and item["State"]["Running"], "owned_container_state_invalid")
    require(item["Config"]["Image"] == PG_IMAGE, "owned_container_image_invalid")
    labels = item["Config"].get("Labels") or {}
    require(labels.get("mikka.startup-ping-proof") == candidate, "owned_container_label_invalid")
    variables = dict(part.split("=", 1) for part in item["Config"].get("Env", []) if "=" in part)
    require(variables.get("POSTGRES_DB") == PG_DATABASE and variables.get("POSTGRES_USER") == PG_USER
            and variables.get("POSTGRES_PASSWORD") == PG_PASSWORD, "owned_container_fixture_identity_invalid")
    ports = item["NetworkSettings"]["Ports"].get("5432/tcp") or []
    require(len(ports) == 1 and ports[0]["HostIp"] == "127.0.0.1", "owned_container_port_not_loopback")
    return int(ports[0]["HostPort"])


def config(port, secret_port, operation):
    value = {"scope": {"ownerId": "startup-wire-synthetic-owner",
                        "workspaceId": "00000000-0000-4000-8000-000000000031",
                        "connectionId": "00000000-0000-4000-8000-000000000032", "provider": "codex"},
             "use": {"bindingId": "00000000-0000-4000-8000-000000000033",
                     "consumerId": "00000000-0000-4000-8000-000000000034"},
             "databaseUrl": f"postgresql://{PG_USER}:{PG_PASSWORD}@127.0.0.1:{port}/{PG_DATABASE}?sslmode=disable"}
    if operation == "executeStream":
        value["executionOnly"] = True
    else:
        value.update(infisicalOrigin=f"https://127.0.0.1:{secret_port}", project="startup-wire-fixture",
                     environment="test", path="/synthetic-startup-proof", workloadToken="synthetic-not-a-token")
    return value


def one_case(binary, variant, operation, mode, pg_port, deadline):
    proxy, tripwire, child = None, None, None
    result = {"variant": variant, "operation": operation, "mode": mode,
              "providerRegistered": False, "childLaunched": False, "cleanup": {}}
    try:
        require(time.monotonic() < deadline, "proof_total_deadline")
        proxy = WireProxy(pg_port, mode)
        tripwire = NoSecretTraffic()
        settings = config(proxy.address, tripwire.port, operation)
        request = {"id": "startup-proof", "method": operation, "revision": 1}
        if operation == "executeStream":
            request.update(model="gpt-6-luna", payload={"messages": []})
        payload = (json.dumps(settings) + "\n" + json.dumps(request) + "\n").encode()
        started = time.monotonic()
        child = subprocess.Popen([str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
        result["childLaunched"] = True
        if mode == "stall_startup":
            child.stdin.write(payload)
            child.stdin.flush()
            require(proxy.startup_seen.wait(5), "startup_not_observed_before_cancel")
            child.terminate()  # Same SIGTERM boundary as the existing parent during initialization.
            output, diagnostics = child.communicate(timeout=5)
        else:
            output, diagnostics = child.communicate(input=payload, timeout=min(15, max(1, deadline-time.monotonic())))
        result.update(exitCode=child.returncode, durationMs=round((time.monotonic()-started)*1000, 3),
                      stdoutBytes=len(output), stderrBytes=len(diagnostics),
                      stdoutSha256=hashlib.sha256(output).hexdigest(), stderrSha256=hashlib.sha256(diagnostics).hexdigest(),
                      startupFailureStderr=diagnostics == b"subscription_worker_unavailable\n")
        messages = [json.loads(line) for line in output.splitlines()]
        result["rpcErrors"] = [message.get("error") if message.get("error") in ("account_unavailable",) else "unexpected" for message in messages]
        require(not any(s.encode() in output+diagnostics for s in (PG_PASSWORD, "synthetic-not-a-token")), "fixture_material_in_process_output")
        result["unexpectedStdout"] = any(message != {"id": "startup-proof", "error": "account_unavailable"} for message in messages)
    except Exception as error:
        result["failure"] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
    finally:
        result["cleanup"]["errors"] = []
        if child is not None and child.poll() is None:
            try:
                child.kill()
                child.communicate(timeout=5)
                result["cleanup"]["forcedKill"] = True
            except Exception as error:
                result["cleanup"]["errors"].append(type(error).__name__)
        result["cleanup"]["childReaped"] = child is None or child.poll() is not None
        if proxy is not None:
            try:
                proxy.close()
                result["cleanup"]["proxyClosed"] = True
            except Exception as error:
                result["cleanup"]["errors"].append(str(error) if isinstance(error, RuntimeError) else type(error).__name__)
            result["connections"] = proxy.connections
        if tripwire is not None:
            try:
                tripwire.close()
                result["cleanup"]["secretTripwireClosed"] = True
            except Exception as error:
                result["cleanup"]["errors"].append(str(error) if isinstance(error, RuntimeError) else type(error).__name__)
            result["secretEndpointConnections"] = tripwire.count
    return result


def assert_case(result):
    require("failure" not in result, "binary_case_did_not_complete")
    require(not result["cleanup"]["errors"] and all(result["cleanup"].get(k) for k in ("childReaped", "proxyClosed", "secretTripwireClosed")), "case_cleanup_incomplete")
    rows = result["connections"]
    require(result["secretEndpointConnections"] == 0, "unexpected_secret_store_connection")
    require(not result["unexpectedStdout"], "unexpected_rpc_output")
    require(all(r["proxyError"] is None and r["backendErrorFrames"] == 0 for r in rows), "pg_protocol_or_schema_error")
    require(not result["cleanup"].get("forcedKill"), "forced_cleanup_is_not_success")
    pings = sum(r["pingObserved"] for r in rows)
    queries = [sql for r in rows for sql in r["businessSqlSha256"]]
    result.update(connectionCount=len(rows), pingObserved=pings, businessStatementCount=len(queries))
    baseline = result["variant"] == "baseline"
    if result["mode"] == "normal":
        require(result["exitCode"] == 0 and result["rpcErrors"] == ["account_unavailable"] and result["stderrBytes"] == 0, "normal_authorization_refusal_changed")
        require(len(rows) == 1 and rows[0]["authenticationOk"] and rows[0]["ready"], "normal_connection_not_reused")
        require(pings == (2 if baseline else 1), "normal_explicit_or_reset_ping_count_changed")
        require(len(queries) == 1 and rows[0]["executeFrames"] == 1, "normal_authority_query_count_changed")
    elif result["mode"] == "disconnect_first_ping":
        require(pings == 1 and sum(r["injectedAfterReady"] for r in rows) == 1, "post_handshake_fault_not_covered")
        if baseline:
            require(result["exitCode"] == 1 and not result["rpcErrors"] and result["startupFailureStderr"] and len(rows) == 1 and not queries, "baseline_startup_failure_contract_changed")
        else:
            require(result["exitCode"] == 0 and result["rpcErrors"] == ["account_unavailable"] and result["stderrBytes"] == 0 and len(rows) == 2 and len(queries) == 1, "candidate_reset_reconnect_contract_changed")
    else:
        require(result["exitCode"] == -signal.SIGTERM and not result["rpcErrors"] and result["stderrBytes"] == 0, "startup_sigterm_contract_changed")
        require(len(rows) == 1 and rows[0]["startup"] and not rows[0]["ready"] and pings == 0 and not queries, "startup_cancel_after_wrong_boundary")
    result["assertionsPassed"] = True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reviewed-run", action="store_true")
    parser.add_argument("--baseline-binary", type=Path)
    parser.add_argument("--candidate-binary", type=Path)
    parser.add_argument("--baseline-sha256")
    parser.add_argument("--candidate-sha256")
    parser.add_argument("--candidate-commit")
    parser.add_argument("--pg-container")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not args.reviewed_run:
        print(json.dumps({"enabled": False, "requires": "reviewed exact binaries and owned migrated loopback PostgreSQL17", "cases": 10, "models": 0}))
        return
    require(args.output is not None and not os.path.lexists(args.output), "new_evidence_directory_required")
    require(re.fullmatch(r"[a-f0-9]{40}", args.candidate_commit or "") is not None, "candidate_commit_invalid")
    for path, expected in ((args.baseline_binary, args.baseline_sha256), (args.candidate_binary, args.candidate_sha256)):
        require(path is not None and path.is_absolute() and path.is_file() and not path.is_symlink() and os.access(path, os.X_OK), "binary_path_invalid")
        require(re.fullmatch(r"[a-f0-9]{64}", expected or "") is not None and file_sha(path) == expected, "binary_hash_mismatch")
    require(args.baseline_sha256 != args.candidate_sha256, "two_distinct_binaries_required")
    pg_port = owned_postgres_port(args.pg_container or "", args.candidate_commit)
    os.umask(0o077)
    args.output.mkdir(mode=0o700)
    report = {"baselineSource": "b268fbdb953c70a5e0dfee2f0013bf3a81b6dfac", "candidateSource": args.candidate_commit,
              "baselineBinarySha256": args.baseline_sha256, "candidateBinarySha256": args.candidate_sha256,
              "cases": [], "passed": False, "models": 0, "realPostgresWire": True,
              "noAuthorizationOrCredentialCache": True, "containerLifecycleOwnedByRunner": True}
    deadline = time.monotonic() + 150
    try:
        for mode in ("normal", "disconnect_first_ping", "stall_startup"):
            operations = ("prepare",) if mode == "stall_startup" else ("prepare", "executeStream")
            for operation in operations:
                for variant, binary in (("baseline", args.baseline_binary), ("candidate", args.candidate_binary)):
                    result = one_case(binary, variant, operation, mode, pg_port, deadline)
                    report["cases"].append(result)
                    assert_case(result)
        normal = [r for r in report["cases"] if r["mode"] == "normal"]
        for operation in ("prepare", "executeStream"):
            pair = [r for r in normal if r["operation"] == operation]
            require(pair[0]["connections"][0]["businessSqlSha256"] == pair[1]["connections"][0]["businessSqlSha256"], "authority_sql_bytes_changed")
        require(len(report["cases"]) == 10, "case_count_incomplete")
        report["passed"] = True
    except Exception as error:
        report["failure"] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        raise
    finally:
        (args.output / "pg-wire-report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"passed": report["passed"], "observedCases": len(report["cases"]), "models": 0}))


if __name__ == "__main__":
    main()
