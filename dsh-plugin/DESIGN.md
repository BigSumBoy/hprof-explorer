# HPROF Explorer DSH plugin design

Current as of plugin `0.10.1`.

This document records the architecture and the decisions behind the DeepSeek Harness (DSH) plugin in this directory. Installation and user-facing usage live in [README.md](README.md). The deferred generic PTC seam is recorded in [PTC_SEAM_PLAN.md](PTC_SEAM_PLAN.md).

## Goal

Use HPROF Explorer as a native Harness capability, not as an embedded web app or a script the model writes per analysis:

- the model gets discoverable, bounded HPROF operations;
- the same operations are available to PTC and the Web UI;
- the Web workspace exposes analysis and conversation together;
- findings and reports are durable artifacts;
- the UI is observable and controllable by the agent through domain commands.

## Non-goals

- Arbitrary DOM automation. UI control is a command API over panel state.
- Replacing the HPROF parser. `src/hprof.mjs` remains the parser.
- Persisting UI tab, filter, page, or tree state in the session log.
- Faking session events before a Host session-event seam exists.

## Architecture

```text
DSH Host
  └─ @local/dsh-hprof-explorer
       ├─ service.mjs       domain operations, findings, UI bridge
       ├─ index.js          tools, /hprof-api routes, profile apply
       ├─ engine.mjs        one parser child process per open dump
       ├─ findings.mjs      durable findings keyed by dump file
       ├─ ui-state.mjs      per-panel state, commands, event ledger
       ├─ ui-manifest.mjs   model-facing UI action catalog
       ├─ ptc.mjs           host side of the plugin-local program runner
       ├─ ptc-runner.mjs    isolated vm runner
       └─ client.js         native main panel, sidebar tab, Chat

src/hprof.mjs               parse / index / dominators / paths
```

The plugin does not start `src/server.mjs`. The Host owns the lifecycle; the parser is still the same ESM module, loaded by the engine child process.

## Service first

`service.mjs` is the source of truth. Its manifest currently exposes 29 operations:

```text
dump.open/list/close/summary
entity.get/fields/array/statics/referrers/children
query.classes/instances/strings/roots/retained
paths.object/class
analyze.classStats/diff/report
findings.create/list/update/delete
ui.state/manifest/command/events
```

All consumers project this surface:

| Consumer | Projection |
|---|---|
| Model | generic `hprof_api`, flat `hprof_ui` actions, convenience tools (18 tools total) |
| PTC | `hprof.<group>.<method>` namespace generated from the manifest |
| Web UI | `/hprof-api` routes and client components |
| Reports | service `analyze.report` includes findings |

New capabilities are added to the service first. A new tool is justified only when it improves discovery or supplies a materially safer input shape; it must not become a second implementation.

## Identity and state

Three layers, intentionally separate:

### Durable

Findings are keyed by a SHA-1 of the dump file's resolved path, not by the runtime `dump-N`. Reopening the same file or restarting Host preserves them.

```text
<appDir>/data/findings/<dump-file-sha1>.json
```

Generated reports live wherever `hprof_report` writes them; `data/` is gitignored.

### Ephemeral

UI state is memory-only and keyed by `(dump_id, client_id)`:

- tab, selected class/object/path/referrers;
- selected table row and filters;
- page and sort;
- DomTree expanded ids and class-path tree collapsed keys.

A panel reports `panel: "workspace" | "sidebar"`. Commands can target a `client_id`; an untargeted command goes to the first panel that polls. The UI state is not session history.

### View persistence

Filter, page, and sort state are also written to browser localStorage keyed by dump file path and table. They survive tab switches and page refresh, but not a different browser or machine.

## UI bridge

The panel polls `/hprof-api/ui/commands` every 1.2 seconds and reports state through `POST /hprof-api/ui/state`. Commands are domain actions:

```text
selectTab
selectRow
setFilters
setPage
setSort
setWeak
toggleNode
selectObject
selectClass
openDump
closeDump
closeDrawer
refresh
runReport
draftMessage
notice
```

`draftMessage` fills the bottom Chat composer without sending. The main workspace's embedded Conversation has its own composer and is not filled by this command.

`hprof_ui` is the model-first projection over these commands. It uses flat parameters and a closed action enum; high-level actions such as `showClassPaths` and `showUnreachable` expand into the low-level commands above. The low-level `hprof_api` `ui.command` and PTC `hprof.ui.command` remain the complete escape hatch. `ui.manifest` returns the action catalog, and `ui.state` includes `available_actions` and panel ids.

A bounded in-memory event ledger records state reports, command enqueue, and delivery. It is diagnostic, not a session log.

## PTC

`hprof_ptc` runs one model-written program in a child process:

- the child sees only a context-created `hprof` namespace and `console`;
- each `hprof.*` call is a JSON-line RPC back to the host service;
- no `fs`, `process`, `require`, or shell is exposed;
- host-enforced timeout (20 s default, 60 s max) and result/log bounds;
- the child is killed after one program.

This is plan B. Plan A, a generic DSH binding-provider seam for `run_code`, is documented in [PTC_SEAM_PLAN.md](PTC_SEAM_PLAN.md) and not implemented.

## Findings and reports

Findings support object, class, path, field, and dump targets. They have severity, tags, author, note, and timestamps. The UI can create, edit, delete, filter by severity, and search title/tag/note.

`hprof_report` calls `analyze.report`, which appends a `## Findings` section to the generated Markdown. This makes the analysis deliverable rather than leaving conclusions only in the transcript.

## Resource lifecycle

- One parser child per open dump.
- Idle dumps stay open by default; set `idleTimeoutMs` to a positive millisecond value to enable idle closure.
- Dump ids are runtime handles; findings are keyed by file identity.
- Host disposal closes engines and rejects pending requests.
- PTC always uses a short-lived child and never shares the parser process.

A 129 MB SystemUI dump uses roughly 0.9 GB in the parser child. Dump count defaults to 3.

## Bounds and safety

- Class paths are returned as compact chains, at most 10 groups per page; the engine pages the complete group list instead of hard-capping it at 100. The service response includes total, reachable, unreachable and up to five unreachable samples; the UI shows the full unreachable list in a separate paginated section.
- Instances and arrays page; instances support field projection.
- `class_stats` trims callsites and holder categories.
- Tool results are rendered with a 7000-character cap; the service must still paginate so the cap does not hide necessary data.
- Findings writes are synchronous and small.
- UI commands are validated against a closed action set and bounded payload size.
- PTC code, result, and logs are bounded.

The PTC vm is an isolation measure, not a hard security boundary. It is intended for local trusted model code.

## Verification

The current smokes are:

```text
node dsh-plugin/client-smoke.mjs
node dsh-plugin/smoke.mjs
```

They cover the engine protocol, 18 tools, findings CRUD, report findings section, PTC success/error/timeout, API routes, per-panel UI state, client registration, complete class-path group paging beyond the old 100-group cap, and the default-disabled idle close.

Live browser verification has covered:

- row selection, filters, page, sort;
- class-path tree collapse;
- class-path counts and unreachable list on a 164 MB dump: 5339 total, 1865 weak-reachable, 3474 unreachable, 1437 groups; group page 1436 returned the final group;
- `hprof_ui` manifest and high-level `showClassPaths` expansion, including `setWeak`, applied by the live sidebar panel;
- `ui.state` exposing `available_actions`;
- cross-panel command targeting;
- Chat draft filling without sending;
- report containing five findings.

Not verified in this environment:

- Linux execution end to end;
- a real-browser automated composition test;
- a 15-minute idle soak with `idleTimeoutMs` explicitly configured;
- true session-event replay.

## Installation

The plugin is private and not published to npm. Clone the full repository and install with a link so the plugin package parent resolves to the checkout:

```powershell
git clone https://github.com/BigSumBoy/hprof-explorer.git
dsh plugin --profile web add link:<checkout>/dsh-plugin
```

The bundle patch deliberately omits `appDir`; `index.js` defaults it to the parent of the plugin package. A copied install must set `appDir` explicitly.

See [README.md](README.md#另一台机器) for platform-specific commands.

## Known limitations and deferred work

- No true `SessionEventMap` integration for UI actions.
- Chat is draft-only; sending needs an identity and session-semantics decision.
- No arbitrary DOM control, by design.
- The main workspace's embedded composer is not filled by `draftMessage`.
- Class-path tree AI toggles use an opaque key or a visible-row index; there is no user-facing selector for a key.
- UI state is lost on Host restart; findings and reports are durable.
- Linux is untested; the code uses platform-neutral path/spawn APIs, but this has not been exercised.
- Plan A PTC seam and cross-platform CI remain future work.
