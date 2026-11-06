<p align="center">
  <img src="docs/assets/dsh-memory-logo.png" alt="dsh-memory logo" width="180" />
</p>

<h1 align="center">dsh-memory</h1>

<p align="center">
  Long-term memory for DeepSeek-Harness: authoritative Markdown on your own machine, Session consolidation, reversible forgetting, and cross-record governance.
</p>

<p align="center">
  <a href="README.md">中文</a> · English
</p>

<p align="center">
  <img src="https://badgen.net/badge/license/MIT/green" alt="MIT license" />
  <img src="https://badgen.net/badge/format/DSH%20bundle/8257D0" alt="DSH bundle" />
</p>

<div align="center">

[What it is](#what-it-is) · [What it does](#what-it-does) · [Features](#features) · [How to use it](#how-to-use-it) · [Data and privacy](#data-and-privacy) · [Documentation](#documentation)

</div>

## What it is

`dsh-memory` is a local long-term memory plugin for DeepSeek-Harness.

It keeps what an agent needs to remember across conversations — user preferences, project constraints, verified experience — in Markdown files on your own machine, and offers them to the agent in later conversations.

Three properties distinguish it from other memory approaches.

**The authoritative data is Markdown, not a database.** Every memory is a `.md` file you can read, edit, and back up directly. No vector store, no separate service, no encrypted container. Open it in any editor, copy it from any file manager.

**Only the index enters the context.** Each request carries the Global memory plus the *index* of the current workspace, not every body. The agent sees entry names and reads the one document it needs using DSH's existing file tools. Context cost does not grow linearly with memory size.

**State and content are separate.** Whether a record is active, how long since it was used, whether it contradicts another — that lives in a governance sidecar. The body never moves, so any organisation can be undone.

It works alongside DSH's model, session, and filesystem services without making decisions on their behalf.

## What it does

The plugin works at four layers.

### 1. Layered storage with progressive disclosure

Memory lives at two levels:

| Level | Location | Content |
|---|---|---|
| Global | `$DSH_HOME/memory/GLOBAL.md` | Preferences and rules that apply across projects |
| Workspace | `$DSH_HOME/memory/workspaces/<key>/` | Records belonging to one project |

Injection provides the Global document in full and the current workspace's index. That index is a generated, always-rebuildable list of entry names pointing at the real records.

### 2. Session consolidation

Finished, stable conversations can be turned into long-term memory.

The flow is: the user triggers it manually → eligible Sessions are filtered → an isolated consolidation agent reads the evidence and proposes changes → the host validates evidence ownership and data revision → an atomic write records the result.

The model only **proposes**. Which workspace a memory belongs to, whether its content matches the evidence, whether the revision moved under it — deterministic code decides those, not the model.

### 3. Memory governance

A record grows stale, is superseded by a newer fact, contradicts another, becomes too important to forget, or gets misjudged as broken because the network flaked once. The governance layer manages those states:

- **Importance tiers**: critical / durable / working / transient, computed from observable signals rather than scored by a model
- **Lifecycle**: `active → cooled → archived`, which changes only whether a record appears in the prompt
- **Conflict classification**: hard conflict, temporal evolution, environment split, intermittent — each handled differently
- **Forgetting review**: a report of what *would* happen, executed only after you confirm it

**Forgetting does not touch the Markdown.** A "forgotten" record sits on disk intact; it simply stops appearing in prompts automatically. Change its state and it comes back.

**No code path produces a deletion.** Physical removal is a separate act you have to ask for, and it is not part of any automated flow.

### 4. Cross-record proposals (Dream)

Dream reads the records that already exist and proposes how to organise them: merge duplicates, mark supersession, flag contradictions, adjust priority.

Eight actions: four change a body (merge / supersede / extract-sop / promote-global), four change only metadata (mark-contested / set-priority / cool / archive). **There is no delete.**

The default mode is `shadow`: it may compute and display, and writes nothing. Content changes need you to tick each action, in every mode.

## Features

### Settings panel

The plugin adds six tabs to DSH Settings:

| Tab | Purpose |
|---|---|
| Global Memory | View and edit the `GLOBAL.md` that applies to every workspace |
| Workspace Memory | Browse, create, and edit records for the current project |
| Session Consolidation | Browse eligible Sessions, trigger consolidation, read recent results |
| Forgetting Review | See what the forgetting policy *would* do, then confirm it |
| Dream | Run Dream, review its proposals, approve them action by action |
| Settings | Choose the consolidation model, enable Debug logging, set forgetting and Dream modes |

### Endpoints

The plugin exposes 18 RPC endpoints under `/memory` for the panel:

```
status                      global/read              global/replace
workspaces/list             workspace/read           workspace/commit
sessions/list               sessions/consolidate
models/read                 models/select
governance/status           governance/forgetting    governance/initialize
dream/status                dream/run
dream/proposal/read         dream/proposal/approve   dream/proposal/reject
```

The web management interface is loopback-only.

### Extension points

Governance does not judge facts about the outside world. Whether a network is up, a proxy is stable, a model is available — external modules supply that, through two optional interfaces:

- a **verification provider** reports whether a record still holds
- a **trigger provider** decides when a governance pass should run

Neither is required. Without them the feature degrades to manual operation rather than failing. See the [governance provider contract](docs/governance-providers.md).

### Observability

Every consolidation and every Dream run writes a result record. Optional Debug logging captures stages and error chains, but never copies conversation bodies, memory bodies, or credentials.

## How to use it

### Installation

**npm:**

```sh
dsh plugin --profile web add @hr98w/dsh-memory
```

**Patched branch (DSH ≥ 0.2.1-rc.2):**

```sh
dsh plugin --profile desktop add "github:xuemingze/dsh-memory-patched#v0.1.5"
```

**From source:**

```sh
pnpm install
pnpm run build
dsh plugin --profile web add .
```

You must **fully restart** DSH afterwards. Refreshing the page does not load new host code.

### First run

In any workspace, tell the agent:

> Remember: this project's release check codename is Pinecone; remind me to verify the rollback plan before every release.

Once the write is confirmed, start a new Session in the same workspace and ask:

> What are the release conventions for this project?

If the answer uses the convention, memory is working. You can read the corresponding Markdown under "Workspace Memory".

**Do not put project conventions in Global** — they would then appear in every unrelated project.

### Consolidating a conversation

1. Configure and activate at least one text model on DSH's Models page
2. Open Settings → Memory → Settings and choose the consolidation model
3. Under "Session Consolidation", pick a Session that has ended and is stable
4. Start the consolidation and wait for it to finish
5. Check the result; to troubleshoot, enable Debug and trigger it again

Consolidation uses its own model, independent of the one you converse with.

### Reviewing forgetting

1. Open "Forgetting Review"
2. Read the report — it lists what *would* be cooled and archived
3. Check each entry to confirm nothing important is harmed
4. Confirm to apply

An empty report is a normal result: no record has reached a cooling threshold yet.

### Using Dream

1. Open "Dream"
2. Click "Run one planning pass" — this only creates proposals, it changes nothing
3. Proposals appear under "Pending", each action carrying a risk label
4. Tick the actions you agree with, or reject them all with a reason code
5. Approval writes them; rejected actions come back marked "declined" next time

`metadata-only` actions (priority, visibility, archive) can be undone by another metadata action. `content-change` actions (merge, supersede) cannot be reconstructed from what remains, which is why they are labelled separately.

### Development

```sh
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run check
```

Run `pnpm run check` before committing. See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution flow and [docs/development.md](docs/development.md) for verification.

## Data and privacy

Default layout:

```text
$DSH_HOME/memory/
├── GLOBAL.md                            # cross-workspace memory
├── settings.yml                         # model selection and feature modes
├── consolidator-workspace/              # dedicated cwd for the internal review Session
├── debug/<review-id>/attempt-<n>.jsonl  # written only with Debug enabled
├── reviews/<review-id>.md               # one result record per consolidation
├── dream/                               # Dream receipts and staged plans
├── governance/workspaces/<key>.json     # governance sidecar: state, scores, conflicts
└── workspaces/<key>/
    ├── MEMORY.md                        # generated index, rebuildable
    └── <name>.md                        # authoritative detail
```

- The web management interface is loopback-only
- Web write requests never carry the memory root, absolute paths, or internal workspace keys
- Debug is off by default and records neither conversation evidence, memory bodies, model proposals, nor API keys
- `MEMORY.md` is a rebuildable index; the detail Markdown is authoritative
- The governance sidecar is separate from the Markdown: state changes never touch a body, so any organisation is reversible

**Concurrency protection covers one MemoryStore instance.** Keep a single DSH process responsible for writes under one `$DSH_HOME`. Independent processes sharing a directory can still overwrite each other.

**"Local-first" means the authoritative data is local, not that all processing is offline.** A normal conversation sends the visible memory context to that conversation's model; a manual consolidation sends the filtered conversation content to whichever provider you selected. Decide whether to enable these features based on your provider's privacy policy.

For security issues see [SECURITY.md](SECURITY.md).

## Evaluation

The repository ships a [LoCoMo-10 evaluation](benchmark/locomo/README.md) kept separate from the shipped code, comparing three modes: no memory, online memory only, and online memory plus Session consolidation.

![LoCoMo-10 accuracy across three modes](docs/assets/locomo10-accuracy.svg)

In the retained run: Baseline 2.60%, Memory 73.05%, Memory + Consolidate 77.60%. These are one complete result per mode, not an average across repeated runs, and not a comparison against other memory systems. The [retrospective](docs/locomo-retrospective.md) records the setup and the limitations.

## Documentation

- [Architecture](docs/architecture.md): components and the Host/Browser request flow
- [Design](docs/design.md): product rules and boundaries
- [Session consolidation](docs/session-consolidation.md): full flow, state machine, and data contracts
- [Dream contract](docs/dream.md): action vocabulary, approval flow, and write boundaries
- [Governance provider contract](docs/governance-providers.md): how external modules supply observations
- [Roadmap](docs/roadmap.md): completed milestones and future directions
- [Development](docs/development.md): commands, verification matrix, and release procedure
- [LoCoMo-10 benchmark](benchmark/locomo/README.md): isolated runs, Judge, Score, and cost reporting
- [Decision records](docs/decisions/implemented/): non-trivial architecture, behavior, and protocol decisions

## License

[MIT](LICENSE) © 2026 hr98w
