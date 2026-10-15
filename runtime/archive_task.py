"""Move a task note and its GUI metadata together, with a recoverable journal."""
import argparse
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from storage import atomic_write, canonical_json, digest, memory_lock, workspace_path

TASKS = ".ai-os/memory/tasks/"
ARCHIVE = ".ai-os/memory/archived_tasks/"
JOURNAL = ".ai-os/memory/runtime/task-archive.json"


def finish(root, transaction):
    for entry in transaction["files"]:
        source = workspace_path(root, entry["source"])
        target = workspace_path(root, entry["target"])
        old, new = entry["old"].encode("utf-8"), entry["new"].encode("utf-8")
        if source.exists() and source.read_bytes() != old and not (source == target and source.read_bytes() == new):
            raise ValueError("Archive source changed; inspect the journal before recovery")
        if target.exists() and target.read_bytes() != new and not (source == target and target.read_bytes() == old):
            raise ValueError("Archive destination exists with different content; nothing replaced")
    for entry in transaction["files"]:
        target = workspace_path(root, entry["target"])
        if entry["source"] == entry["target"]:
            atomic_write(target, entry["new"].encode("utf-8"))
        elif not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as stream:
                stream.write(entry["new"].encode("utf-8"))
                stream.flush()
                import os
                os.fsync(stream.fileno())
    for entry in transaction["files"]:
        source = workspace_path(root, entry["source"])
        if entry["source"] != entry["target"] and source.exists():
            if source.read_bytes() != entry["old"].encode("utf-8"):
                raise ValueError("Source changed during archive; journal retained")
            source.unlink()
    workspace_path(root, JOURNAL).unlink()


def archive_task(root, note, restore=False, recover=False, expected_hash=None):
    root = Path(root).resolve()
    dashboard = workspace_path(root, TASKS + ".dashboard-write.lock")
    dashboard.parent.mkdir(parents=True, exist_ok=True)
    lock = dashboard.open("x")
    try:
        return _archive_locked(root, note, restore, recover, expected_hash)
    finally:
        lock.close()
        dashboard.unlink(missing_ok=True)


def _archive_locked(root, note, restore, recover, expected_hash):
    with memory_lock(root):
        journal = workspace_path(root, JOURNAL)
        if journal.exists():
            if not recover:
                raise ValueError("An archive transaction needs --recover; no new archive started")
            transaction = json.loads(journal.read_text(encoding="utf-8"))
            # Recovery may only touch task notes and their sidecars.
            for entry in transaction["files"]:
                for field in ("source", "target"):
                    path = entry[field]
                    if not path.startswith((TASKS, ARCHIVE)) or "/" in path.split("/", 3)[-1] or not path.endswith((".md", ".task.json")):
                        raise ValueError("Unsafe archive journal")
            finish(root, transaction)
            return transaction["note"]
        if recover:
            raise ValueError("No archive transaction to recover")
        prefix, destination = (ARCHIVE, TASKS) if restore else (TASKS, ARCHIVE)
        if not isinstance(note, str) or not note.startswith(prefix) or "/" in note[len(prefix):] or not note.endswith(".md"):
            raise ValueError("Choose a task note in the source directory")
        source = workspace_path(root, note)
        data = source.read_bytes()
        if expected_hash is not None and digest(data) != expected_hash:
            raise ValueError("Task changed during archive preparation")
        content = data.decode("utf-8")
        if not restore and any(line.strip() in {"Branch: main", "Branch: master", "Branch: develop"} for line in content.splitlines()):
            raise ValueError("Rolling protected-branch memory is consolidated, not archived")
        target = destination + note[len(prefix):]
        files = [{"source": note, "target": target, "old": content, "new": content}]
        sidecar = note[:-3] + ".task.json"
        metadata = workspace_path(root, sidecar)
        # Preserve metadata left behind by older Markdown-only archive operations.
        if restore and not metadata.exists():
            sidecar = TASKS + note[len(ARCHIVE):-3] + ".task.json"
            metadata = workspace_path(root, sidecar)
        if metadata.exists():
            old = metadata.read_bytes().decode("utf-8")
            value = json.loads(old.lstrip("\ufeff"))
            if value.get("note") not in {note, target}:
                raise ValueError("Task metadata does not match this note")
            value["note"], value["archived"] = target, not restore
            target_sidecar = target[:-3] + ".task.json"
            files.append({"source": sidecar, "target": target_sidecar, "old": old, "new": json.dumps(value, ensure_ascii=False, indent=2) + "\n"})
        for entry in files:
            if entry["source"] != entry["target"] and workspace_path(root, entry["target"]).exists():
                raise ValueError("Archive destination exists; nothing replaced")
        transaction = {"note": target, "files": files}
        atomic_write(journal, canonical_json(transaction))
        finish(root, transaction)
        return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--note")
    parser.add_argument("--expected-hash")
    parser.add_argument("--restore", action="store_true")
    parser.add_argument("--recover", action="store_true")
    args = parser.parse_args()
    try:
        print(archive_task(args.root, args.note, args.restore, args.recover, args.expected_hash))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print("AI-OS task archive: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
