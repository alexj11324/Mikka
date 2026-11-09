#!/usr/bin/env python3
"""Download only the fixed public upstream model catalogue; binary already verified by root."""
import hashlib, json, pathlib, sys, time, urllib.request
assert len(sys.argv) == 2, "usage: python3 prepare-model.py ABS_OUTPUT_FILE"
target = pathlib.Path(sys.argv[1]).resolve()
url = "https://raw.githubusercontent.com/openai/codex/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/models-manager/models.json"
expected_blob = "489ebe3f2483348641a16160ce8491dd077eabca"
if target.exists():
    data = target.read_bytes()
else:
    deadline = time.monotonic() + 35
    parts = []
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mikka-offline-fixture/1"}), timeout=15) as response:
        assert response.status == 200
        while True:
            chunk = response.read(65536)
            if not chunk:
                break
            parts.append(chunk)
            assert sum(map(len, parts)) <= 4 * 1024 * 1024, "catalogue byte bound"
            assert time.monotonic() < deadline, "catalogue download deadline"
    data = b"".join(parts)
actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
assert actual == expected_blob, (actual, expected_blob)
assert any(m.get("slug") == "gpt-6-luna" for m in json.loads(data)["models"])
if not target.exists():
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("xb") as stream:
        stream.write(data)
    target.chmod(0o600)
print(json.dumps({"source": url, "path": str(target), "bytes": len(data), "gitBlob": actual,
                  "sha256": hashlib.sha256(data).hexdigest(), "modified": False}))
