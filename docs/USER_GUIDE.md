# AI OS Workspace — local preview

A VS Code extension with one shared `.ai-os` per workspace. It detects or initializes
the framework, provides file-backed tasks and a visual linear workflow editor, and
executes workflows through native Claude Code/Codex connectors or a local mock runner.

## Try it

1. Open this `vscode/` directory in VS Code.
2. Run `npm ci`, then press **F5** (`Run AI OS Extension`).
3. In the Extension Development Host, open your folder or multi-root workspace.
   Trust it to enable changes. A single detected framework is reused; otherwise run
   **AI OS: Select Existing Framework** or **AI OS: Initialize Workspace**.
4. Run **AI OS: Create Task** from the Command Palette. Its dashboard form accepts
   a prompt or form fields, repository and optional default agent. Choose a drafting
   provider, click **Prepare task draft**, review the result, then **Save task**;
   the new entry is selected for preview and further editing.
5. Run **AI OS: Create Example Workflow**. Click a node to edit its prompt, drag it
   to reposition it, or add an agent/approval step. **Ctrl/Cmd+S** saves; native undo
   and redo work through the VS Code document. The last step connects to new steps.
6. Click **Run workflow**, optionally associate a task, and watch the activity panel.
   **Review & approve** opens a native confirmation before continuing.
7. Use the **AI OS** activity-bar view or **AI OS: Show Run History** for saved runs.
   After a reload, explicitly resume interrupted or paused mock runs from history.
8. Run **AI OS: Preview Task Context** to inspect saved task/plan context and optionally
   selected repository files in a read-only JSON document. Python 3.9+ must be on PATH
   (`python` on Windows, `python3` elsewhere). This local preview sends nothing to agents.

Closing the canvas does not stop a run. Closing/reloading VS Code interrupts it.
**Cancel run** is a separate, terminal user decision. No steps retry automatically.
Mock steps make no network requests, spend no API credits, and modify no project files.

## Workspace dashboard

Open the **AI OS** activity-bar icon and choose **Tasks**, **Agents**, **Memory**, **Workflows**,
**Repositories** or **Runs** from the navigation buttons. The selected page opens in
the workspace dashboard with entries, details and its available actions. The sidebar
contains navigation only; files are listed once in the dashboard. You can also run
**AI OS: Open Workspace Dashboard** from the Command Palette.
Search titles, file paths and repositories; filter tasks by their recorded state or memory
by category. Select a card to preview the source, including unsaved task-editor changes.
File changes refresh the dashboard automatically; Refresh also reloads it explicitly.

Close a task form before switching pages; sidebar navigation preserves an open draft.
Repositories show detected configuration without importing or changing it. Run cards
show saved snapshots; **Manage run** opens the existing approval/cancel/resume actions.

Task states are the existing open/in-progress/done properties, not inferred session state.
Legacy notes are listed as unbound and can be explicitly adopted. Open task notes and
properties in native editors; semantic, procedural and episodic memory remains read-only
through this panel. JSON/JSONL and Markdown previews display source text without executing
HTML, fetching links or rendering external resources. Oversized files show a preview error.

**Copy park prompt** prepares an agent request to run WRAP and preserve continuity.
**Copy resume prompt** identifies the framework, task and known repository for a new agent
session. These buttons only copy text: they do not save continuity, park a live session,
change branches, alter task state or clear model context. Run the copied prompt in your
agent, then open the appropriate branch/worktree in a new session for fresh context.
Unbound tasks require confirming their repository; invalid bindings must be repaired first.
Creating tasks/workflows and copying handoffs require Workspace Trust. Browsing works in
restricted mode. Nothing in the dashboard submits memory to an AI provider.

### Task create, edit and archive

Use **Create task** to choose **Via prompt** or **Via form**, select the repository/default agent, and prepare a draft through Claude/Codex. Review its title and notes before **Save task**.
Select a task card and click **Edit task** to edit its title, open/in-progress/done state
and Markdown notes in forms. **Save properties** and **Save notes** are independent
operations; saving one preserves the other form's unsaved draft. Repository rebinding
remains available through **Open properties** in the native JSON editor.

Saving checks both task files against the version loaded into the form. If an agent
or another editor changed either file, saving is rejected and your draft remains in
the form. Copy anything you need before **Discard draft and reload**. Unsaved native
VS Code editor changes also block form writes; save or discard those in their editor
first. Identity/Branch headers and identified memory-entry blocks are protected.

**Archive task** asks for confirmation and hides the task from active dashboard lists and new workflow task choices. Tick **Archived tasks**, select the task, click
**Edit task**, then **Restore task** to bring it back. This is reversible dashboard
archival, recorded as `archived` in its existing sidecar: notes, paths, IDs and links
stay intact. It does not run TASK_CLOSE, promote knowledge, stop an agent or prevent
BOOT from resolving branch-associated notes. Legacy unbound notes must be adopted
before changing properties or archiving. Invalid bindings require repair first.
Permanent deletion and editing of semantic memory remain unavailable in this increment.

Writes use exclusive dashboard locking, content checks and atomic replacement of one
file at a time. Windows file-busy retries are bounded and recheck content before each
attempt. A crash can leave `.dashboard-write.lock` in the tasks directory: inspect it
and confirm no dashboard write is running before removing it manually. Arbitrary
external writers do not share this lock; this is optimistic conflict detection, not
an OS-level guarantee against writes racing the final replacement.

### Agents and their relationship to tasks and workflows

Choose **Agents ? Create agent** to fill in the inline name, provider, optional model
and instructions form, then **Save agent**. Later, edit its JSON in the source editor: version 1, stable UUID, name, provider `mock`, `codex` or `claude`, optional `model`, and
instructions (1?8000 characters). Configurations live in `.ai-os/agents/*.agent.json`;
filenames must match their IDs. No credentials, shell commands or permission settings
are supported. Malformed configurations remain visible for repair and are omitted from
selectors. Only saved configuration changes are used by the runner.

A task records the work and can select a **Default agent** in its properties form.
A workflow defines steps; each agent node can **Use task default**, choose a saved agent,
or choose **No preset**. Instructions are combined with that node's step request. The
node selection overrides the task default. Missing or invalid selected agents stop the
affected run; they never silently fall back. If combined instructions exceed the workflow
prompt limit, shorten them before running.

A run associates a task, repository and workflow and saves the effective instructions
and agent configuration in its immutable snapshot. Editing a preset changes future runs;
mock recovery retains its original configuration. Native interrupted runs require review before a new run. Presets do not change
AI-OS governance or authorization. Selecting a preset alone does not launch a provider. Starting its workflow creates a fresh native session for each live step; existing host sessions are not taken over.

### Consistent creation forms

**AI OS: Create Task** and **AI OS: Create Agent Configuration** open the same dashboard
forms as the page buttons. Task intake offers **Via prompt** and **Via form**; both
use an agent to prepare a common draft before review and saving. They no longer use VS Code's global text input/quick-pick
sequence. Save creates exclusive task/agent files and selects the resulting entry;
Cancel discards only the unsaved form. Opening a form does not create files or start a
provider session. Creation errors and refreshes preserve entered values. Close an existing
form before switching pages or entries. A changed framework or lost trust disables saving.
Repository choices come from the current workspace and are checked again when saving;
agent defaults reference available saved configurations. Legacy task adoption still uses
its existing native selection flow, and workflow creation still opens its canvas editor.

### Prompt and form task intake

Both task creation methods converge on **Prepare task draft -> Review task draft -> Save task**.
Choose the drafting provider (Codex or Claude Code); the default agent selection is the
configuration for future task/workflow execution, not the drafting provider. A prompt supplies
free text; the form supplies a requested title and initial notes. Both require an explicitly
selected repository. Draft preparation uses the native provider/model allowance and sends your
input plus the previously approved AI-OS governance context to that provider.

The agent returns a validated structured draft. The host renders the same sections for both
paths: Summary, Evidence, Scope, Acceptance criteria, Next steps and Unknowns, under the existing
Working notes heading. Missing facts must stay unknown; reproduction/testing/ticket access
are not asserted as completed work. Review and correct the draft before saving. The host
requires a current prepared-draft ID for the chosen repository and reuses the existing task
file/sidecar helper. Generated content cannot choose paths, repositories or default agents.

Draft preparation does not file a task or start its workflow. Codex uses an ephemeral read-only
profile, no approval elevation and no configured MCP servers. Claude uses no tools, no
user/project/local settings and no persistent session for drafting; normal workflow connectors
retain their existing behavior. Cancel aborts the owned drafting process and discards the
unsaved creation draft. Errors preserve inputs; Revise input restores the original request.
Drafting times out after two minutes; it does not retry automatically. Saving retains the
existing exclusive file creation behavior, including possible unbound notes if sidecar writing
fails. Native model generation and non-Windows behavior have not been smoke-tested here;
protocol tests use synthetic outputs. Installed Windows Codex read-only write denial and
Claude tool-free initialization were checked without inference.

### Task activity and progress

Task cards now show a progress bar, an observed activity pill and a subtitle naming the
workflow/current step and saved agent when available. The bar measures succeeded steps
in the linked workflow, including approval steps; it does not estimate overall bugfix
completion. Active linked runs take precedence over historical ones. Running, queued,
confirmation, interrupted, failed, cancelled and finished states come from runner data.
A saved approval from an inactive run shows **Resume needed**, not live waiting.

**Manage linked run** opens the existing approval/cancel/resume controls. Saved task state
(open/in-progress/done) remains separately visible and filterable; completing a workflow
does not close the task. **No tracked run** means this extension has observed none?external
Claude/Codex sessions are not tracked. Task notes are not guessed into activity statuses.

## Shared framework and existing projects

Opening a single Git repository makes its root the natural shared AI OS location:
`.ai-os` belongs to that project and its files can be versioned alongside the code.
Choose which task/memory contents to share. Add `.ai-os/memory/runtime/` to the project's
`.gitignore` for transient local state; initialization leaves existing ignore rules intact.

Detection checks explicit workspace-folder roots and the directory of a saved
`.code-workspace` file. It never searches parent/home directories. One candidate is
remembered in VS Code workspace storage; multiple installations require selection.
A missing remembered installation requires repair or reselection instead of silently
switching. The shared location can be outside the workspace's repository folders.

**Initialize Workspace** asks for the folder that will contain `.ai-os`. It installs
the bundled AI OS 2.9.0 distribution pinned to `c8e956d`, without downloading or running
scripts. Source builds require that Git commit to be available. An existing installation
is never replaced. Retrying an interrupted installation fills missing files only when
its receipt and existing checksums match the same bundle. Truncated or modified files,
or a missing/damaged receipt, require manual inspection; recovery never overwrites them.

Added folders appear as execution targets, along with direct child Git repositories.
Removing a folder leaves its tasks and memory intact and makes its bindings unavailable.
The Repositories section lists existing `.ai-os` and Claude configuration paths. It
does not import, merge, modify or activate them. Initialization creates framework files;
agent entrypoints and hooks are a separate, future integration step. Existing agent
configuration can still be loaded by an agent according to that agent's own rules.

## Tasks and storage

- New notes: `.ai-os/memory/tasks/task-<uuid>.md`.
- Binding/properties: adjacent `<stem>.task.json`. This records a stable task ID,
  title, lifecycle state and repository binding. New version 2 bindings contain a
  canonical workspace-folder file URI plus a relative path; version 1 paths relative
  to the framework root remain supported. Absolute folder URIs need rebinding when
  sharing tasks across machines or moving folders.
  Edit properties through the native JSON editor. Task state is independent of run state.
- **AI OS: Adopt Existing Task** creates only a sidecar. It never infers repository
  ownership from a filename, renames a note, or alters its contents.
- Executable definitions: `.ai-os/workflows/*.workflow.json`. They are distinct from
  the framework's procedural recipe catalog. Repeated example creation uses new files.
- Run snapshots: private VS Code workspace storage, including the workflow, prompt,
  task reference, step status and bounded provider result and native session ID. They can contain private task
  text; do not commit or share them indiscriminately. No credentials are stored.
- Instructions and semantic memory open read-only. Task notes containing identified
  `AIOS-ENTRY` blocks also open read-only through the dashboard. Runtime-mediated memory
  mutation remains unavailable. The read-only runtime bridge is described in
  [Runtime bridge and context preview](../docs/runtime-bridge.md).

The host handles filesystem access. The webview cannot choose paths or launch programs.
Linked workspace paths (including Windows junctions) are rejected. Existing files are
created exclusively, so collisions fail instead of replacing user content. These checks
are not an OS sandbox against a hostile process racing filesystem mutations.

## Current limits

- Local desktop filesystem workspaces, including container folders and saved/untitled
  multi-root workspaces. Save an untitled workspace before relying on its identity
  across sessions. Selecting an installation affects only this VS Code workspace.
  Remote hosts and virtual filesystems are not tested/supported in this milestone.
- One active run per repository per extension host. Native runs also hold an exclusive
  machine-local extension lock across windows. External native clients do not share it;
  after a host crash, verify no process is running before removing the reported stale lock.
- Linear graphs with 1–50 agent/approval nodes; no arbitrary edge editing,
  branching, subworkflows or automatic retries. Native agents retain their shell/tools.
- Workflow version 1 supports `mock`, `codex` and `claude`. Unsupported documents remain
  intact and can be opened as text. Additional JSON fields survive edits but are metadata,
  not executable instructions. Whitespace is normalized when editing a valid document.
- Run uses an immutable snapshot of the current document, including unsaved edits.
  Native runs send bound governance, selected task/plan data and previous step results to
  the selected provider. Mock runs make no provider requests.
- Ordinary notes and task properties use native editors. Workspace Trust gates this
  extension's commands, not what a human can edit elsewhere in VS Code.
- Run snapshots are retained locally without automatic pruning. No existing provider
  session takeover, hooks installation, credential changes, or framework migration.


## Native Claude Code and Codex connectors

1. Install and sign in to Claude Code and/or Codex through their native clients.
   AI-OS reuses native authentication; agent presets never contain keys. Executables
   are discovered from installed paths (Codex's VS Code extension is supported).
   Set user-level `aiOs.claudePath` / `aiOs.codexPath` to an absolute executable path
   if discovery fails. Windows requires the native `.exe`, not a shell wrapper.
2. Create an agent preset and select its provider, or choose a provider directly in
   a workflow node with no inherited preset. Leave the model blank for the native default.
3. Start **Run workflow**, choose the task/repository, and confirm the native launch.
   BOOT, ultimate rules and selected task/plan are sent to that provider. Native model
   usage can consume your subscription allowance or incur provider charges.
4. Follow native tool approval dialogs: review details, **Allow once**, or **Deny**.
   Additional Codex permissions are limited to the current turn. Agent questions accept
   free text. Workflow approval steps remain separate and explicit.
5. Inspect tool activity, output and native session IDs in Runs/the workflow canvas.
   Cancel terminates the owned provider process tree. Edited files remain; cancellation
   is not rollback. Interrupted native runs never replay automatically or through Resume.

These are wrappers around native agents, preserving native tools, repository instructions,
Claude user/project/local settings and applicable hooks. Codex runs use its app server;
Claude runs use the official Agent SDK, bundled with this extension. No permission-bypass
flag, persistent approval rule, custom replacement toolset or host chat takeover is used.
Approved repository tools may execute according to native permission policy; the connector
prompts when the native provider requests approval, rather than promising a prompt per edit.

Write scope includes the selected repository and approved shared user-space paths.
Durable memory (tasks, semantic facts, plans, procedural and episodic records) is protected
from native writes. Agents may write proposal JSON under `memory/proposals`; use
**AI OS: Review Memory Proposal** to inspect current/proposed content and evidence, confirm
accepted work, and apply an amendment. Evidence and target hashes are checked again before
saving. Identity headers and identified entry markers stay intact; accepted operations have
an audit receipt and an episodic log entry. Manual human source editing remains available.

Kernel and host configuration paths remain protected. Ordinary tool approval cannot grant
those paths or a parent directory that includes them. Codex must apply the bound permission
profile; configured MCP servers are disabled because their processes are outside this file
gate. Broad temporary-directory writes are also removed: use repository-local scratch space.
This avoids a native Windows bypass when a shared framework is beneath the temp directory.
A disposable native probe verified repository/proposal writes succeed while repository and
shared semantic/kernel writes and `.codex` configuration writes are denied.

Claude uses explicit built-in tools and does not load provider-configured hooks or MCP tools.
On Windows, Bash and indirect/external writers are disabled until an enforceable sandbox
exists; Read/Glob/Grep and gated Write/Edit/NotebookEdit remain available. Use Codex for
Windows shell work. Non-Windows Bash requires the SDK sandbox with protected memory/kernel
paths denied; that platform has not been exercised. Neither connector is an isolation boundary
for deliberately hostile filesystem races or programs outside this extension.

Workspace/framework/repository authorization changes cancel active runs. Provider shutdown
waits for owned process termination before releasing the repository lease; uncertain shutdown
retains the lease for manual inspection. Title/status/default-agent edits affect future runs,
while existing runs keep their snapshots. Finish or cancel a task's active run before archiving.
Native context includes explicit framework/repository roots, stable task ID, repository-scoped
branch/session identity, and the approved manifest/genome/archetype/security/evolution policy.
Changing that policy or branch invalidates the execution context.

Run snapshots contain prompts, preset snapshots, bounded results and session IDs; native
clients also retain their own sessions according to their settings. No raw provider stderr
or authentication contents are logged. No paid/model inference smoke test was run.
Verification covers native initialization and disposable Windows sandbox writes, synthetic
protocol approval/input/cancellation flows, Windows extension hosts and browser UI checks.

## Work items, sessions and archives

New task notes and sidecars share one UUID. Existing notes are never renamed or rebound.
A task is a durable work item; its branch/session is separately namespaced by canonical
repository, task ID and exact branch. Native context provides the trusted identity resolver
and arguments. Standalone framework scripts accept `--repository` and `--task-id`; old
unscoped calls remain compatible and do not silently migrate notes.

Dashboard archive hides a work item; it does not perform TASK_CLOSE or promote facts.
Framework closeout uses `archive_task.py` to move Markdown and its sidecar together, with a
journal for interrupted moves and no overwrite of destination files. Physically archived
work items remain visible when showing archived tasks, retain run history, and can be
restored from the Tasks page. Old Markdown-only moves retain their stranded sidecar links.
Pruning must preserve bound work items while history still refers to them.
Fresh installations use the pinned clean framework plus a small explicit list of reviewed
user-space script/procedure overlays. Existing frameworks are not overwritten.

## Memory proposal format

```json
{
  "version": 1,
  "target": ".ai-os/memory/semantic/knowledge/example.md",
  "expectedHash": null,
  "content": "Verified fact\n",
  "reason": "Accepted bugfix and verified current implementation",
  "evidence": [{ "scope": "repository", "source": "src/example.ts", "sha256": "<64-character SHA-256>" }]
}
```

Use `null` only for a new target; amendments require the current target's SHA-256.
Targets are Markdown in tasks, plans, semantic or procedural memory. Evidence is a current
repository/framework file hash, not a model's assertion of acceptance. Human review is
mandatory. A crash can leave a prepared receipt; compare its before/after hashes with the
actual target before retrying. Archive recovery similarly requires inspecting the retained
journal before `archive_task.py --root <framework> --recover`.

## Development checks

Node 22+ and npm are used for development. Dependencies are exact and lockfile-pinned.

```sh
npm ci
npm run check
npm test
npm run test:extension
npm run test:webview
npm run test:dashboard
```

`test:extension` uses an isolated profile and disposable workspace. It downloads a VS Code
test host by default, or uses `VSCODE_EXECUTABLE_PATH` if provided. Set `AIOS_TEST_SCENARIO`
to `container` (default), `multiroot`, `untitled`, or `restricted`. The restricted scenario
starts with Workspace Trust enabled and checks the host's read-only guards; other
synthetic scenarios disable trust. `test:webview` uses installed Chrome
headlessly and saves screenshots under `.vscode-test/artifacts/`. It exercises the actual
bundled React UI with a test message bridge. Native document integration is tested in
VS Code; native confirmation-dialog clicks are not automated.

On Windows PowerShell, to use an existing VS Code executable:

```powershell
$env:VSCODE_EXECUTABLE_PATH = "$env:LOCALAPPDATA/Programs/Microsoft VS Code/Code.exe"
npm run test:extension
```

## Rollout

To smoke-test an existing workspace, set `AIOS_SMOKE_WORKSPACE` to its absolute root
and `AIOS_SMOKE_REPOSITORY` to a direct child Git repository containing `package.json`,
then run `npm run test:workspace`. This uses an isolated VS Code profile, creates a
temporary note and workflow, exercises the registered commands with simulated dialog
responses, and removes its test files. It verifies existing framework file hashes;
runtime state and Python caches are excluded. It does not click native dialogs or run
a real AI provider. The summary is `.vscode-test/artifacts/hiro-smoke-result.json`.

See [architecture and compatibility](../docs/vscode-workspace.md) and the
[rollout plan](../.ai-os/memory/plans/2026-10-13-vscode-workspace.md).
Workspace onboarding and the read-only runtime/context-preview bridge are implemented.
Native Codex/Claude connectors, reviewed memory amendments and task/archive identity
handling are implemented. Broader memory CRUD and hook reconciliation remain follow-ups.

## Unified agents - Workspace 0.1.9

The Agents page reads registered profiles from `.ai-os/agents/index.json` and shows
`agents/templates/*.json` separately. Tasks and workflow nodes reference the same stable
`agent_id`, including names such as `supervisor`; legacy GUI UUID IDs remain valid.

New profiles use the existing framework schema:

```json
{
  "agent_id": "<stable ID>",
  "name": "Investigator",
  "role": "Worker",
  "system_prompt_extension": "Follow current evidence and repository conventions.",
  "provider": "codex",
  "model": "<optional native model>"
}
```

Provider/model preferences are optional. Missing preferences inherit the workflow step's
settings. When a profile changes provider without choosing a model, an incompatible model
from the old provider is cleared. `default_model_tier` remains a preference, not an inferred
provider model identifier. Role, allowed_skills, execution_boundary and approval_gate fields
are preserved in snapshots and carried as task constraints. Directory/skill/model-tier lists
are advisory; they do not add a per-agent OS sandbox or expand connector authorization.

**Use template** opens the existing creation form with its instructions/name/preferences.
Save creates a separate registered profile and copies its role/constraint metadata, leaving
the template unchanged. Templates cannot be selected directly for execution. Existing agent
edits use the source editor; preserve the agent_id and registry file reference.

Legacy `agent-<UUID>.agent.json` files remain readable without rewrites or renames. Saving
a new profile also registers valid legacy profiles in the shared index, preserving their
paths, IDs and task/workflow links. Duplicate IDs, registry/file identity mismatches, unsafe
paths and corrupt registries fail closed. Registry creation uses a write lock and checks
for external changes; a crashed host may leave a lock requiring manual inspection.

## Epics and story runs - Workspace 0.1.10

The sidebar's **Epics** page reads existing Markdown plans in `memory/plans` marked
`- Type: epic`. It displays story status, steps, acceptance criteria, dependencies and
calculated progress. Flat plans remain under Memory. The task's Active plan pointer offers
**Open linked epic**; **Copy epic planning prompt** prepares a chat handoff for PLAN_WRITE.
Copying a prompt does not create a file or execute an agent.

Plans keep the existing framework format:

```markdown
# Epic: Roll out a feature
- Type: epic
- Status: approved
- Task file: memory/tasks/<task-note>.md

## Context
Overall outcome, epic acceptance criteria and exclusions.

## Story 1: investigate - Investigate evidence
Status: approved
### Acceptance Criteria
- [ ] Cause confirmed against current evidence
### Steps
1. [ ] Inspect evidence - verify: inspect the relevant logs

## Story 2: implement - Implement the fix
Status: approved
depends on: Story 1
### Acceptance Criteria
- [ ] Expected behavior verified
### Steps
1. [ ] Apply the fix - verify: run the regression check
```

**Run this story** chooses a saved reusable workflow and launches it against the epic's
linked task/repository. The framework's lowest-numbered-ready ordering is enforced:
plan/story approval, dependency completion and completed prerequisite steps/acceptance
criteria must be recorded. Completed, abandoned, draft and blocked stories cannot launch.
The task must have a valid dashboard binding and an available note/repository.

Each run records the epic URI, stable story slug, title and source hash alongside task ID.
Workflows are not changed or tied to an epic. Story-specific prompts exist only in the run
snapshot. Native context omits full plan bodies and supplies the selected story plus epic
context. Current connector gates, native confirmation, repository lease and tool approvals
still apply. The story displays its latest run and offers **Manage story run**.

A successful run does not mark a story done. Verify the criteria, perform the framework's
review pass, then record completion in the plan through its source editor or reviewed
memory proposal. Update the source header/task pointer roll-up per PLAN_EXECUTE. The GUI
calculates progress instead of keeping a second checklist; stale header status is disclosed.
Finish/cancel a run before editing its plan: changed or unsaved plans cannot dispatch, and
plan changes invalidate active story execution. Story runs require a fresh launch rather
than replaying an old snapshot.

Story identity uses the existing slug under its plan path. Changing a title/number retains
history; changing the slug or moving the plan changes the association. History snapshots
remain available. Persistent IDs across plan renames and automatic story scheduling are
not implemented. Dependency gates read recorded completion; they do not independently
prove test results. Kernel, planning procedures and existing plan files are unchanged.

## Tasks dashboard usability (0.1.12)

Select a task to see **Overview**, **Activity**, **Review**, and **Notes**. Overview leads with the saved outcome/next step and a contextual action (Start task, Respond to approval, Review work, Open epic, or Complete task). Task state, execution and recorded acceptance are separate; the workflow-step bar appears only for tracked runs and never indicates task completion. Needs attention, Running and Recent filters prioritize work; Recent sorts by the latest stored-note or run activity timestamp.

Use **Save handoff** for continuity. **More actions** contains editing, fresh-run restart, source/properties and external-chat prompts; **Technical details** holds paths/IDs. Completed/archived/unlinked tasks and blocked completion show the reason and available recovery action. Complete task routes through the existing fresh acceptance, plan, active-run and human-confirmation gates.

Detail tabs preserve form drafts. Clean forms close naturally when navigating; unsaved task, creation, handoff, epic and run-review forms offer **Keep editing** or **Discard changes** before leaving. Arrow keys/Home/End navigate detail tabs. The discard dialog traps keyboard focus and Escape keeps editing. Notes/settings retain separate CAS-protected saves; **Reload saved task** offers guarded recovery after conflicts. Drafts are in-memory; closing/reloading VS Code is not a persistent draft-save operation.

The completion commit's fingerprint excludes only its owned untracked lock/temp files, preventing a host save from invalidating its own acceptance. Ordinary reviews still include those files, and tracked/staged files are never excluded. Kernel/core planning and native approval rules are unchanged.

Workspace 0.1.13: an unlinked task now has **Select Repository**. It opens the repository picker directly for the selected task, preserves its notes/existing Task-ID, and creates only its binding metadata. Cancellation does not link anything; changed or unsaved notes are rejected. This does not launch a run. The toolbar adoption command retains its task/title selection flow.

Workspace 0.1.14: select a run in Runs (or Activity in its task) to see public assistant text while it runs, the last 30 timestamped activity events, and the elapsed time since an observed update. Codex agent-message deltas and Claude text deltas are relayed; reasoning and raw diagnostics are excluded. Live text retains the most recent 32 KB and is persisted at most four times per second; the dashboard pushes selected-run updates directly and coalesces filesystem inventory refresh. Runs cards show the latest activity/update time. No-update time is not a diagnosis of a stuck process. Approval/question requests still use the existing VS Code dialogs, with a clear waiting state. This does not add arbitrary mid-run chat or native-session takeover. Already-running old connectors do not acquire streaming after installation; let them finish or cancel explicitly before saving drafts and reloading the window. No real inference was used to validate this release.

Workspace 0.1.15: the saved **Architect, approve, build and test** workflow runs read-only ARCHITECT_PLAN, pauses for **Approve and start Build approved plan**, executes build and TEST_RUN, then pauses for final delivery review. Link a task to its repository and choose `architect-build-test.workflow.json`. The previous phase output opens at approval; current phase, public activity, friendly statuses and verification reports remain visible. Failed, blocked or malformed build/test reports stop advancement. Report gates validate declared evidence, not its truth; review the actual changes and test output.

Before PLAN_EXECUTE, the builder must confirm the approved plan is saved. Durable task/plan changes still use **Review memory proposals**; workflow approval does not apply these proposals. If a plan cannot be applied, execution blocks and requires a fresh launch after resolving it; native side effects are never replayed automatically. Final workflow approval does not record repository acceptance or complete the task. These remain separate reviewed actions. Validation uses simulated providers with real isolated Node build/test commands; real Claude/Codex inference has not been exercised.

Workspace 0.1.16: Tasks Activity and Runs share a compact current-phase card, bounded latest public-message excerpt (last 1,200 characters), approval/question action, and collapsible phase timeline. Approval opens the preceding result; failures open their phase. Full bounded transcripts, timestamped events, provider IDs and receipts remain under Details. **Manage / cancel run** opens the existing controls. Task **Go to Review** selects its Review tab; Runs **Review results** reveals repository acceptance and memory-proposal actions. Existing authorization, execution and completion gates are unchanged. Save drafts and finish or explicitly cancel active runs before reloading.

Workspace 0.1.17: **Recover run** appears for failed, cancelled and interrupted executions in Tasks and Runs. Choose **Retry from failed phase** to retain completed phase outputs/human workflow approvals, or **Start fresh run** to repeat all phases. Both fork a new run/provider session, preserve the stopped attempt and clear repository acceptance. Review changes/results from the confirmation dialog and confirm retained outputs still apply to the current repository and policies. Partial edits and external actions are not undone. Recovery rebuilds governance/task context, rechecks workflow/agent/task/repository freshness, and preserves tool approvals and repository leases. Unsaved/changed workflows, presets, archived/completed or rebound tasks block recovery; use a fresh task launch with the latest workflow after fixing them. Git review excludes ignored files/external state; inspect those separately. Epic recovery opens Epics and requires the current eligible story, retaining its dependency/approval checks. Startup interruption before the first phase can also recover.

The dashboard UX review covered Tasks, Epics, Agents, Memory, Workflows, Repositories, Runs, creation/edit/review forms, sidebar navigation and workflow canvas. Clear fixes include per-page next-step guidance, **Clear search and filters**, readable run-state filters/story labels, explanations for disabled epic launches, compact source previews, clear active/archived empty states and recovery as the failed task's primary action. Native approval dialogs, memory proposal acceptance and task completion remain separate human gates.

Workspace 0.1.18: recovery errors are shown in the dashboard, successful recovery selects the new run, and cancellation explicitly reports that no session started. **Start fresh run** selects an available workflow and repeats its approvals, including when the prior workflow file was deleted or changed. **Retry from failed phase** still requires the original workflow/presets; missing source explains how to use fresh recovery. Windows repository comparisons use paths rather than drive-letter-sensitive URI strings. No existing task run is automatically launched or undone by installation.

Workspace 0.1.19: verification evidence accepts existing text entries and structured `{command, result, limitations?}` entries (result: string, boolean or finite number). The shared parser still rejects malformed evidence and never advances blocked/failed phases. Activity renders structured evidence and shows historical blocked reports as **Blocked**, with the actual prerequisite summary instead of a misleading generic parser error; saved run history is unchanged. Resolve memory prerequisites through **Review memory proposals**, then retry the stopped phase. Workflow approval and memory amendment approval remain separate.

Workspace 0.1.20: select a valid entry in **Memory -> Memory proposals** to see its target/reason and **Review and approve proposal**. Validation and source review lead to the explicit **Approve proposal** confirmation. Supporting evidence, receipts and invalid documents appear under **Proposal support files** without approval actions. Evidence hashes, task identity, unsaved target protection and atomic apply gates are unchanged.


Workspace 0.1.29: agents are instructed to investigate available alternatives before asking for runtime evidence, and to distinguish implementation prerequisites from final acceptance during planning. Explicit approved prerequisites still require a reviewed amendment. A structured verification blocker now opens an editor question and keeps the phase waiting; send guidance to continue that phase with its prior report and decisions, without replaying completed workflow phases. Closing the question cancels the run. Tool permissions, memory review, test gates and final acceptance remain enforced. Native agent questions also use this editor form instead of the global input box. Historical failed runs require explicit recovery after reloading.


Workspace 0.1.30: saved task/plan Markdown is shared context. The framework watcher refreshes dashboard entries after file edits; editor saves also trigger refresh. Active runs compare the exact task/plan Markdown supplied to the agent, including at tool/phase boundaries. A changed/deleted source interrupts stale execution with the affected paths and Recover run guidance. Reviewed memory waits allow applying their proposals, then rebuild and track the new task/plan context before continuing. Unrelated Markdown does not invalidate the run. File changes never synthesize successful runs, approvals or task acceptance; dashboard task properties and recorded review remain explicit. Save pending source edits before recovery; already completed runs retain their historical results.

Selected workflow JSON and its resolved saved-agent configuration are also checked for live/recovered execution. Changed/deleted/invalid selected definitions interrupt stale runs; save source edits and recover with the current configuration. Unrelated agent edits do not invalidate other runs. Task binding identity/repository/agent assignment and closure, manifest/genome/archetype/security/evolution policy retain their authorization checks. Run snapshots remain historical audit records, not approval inputs.


Workspace 0.1.31: file-edit approval cards offer **Allow automatically (this run)** when the entire request is a validated create/update (no deletion, rename or unknown operation) inside the selected repository and the resolved AI OS archetype is hobby/startup. The button grants consent for that run only; cancellation/recovery ends it. The user-level **AI OS: Tool Approval Mode** setting (`ask` / `autoEdits`) sets the default; workspace/repository settings are ignored so repository content cannot grant consent. Change User Settings to `ask` to revoke the default; cancel a run to revoke its explicit run grant. Automatic decisions appear in run activity. Hidden paths, host/agent instructions, shared framework files, kernel/memory, commands/network/expanded permissions, read-only phases, explicit saved-agent approval gates, enterprise/critical policy, workflow approval and memory review do not inherit automatic consent. Unknown/invalid requests ask or fail existing validation. Provider sandboxes and per-request checks remain in place; no provider bypass/full-access mode or session-wide permission grants are enabled. Natural-language policy and task acceptance remain agent/review responsibilities.


Workspace 0.1.32: select a run (or a task's Activity tab), then choose **Overview**, **Flow**, or **Activity**. Flow shows the saved execution sequence with status labels, clickable nodes, zoom/pan controls and a keyboard-accessible phase picker. Selecting a phase shows the assigned saved agent, configured provider/model, duration, latest public output and verification. The current phase offers the existing approval, memory-review/continue or recovery action; permissions and freshness checks still apply. Graph selection and viewport stay stable during streamed updates. Editing a workflow remains a separate operation; the graph displays this run's snapshot.

**Context and usage** records prepared phase input in UTF-8 bytes, a rough bytes/4 token estimate, and source revision hashes. This covers assembled system instructions and the phase prompt, including retained results; it excludes native history, tool output and provider overhead and is not context-window occupancy. Available Codex token-usage notifications and Claude result usage are stored separately as provider-reported session counts; provider accounting conventions differ. Missing historical/provider statistics say unavailable instead of guessing. Retry retains statistics for retained phases and records a new baseline for the retried phase. Recovery provenance names the prior run and phase without merging audit histories.


Workspace 0.1.33: blocked phases now ask **How should [phase] continue?**, show the agent's blocker and a suggested next step, and offer **Continue investigation**, **Prepare revised plan**, and **Stop run** with explanations. **Give a different instruction** opens an optional custom reply. Native agent questions also render their supplied choices as buttons. Selecting a choice continues the current phase with that reply; it does not approve commands, permission escalation, or plan amendments. Stopping/closing a blocked-phase question cancels that run. Existing open questions use their original presenter until reload; reloading interrupts active runs, which can be recovered explicitly.


Workspace 0.1.34: **Recover run** in Tasks/Runs keeps recovery choices, fresh-workflow selection and final confirmation in a dashboard recovery panel. Expand **Review changes and previous results** before **Start recovery**; no recovery confirmation/source-review tab is opened. Background dashboard actions remain disabled while choices are pending; Cancel recovery or closing the dashboard starts no run. Repository/workflow/task/policy freshness and repository leases are still checked after confirmation. Memory-proposal reviews and the standalone recovery command retain their existing flows.


Workspace 0.1.35: a new provider attempt after memory approval or guidance receives the prior phase report as a continuation checkpoint alongside refreshed memory. Previous results appear separately from the current result in Activity and Flow. Recovery preserves this checkpoint even if the new attempt stops before producing a report. Checkpoints are working data, never approval or proof. PLAN_EXECUTE still owns its registered implementation, verification and review procedure; a subsequent TEST_RUN is independent delivery verification. The development workflow fixture uses these explicit labels. Existing workflow files and active snapshots are not migrated; required runtime acceptance stays required.


Workspace 0.1.36: Tasks > Activity and Runs have **Finish early...**. Enter a reason, choose an action, then review and confirm inside the dashboard. **Wrap up** stops the active agent, waits for shutdown, and starts a dedicated native `WRAP` session to propose a task handoff and session continuity; the task stays open. **Request task closure** requires a stopped run and current repository acceptance, then invokes `TASK_CLOSE` with the registered memory lifecycle procedure. Skipped/unverified acceptance and policy gates still apply. Closure is a request, not automatic task completion: connectors use reviewed memory proposals and report unsupported archival/rolling-task operations as manual follow-ups.

**Skip optional pending phases** applies only to explicitly optional read-only informational agent phases, without required verification or an agent approval gate. Set `readOnly: true` in workflow JSON, then use **Optional informational phase** in the workflow node editor; do this before starting the run. Existing frozen runs are unchanged. Skipped phases retain the user reason and show **Skipped (unverified)**. Remaining required phases and human approvals still execute; a run with skips ends as cancelled with an explicit skipped-work explanation, never a full success. Use a fresh workflow, rather than retry, to revisit skipped phases. Epic story runs use their epic lifecycle instead.

Continuity proposals support exactly `memory/episodic/last_session.json` and `sessions.jsonl` in addition to the existing Markdown targets. Records use `{session_id, started, ended, summary, next_up}`; started may be null. History appends one record, preserves prior bytes and rejects duplicate session IDs. The normal human review, source hashes, task identity, atomic apply and policy gates remain. No user action here automatically marks a task done or promotes facts.
