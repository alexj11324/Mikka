import importlib.util
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

spec = importlib.util.spec_from_file_location("native_history", Path(__file__).parent / "runtime/native-history.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with TemporaryDirectory() as tmp:
    root = Path(tmp)
    run = str(uuid4())
    history = root / "old" / run / "codex-home" / "sessions"
    history.mkdir(parents=True)
    valid = "rollout-fixture-" + str(uuid4()) + ".jsonl"
    (history / valid).write_text("native content")
    (history.parent / "auth.json").write_text("private fixture")
    (history / "auth.jsonl").write_text("not native history")
    (history / "rollout-symlink.jsonl").symlink_to(history.parent / "auth.json")
    os.link(history.parent / "auth.json", history / "rollout-hardlink.jsonl")
    folder = root / "old" / run / "native-home/.claude/projects/example"
    folder.mkdir(parents=True)
    transcript = str(uuid4()) + ".jsonl"
    (folder / transcript).write_text("native Claude history")
    module.transfer(root / "old", root / "saved")
    module.transfer(root / "saved", root / "new")
    files = sorted(p for p in (root / "new").rglob("*") if p.is_file())
    assert [f.name for f in files] == [valid, transcript]
    assert [f.read_text() for f in files] == ["native content", "native Claude history"]
print("Restored scoped Codex and Claude conversation files without CLI credentials or links")
