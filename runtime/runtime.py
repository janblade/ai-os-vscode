#!/usr/bin/env python3
"""One bounded JSON request per process; callers authorize roots before invoking."""

import json
import re
import sys
from pathlib import Path

# -I excludes project modules and user site packages; only this reviewed bundle is imported.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from context import assemble_pack, context_item
from storage import canonical_json, memory_lock, workspace_path

PROTOCOL = "AIOS-runtime/1"
REQUEST_LIMIT = 64 * 1024
RESULT_LIMIT = 1024 * 1024


def relative_path(value):
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise ValueError("Expected a relative file path")
    parts = value.split("/")
    if any(not part or part in {".", ".."} or re.search(r'[\\:\x00-\x1f<>"|?*]', part)
           or part.endswith((".", " ")) or re.match(r"(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)", part)
           for part in parts):
        raise ValueError("Unsafe relative file path")
    return value


def directory(value):
    if not isinstance(value, str) or not Path(value).is_absolute() or not Path(value).is_dir():
        raise ValueError("Expected an existing absolute directory")
    return Path(value).resolve()


def selection(value, limit):
    if not isinstance(value, list) or len(value) > limit or any(not isinstance(item, str) for item in value):
        raise ValueError("Invalid or oversized source selection")
    return value


def preview(params):
    if set(params) - {"frameworkRoot", "repositoryRoot", "task", "files", "skills"}:
        raise ValueError("Unknown context parameters")
    root, repository = directory(params.get("frameworkRoot")), directory(params.get("repositoryRoot"))
    task = params.get("task")
    if task is not None:
        relative_path(task)
        if not task.startswith(".ai-os/memory/tasks/") or not task.endswith(".md"):
            raise ValueError("Expected an explicit task note in memory/tasks")
        if not workspace_path(root, task).is_file():
            raise ValueError("Selected task note is unavailable")
    files = [relative_path(item) for item in selection(params.get("files", []), 32)]
    skills = selection(params.get("skills", []), 8)
    with memory_lock(root):
        framework = assemble_pack(root, skills=skills, task_file=task, infer_task=False)
        items = [{**item, "scope": "framework", "id": "framework:" + item["source"]} for item in framework["items"]]
        for name in sorted(set(files)):
            item = context_item(repository, name, "explicit repository source")
            items.append({**item, "scope": "repository", "id": "repository:" + item["source"]})
        pack = {"format": "AIOS-bound-context/1", "framework_version": framework["framework_version"],
                "frameworkRoot": str(root), "repositoryRoot": str(repository), "task": task, "items": items}
        if len(canonical_json(pack)) > RESULT_LIMIT:
            raise ValueError("Context exceeds 1 MiB; select fewer sources")
        return pack


def dispatch(request):
    identity = request.get("id") if isinstance(request, dict) else None
    if not isinstance(identity, str) or not identity or len(identity) > 100:
        identity = None
    try:
        if identity is not None:
            identity.encode("utf-8")
    except UnicodeError:
        identity = None
    response = {"protocol": PROTOCOL, "id": identity}
    try:
        if (not isinstance(request, dict) or set(request) != {"protocol", "id", "operation", "params"}
                or request["protocol"] != PROTOCOL or identity is None or not isinstance(request["params"], dict)):
            raise ValueError("Unsupported or malformed runtime request")
        if request["operation"] == "capabilities":
            if request["params"]:
                raise ValueError("Capabilities accepts no project parameters")
            result = {"operations": ["capabilities", "context.preview"], "contextFormat": "AIOS-bound-context/1",
                      "memoryMutation": False, "hookInstallation": False, "commandExecution": False}
        elif request["operation"] == "context.preview":
            result = preview(request["params"])
        else:
            raise ValueError("Unsupported runtime operation")
        return {**response, "ok": True, "result": result}
    except (ValueError, OSError, KeyError, TypeError, AttributeError, RuntimeError) as error:
        return {**response, "ok": False, "error": {"code": "INVALID_REQUEST_OR_SOURCE", "message": str(error)[:1000]}}


def main():
    try:
        raw = sys.stdin.buffer.read(REQUEST_LIMIT + 1)
        if len(raw) > REQUEST_LIMIT:
            raise ValueError("Runtime request exceeds 64 KiB")
        response = dispatch(json.loads(raw.decode("utf-8")))
        output = canonical_json(response)
    except (ValueError, OSError, RecursionError) as error:
        response = {"protocol": PROTOCOL, "id": None, "ok": False,
                    "error": {"code": "INVALID_REQUEST", "message": str(error)[:1000].encode("utf-8", errors="replace").decode("utf-8")}}
        output = canonical_json(response)
    sys.stdout.buffer.write(output + b"\n")
    return 0 if response["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
