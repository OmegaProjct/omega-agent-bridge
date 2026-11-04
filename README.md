# Omega Agent Bridge

Omega Agent Bridge is a local orchestration CLI that lets a control agent keep the strategic role while delegating bounded engineering work to one or more local CLI agents:

- **`agy`** — Antigravity CLI
- **`claude`** — Claude Code CLI
- **`codex`** — Codex CLI

The controller defines the goal, constraints, and success criteria. The bridge plans the work, routes each job to an engine and an isolated account, executes it, runs an independent review when configured, and returns a structured report.

It is designed for a workflow like this:

1. A controller defines the goal, constraints, and success criteria.
2. The bridge asks a planning engine to inspect the workspace and propose bounded subjobs.
3. The bridge executes those subjobs, optionally on different engines, while tracking progress.
4. A review engine verifies the result independently.
5. The controller reads the structured report, inspects the diff, and decides what to do next.

## Why this exists

Local CLI agents are good at doing work. The missing piece is orchestration:

- stable job records and resumable runs
- machine-readable status
- isolated accounts with quota rotation
- cross-engine planning and review
- an explicit write-approval gate
- repeatable, auditable execution instead of ad hoc prompt glue

This project provides that layer while keeping the controller accountable for the final audit.

## Requirements

- Node.js 20+
- At least one supported engine CLI installed:
  - `agy` available in `PATH`, or `AGY_BIN` / `--agy-bin`
  - `claude` available in `PATH`, or `CLAUDE_BIN` / `--claude-bin`
  - `codex` available in `PATH`, or `CODEX_BIN` / `--codex-bin`
- A trusted local workspace the engine can access

Missing engines are reported by `setup` and `doctor`; they do not block use of the engines you do have.

## Install

```bash
npm install
npm run build
```

## First-run onboarding

Run the guided setup once per machine:

```bash
npx omega-agent-bridge setup
```

The setup command:

- detects each engine and records its executable
- creates the state directory and engine-scoped account folders
- writes `config.json` with safe defaults
- offers an interactive login when a terminal is available
- prints the exact login command when it cannot start one
- verifies the result and suggests next steps

Useful flags:

```bash
npx omega-agent-bridge setup --dry-run        # show the plan without changing anything
npx omega-agent-bridge setup --no-login       # create layout and config only
npx omega-agent-bridge setup --engine agy     # configure only one engine
npx omega-agent-bridge setup --migrate-legacy # copy flat agy accounts into the new layout
npx omega-agent-bridge setup --json
```

Setup never installs, upgrades, deletes, or enables writes.

Check the machine at any time:

```bash
npx omega-agent-bridge doctor
npx omega-agent-bridge doctor --json
```

## Quick start

The safe default is a read-only planning pass followed by an explicit approval:

```bash
# 1. Plan only. No execution job can write.
npx omega-agent-bridge run --spec ./examples/multi-engine-run.spec.json --plan-only --json

# 2. Inspect the plan and the workspace.
npx omega-agent-bridge show-run --run-id <run-id> --json

# 3. Approve write execution for this run and continue.
npx omega-agent-bridge resume --run-id <run-id> --allow-write --json
```

`allow_write: true` in a spec declares that the work may need to write. It is not approval by itself. The CLI always requires `--allow-write` on `run` or `resume` before a write-capable job is dispatched.

A basic spec:

```json
{
  "goal": "Add a health endpoint and verify it locally.",
  "workspace": "./my-service",
  "constraints": [
    "Do not touch deployment files.",
    "Keep edits minimal."
  ],
  "success_criteria": [
    "A health endpoint exists.",
    "Relevant tests or checks are run."
  ],
  "allow_write": true,
  "max_subjobs": 4,
  "timeout_minutes": 20,
  "model": "strongest",
  "effort": "highest",
  "report_format": "full"
}
```

## Engines and routing

`agy` remains the default engine, so existing specs keep working. A spec can route each phase independently:

| Field | Meaning | Default |
|---|---|---|
| `engine` | Default execution engine for jobs | `agy` |
| `planning_engine` | Engine that produces the plan | `engine` |
| `review_engine` | Engine that performs the final review, or `auto` | `engine` |
| `allowed_engines` | Engines a plan may assign jobs to | `[engine]` |
| `fallback_engines` | Engines allowed on an exhausted account pool | `[]` |
| `max_accounts_per_engine` | Account cap used for rotation | `20` |

A planning response may assign each job an `engine`. The orchestrator rejects a plan that names an engine outside `allowed_engines`. `review_engine: "auto"` picks the first allowed engine that differs from the execution engine, which gives an independent cross-engine review by default.

Example:

```json
{
  "engine": "agy",
  "planning_engine": "agy",
  "review_engine": "claude",
  "allowed_engines": ["agy", "claude", "codex"]
}
```

CLI overrides are available on `run` and `resume`:

```bash
npx omega-agent-bridge run --spec ./spec.json \
  --engine claude \
  --planning-engine codex \
  --review-engine agy \
  --allowed-engines agy,claude,codex
```

There is no implicit model or engine downgrade. A cross-engine fallback happens only when `fallback_engines` is explicitly configured and the failure is an exhausted account pool; the change is recorded in `runtime.fallbackFrom` and `runtime.fallbackReason`.

### Model and effort policy

- `model: "strongest"` asks the adapter to use the strongest model the engine advertises.
- Explicit model names are validated against the engine's advertised catalog.
- `effort: "highest"` uses the highest adjustable level the selected model actually offers.
- A requested runtime that cannot be verified fails the job instead of silently using a provider default.
- Each job records the requested model and effort, the selected and confirmed model, the effective effort, the account, and a `verified` flag in `run.json`.

## Accounts

Each engine can use up to **20 isolated account profiles by default**, configurable with `max_accounts_per_engine`. Profiles live under the state directory:

```text
~/.omega-agent-bridge/
└── accounts/
    ├── agy/
    │   ├── account-01/
    │   ├── account-02/
    │   └── ...
    ├── claude/
    │   ├── account-01/
    │   └── ...
    └── codex/
        ├── account-01/
        └── ...
```

Each adapter isolates authentication with the engine's native mechanism:

| Engine | Isolation |
|---|---|
| `agy` | `USERPROFILE`, `HOME`, `HOMEDRIVE`, `HOMEPATH`, `GEMINI_DIR` |
| `claude` | `CLAUDE_CONFIG_DIR` |
| `codex` | `CODEX_HOME` |

### Account commands

```bash
# List every account with masking by default.
npx omega-agent-bridge account list
npx omega-agent-bridge account list --engine claude --json

# Show one account.
npx omega-agent-bridge account status agy:account-01

# Start the engine's interactive login for one account.
npx omega-agent-bridge account login claude:account-02

# Copy legacy flat agy profiles into accounts/agy without touching the originals.
npx omega-agent-bridge account migrate --dry-run
npx omega-agent-bridge account migrate

# Remove one profile explicitly.
npx omega-agent-bridge account prune codex:02 --yes

# Clear stored session history while keeping authentication.
npx omega-agent-bridge account clean claude:02 --sessions
```

Account references accept `engine:id` or a bare ID for the default execution engine. A spec may also use an absolute path for a custom `agy` profile. Emails are masked unless `--show-emails` is passed.

### Rotation and quota

- Without a pinned account, the adapter rotates across authenticated, non-ignored profiles for that engine.
- A quota or rate-limit failure moves to the next account and records the account actually used.
- If the whole pool is exhausted, the error `all_accounts_exhausted` is returned. The bridge stops rather than silently reusing another pool.
- An explicit `account` pin limits the run to that profile.
- Cooldown state is stored as non-secret health metadata, not credentials.

## Skills

The repository ships one skill source and generates controller-specific variants at build time:

- Source: [`skills/omega-agent-bridge/SKILL.md`](skills/omega-agent-bridge/SKILL.md)
- Codex: [`skills/codex/omega-agent-bridge/SKILL.md`](skills/codex/omega-agent-bridge/SKILL.md)
- Claude: [`skills/claude/omega-agent-bridge/SKILL.md`](skills/claude/omega-agent-bridge/SKILL.md)
- Antigravity: [`skills/antigravity/omega-agent-bridge/SKILL.md`](skills/antigravity/omega-agent-bridge/SKILL.md)

Copy the variant for your controller into its skills directory, or point the controller at this repository. The skill instructs the controller to act as architect, approve writes explicitly, and verify the result instead of trusting the bridge blindly.

## Run storage

By default, state is written to:

- Windows: `%USERPROFILE%\.omega-agent-bridge`
- macOS/Linux: `~/.omega-agent-bridge`

Each run stores:

- the normalized spec
- job states and routing decisions
- per-job prompt and response files
- raw engine logs
- the final structured report and runtime verification data

```text
.omega-agent-bridge/
├── config.json
├── accounts/<engine>/<account-id>/
└── runs/<run-id>/
    ├── run.json
    ├── artifacts/
    └── logs/
```

If a run uses a non-default state directory, pass `--state-dir <path>` to `status`, `resume`, `show-run`, `list-runs`, or `cancel`.

## Commands

```bash
omega-agent-bridge setup            # guided first-run onboarding
omega-agent-bridge doctor           # check state, engines, binaries, accounts
omega-agent-bridge run              # create a run from a JSON spec
omega-agent-bridge resume           # continue a pending or interrupted run
omega-agent-bridge status           # compact run status
omega-agent-bridge show-run         # full stored run document
omega-agent-bridge list-runs        # list known runs
omega-agent-bridge cancel           # request graceful cancellation
omega-agent-bridge account ...      # list, status, login, migrate, prune, clean
```

`run` and `resume` exit non-zero when the final state is `failed` or `cancelled`. Use `--json` for machine-readable output.

## Safety model

Read-only is the default. Planning and review jobs never write. A write-capable job requires all of the following:

1. `allow_write: true` in the spec
2. a plan that marks the job as write-capable
3. `--allow-write` on the current `run` or `resume` invocation

The approval is recorded on the run and never carries over to another run.

Important limits:

- **Sequential writers only.** Write-capable jobs run one at a time with exclusive workspace access. Parallel writer dispatch and automatic integration are disabled.
- **Directory copies are not a sandbox.** An agent started with auto-approved permissions retains host-level filesystem access. Run only against workspaces you trust, keep secrets out of prompts and logs, and prefer narrow workspaces over broad root access.
- **Read parallelism.** Independent read-only jobs may run concurrently, up to ten workers.
- **No recursive delegation.** Executor agents do not invoke the bridge or other agents. The central orchestrator is the only router.
- **No secret handling.** Logins are interactive and belong to the user. The bridge stores non-secret health metadata, not credentials.

## Controller integration

When invoking the bridge from a parent agent, CI pipeline, or script, pass `--json`:

```bash
npx omega-agent-bridge run --spec ./spec.json --plan-only --json
npx omega-agent-bridge resume --run-id <run-id> --allow-write --json
```

The JSON summary includes the run state, job counts, the final report, and per-job runtime data. Use `show-run --json` when the controller needs the complete job list and routing details.

Recommended controller loop:

1. Write a spec with observable success criteria.
2. Run with `--plan-only` and inspect the plan.
3. Approve writes only for the current run.
4. After completion, inspect the diff and run the checks yourself.
5. Report what was verified, including any fallback or unverified runtime.

## Development

```bash
npm run typecheck
npm test
npm run build
```

`npm run build` cleans `dist`, regenerates the controller skill variants, and compiles TypeScript.

## Smoke test

For one real but harmless local run against a temporary copied fixture:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-smoke-test.ps1 -Build
```

The script copies `examples/smoke-workspace-fixture` to a temp folder, generates a temporary spec, and runs the bridge against that copy so the tracked repository files stay clean.

## Roadmap

- optional long-lived daemon mode
- richer policy controls per subjob
- remote status streaming
- GitHub issue/PR automation hooks
