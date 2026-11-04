# Omega Agent Bridge — Multi-Engine Design

Status: Draft for review  
Date: 2026-11-04  
Owner: OmegaProjct

---

## 1. Summary

Omega Agent Bridge is a local orchestration CLI that delegates bounded engineering work to one or more CLI agents:

- `agy` — Antigravity CLI (Google/Gemini)
- `claude` — Claude Code CLI (Anthropic)
- `codex` — Codex CLI (OpenAI)

A controller agent (Codex, Claude, Antigravity, or a script) defines the goal, constraints, and success criteria. The bridge plans the work, routes jobs to engines and isolated accounts, executes them, runs an independent cross-engine review when configured, and returns a structured, verified report.

The controller remains accountable. The bridge never replaces the final human or controller audit.

---

## 2. Goals

- **Multi-engine:** `agy`, `claude`, and `codex` are first-class execution engines.
- **Multi-account:** up to 20 isolated profiles per engine (60 total by default), with automatic rotation.
- **Cross-engine:** plan with one engine, execute with another, review with a third.
- **Backward compatible:** `engine: "agy"` stays the default; existing specs and CLI flags keep working; all 70 existing tests must pass.
- **Verified reporting:** report the actual engine, model, effort, account, and verification status for every job.
- **Safe by default:** read-only planning/review, explicit write opt-in, no silent model or engine downgrade.
- **Portable:** Windows, macOS, and Linux; no absolute user paths or personal data in docs, skills, or commits.

---

## 3. Non-goals

- No remote or cloud execution. The bridge runs local CLIs.
- No recursive agent-to-agent delegation. Agents do not invoke the bridge themselves; the central orchestrator routes work.
- No parallel writers. Write-capable jobs stay strictly sequential.
- No secret vault. Accounts use the CLIs' native authentication.
- No guarantee of sandboxing. The `--dangerously-*` flags grant host-level access by design.
- No automatic cross-engine fallback unless explicitly configured.

---

## 4. Naming

| Thing | Name |
|---|---|
| Product | Omega Agent Bridge |
| CLI binary | `omega-agent-bridge` |
| npm package | `omega-agent-bridge` |
| Skill | `omega-agent-bridge` |
| GitHub repo | `OmegaProjct/omega-agent-bridge` |
| Local development folder | `Github Omega Agent Bridge` |
| State dir | `%USERPROFILE%\.omega-agent-bridge` / `~/.omega-agent-bridge` |

The product, package, repo, and skill never use an “Open” prefix.

---

## 5. Architecture

```text
Controller (Codex / Claude / Antigravity / script)
        │
        ▼
CLI (run / resume / status / show-run / account / doctor)
        │
        ▼
Orchestrator
  ├─ Planning phase
  ├─ Execution phase (sequential writers, parallel read-only jobs)
  ├─ Cross-review phase (optional different engine)
  └─ Final report
        │
        ▼
AdapterRegistry
  ├─ AgyAdapter
  ├─ ClaudeAdapter
  └─ CodexAdapter
        │
        ▼
AccountStore
  └─ accounts/<engine>/<account-id>/
        │
        ▼
Local CLIs: agy / claude / codex
```

Key components:

- **CLI:** argument parsing, spec loading, JSON output, exit codes.
- **Orchestrator:** run state machine, job scheduling, review cycles, cancellation, resume.
- **AdapterRegistry:** creates the adapter for each engine and exposes capabilities.
- **Adapters:** build CLI arguments, spawn processes, parse structured output, verify runtime.
- **AccountStore:** discovers profiles, isolates auth env, rotates accounts, persists non-secret health.
- **ModelPolicy:** per-engine model/effort selection and verification rules.
- **Store:** atomic run persistence, artifacts, logs.

---

## 6. Engines

| Engine | CLI | Auth isolation | Read-only mode | Write mode | Structured output |
|---|---|---|---|---|---|
| `agy` | `agy` | `USERPROFILE`, `HOME`, `HOMEDRIVE`, `HOMEPATH`, `GEMINI_DIR` | Best available; otherwise prompt-level restriction | `--dangerously-skip-permissions` | `--output-format stream-json` |
| `claude` | `claude` | `CLAUDE_CONFIG_DIR` | `--permission-mode plan` | `--permission-mode bypassPermissions` or `--dangerously-skip-permissions` | `--output-format json`, optional `--json-schema` |
| `codex` | `codex` | `CODEX_HOME` | `--sandbox read-only` | `--sandbox workspace-write` or `--dangerously-bypass-approvals-and-sandbox` | `codex exec --json`, optional `--output-schema` and `--output-last-message` |

Verified locally on 2026-11-04:

- Claude Code `2.1.295`
- Codex CLI `0.106.0`
- `agy` was not in `PATH`; live agy tests need the binary or mocks.

### 6.1 Adapter contract

```ts
interface AgentAdapter {
  readonly name: EngineName;
  readonly capabilities: EngineCapabilities;
  checkAuth(account: AccountRef): Promise<AuthStatus>;
  run(invocation: AgentInvocation): Promise<AgentResult>;
}
```

`AgentInvocation` carries:

- prompt
- workspace
- timeout
- log path
- run label
- `canWrite`
- model / effort
- account reference
- optional JSON schema

`AgentResult` carries:

- raw/combined output
- exit code
- duration
- `AgentRuntime`

`AgentRuntime` carries:

- engine
- requested/selected/effective model
- requested/effective effort
- model/effort verification flags
- account id
- fallback metadata

### 6.2 Adapter rules

- Never trust the executor's self-report. Parse and validate structured output against the existing zod schemas.
- A model or effort mismatch must stop the job; never silently accept a provider default.
- A JSON parse failure must fail the job; never fall back to a stale transcript.
- Stderr and partial stdout must be preserved in logs.
- Process timeouts must kill the child process tree, not only the direct child.

---

## 7. Accounts

### 7.1 Layout

```text
%USERPROFILE%\.omega-agent-bridge\
├─ config.json
├─ account-health.json
├─ accounts\
│  ├─ agy\
│  │  ├─ account-01\
│  │  ├─ account-02\
│  │  └─ ... up to account-20\
│  ├─ claude\
│  │  ├─ account-01\
│  │  └─ ... up to account-20\
│  └─ codex\
│     ├─ account-01\
│     └─ ... up to account-20\
└─ runs\
   └─ <run-id>\
```

Each account directory is the engine's isolated config/home:

- `agy`: a full isolated home with `.gemini/`
- `claude`: the `CLAUDE_CONFIG_DIR`
- `codex`: the `CODEX_HOME`

Only authentication material lives there. `account-health.json`, `run.json`, logs, skills, and commits never contain tokens.

### 7.2 Account IDs

- Default: `account-01` … `account-20`, zero-padded and naturally sortable.
- Custom labels are allowed: `work-01`, `max-07`, etc.
- Validation: `^[a-z0-9][a-z0-9_-]{0,31}$`.
- Maximum 20 per engine by default (`maxAccountsPerEngine`), configurable.
- More than the cap: rotation ignores the extra directories and `account list` marks them as `ignored`; nothing is deleted automatically.

### 7.3 CLI

```bash
omega-agent-bridge account login agy:account-03
omega-agent-bridge account login claude:account-07
omega-agent-bridge account login codex:account-12

omega-agent-bridge account list
omega-agent-bridge account status claude:account-07
omega-agent-bridge account prune agy:account-03 --yes
omega-agent-bridge account migrate --from ~/.omega-agent-bridge/accounts
```

Spec:

```json
{
  "engine": "agy",
  "account": "agy:account-03",
  "review_engine": "claude"
}
```

CLI override:

```bash
omega-agent-bridge run --spec spec.json --engine claude --account claude:account-07 --json
```

A bare ID is used as-is against the default execution engine. Prefer the fully
qualified `engine:id` form when more than one engine is in play.

### 7.4 Rotation and failover

Default strategy: least-recently-used among authenticated accounts that are not in cooldown.

| Event | Behavior |
|---|---|
| Quota or HTTP 429 | Mark cooldown (parse reset time if available, otherwise 15 minutes); try next account. |
| Auth error | Mark `auth_required`; skip account; try next account. |
| Invalid JSON | Fail the job; no account rotation. |
| Timeout | Fail the job; no account rotation. |
| Model mismatch | Fail the job; no fallback. |
| All accounts exhausted | Fail with `all_accounts_exhausted`; stop the run. |
| Explicit `--account` | Pin the account; no rotation. |
| Explicit `fallback_engines` | Try the next engine after all accounts of the current engine are exhausted. Off by default. |

Health state is persisted in `account-health.json`:

```json
{
  "agy:account-01": {
    "lastUsedAt": "<timestamp>",
    "cooldownUntil": null,
    "authStatus": "ok",
    "lastError": null
  }
}
```

No emails, tokens, or secrets.

### 7.5 Concurrency

- Write-capable jobs: strictly sequential, one workspace.
- Read-only jobs: up to 10 concurrent workers.
- 20 accounts do not mean 20 parallel writers.
- Account health updates must be serialized or atomic to avoid races between parallel read-only jobs.

### 7.6 Migration

Existing agy profiles at `~/.omega-agent-bridge/accounts/account-1..3` remain valid.

`account migrate` copies them to `accounts/agy/account-01..03` and leaves the originals untouched. The old tool is deprecated after migration. A `--dry-run` flag shows the plan first.

### 7.7 Disk and security

- Codex `CODEX_HOME` can grow large; use `codex exec --ephemeral` for runs.
- Claude config dirs can accumulate sessions; add `account clean --sessions`.
- `account prune` removes a profile only with `--yes`.
- Account directories contain credentials; restrict them to the current user with
  OS permissions where practical.
- On Windows, optional `icacls` hardening to the current user.
- The state directory is outside the repository and is gitignored.

### 7.8 Onboarding

A first-run wizard makes the bridge usable without reading the full documentation:

```bash
omega-agent-bridge setup
```

The wizard is idempotent and resumable. It never deletes anything and never asks
for passwords, OAuth codes, or tokens in the bridge's own prompt.

Steps:

1. **Check the state directory.** Create `~/.omega-agent-bridge` if needed, verify
   it is writable, and confirm it is outside the current repository.
2. **Detect engines.** Probe `agy`, `claude`, and `codex` on `PATH`, then check the
   documented binary override and common install locations. Report version,
   resolved path, and status. Missing engines are skipped, not installed silently.
3. **Select engines.** Check all engines by default and let `--engine` limit
   setup to one. Accept an explicit binary path for an engine that is installed
   but not on `PATH`.
4. **Prepare the first account per selected engine.** Default ID `account-01`.
   Print the exact login command and launch the CLI's interactive login in the
   user's terminal. Never capture credentials.
5. **Verify authentication.** Re-read the account metadata after login. A failed
   login is reported; setup continues with the other engines.
6. **Legacy migration.** With `--migrate-legacy`, show the plan and copy old flat
   agy accounts to `accounts/agy/account-01..N`. Originals stay.
7. **Write config.** Persist enabled engines, optional binary paths, account cap,
   rotation strategy, and cooldown. The config is local state and is never
   committed.
8. **Report health.** Exit non-zero only if no requested engine is usable, and
   print `doctor` as the verification step.
9. **Print next steps.** Show `doctor`, `account list`, and a read-only
   `run --plan-only` command.

Flags:

```text
setup [--engine <engine>] [--dry-run] [--no-login] [--migrate-legacy] [--json]
```

- `--engine` limits setup to one engine.
- `--dry-run` prints the plan without creating directories or launching logins.
- `--no-login` creates the layout and config but does not start interactive login.
- `--migrate-legacy` includes the legacy agy migration step.
- `--json` emits a machine-readable summary for scripts.

Rules:

- Setup is not a write run and does not need write approval.
- Setup never installs, upgrades, or removes a CLI.
- Setup never deletes an account directory.
- Setup redacts account emails in its output and JSON summary.
- Re-running setup preserves configured binary paths, enables detected engines,
  and never deletes an account directory.
- A missing engine is a warning, not a fatal error, unless the user explicitly
  requested that engine.

---

## 8. Orchestration

### 8.1 Run spec

```json
{
  "goal": "Refactor the invoice service and add tests.",
  "workspace": "./my-service",
  "constraints": [
    "Do not change public API signatures.",
    "Do not touch deployment files."
  ],
  "success_criteria": [
    "All invoice tests pass.",
    "No behavior change for existing endpoints."
  ],
  "allow_write": true,
  "max_subjobs": 4,
  "timeout_minutes": 25,
  "engine": "agy",
  "planning_engine": "agy",
  "review_engine": "claude",
  "allowed_engines": ["agy", "claude", "codex"],
  "account": "agy:account-03",
  "model": "strongest",
  "effort": "highest",
  "review_pass_limit": 2,
  "report_format": "full",
  "max_accounts_per_engine": 20
}
```

New fields:

- `engine`: default execution engine.
- `planning_engine`: optional; defaults to `engine`.
- `review_engine`: optional; defaults to `engine`. `"auto"` selects an available engine different from the execution engine.
- `allowed_engines`: optional allowlist for planner-assigned jobs.
- `fallback_engines`: optional explicit cross-engine fallback list; empty by default.
- `account`: optional account pin (`engine:id` or `id`).
- `max_accounts_per_engine`: optional per-run rotation cap; defaults to the config value.

### 8.2 Phases

1. **Planning** — read-only. The planner inspects the workspace and returns jobs. Each job may include an `engine` field, constrained by `allowed_engines`.
2. **Execution** — write jobs sequential; read-only jobs parallel up to 10. Each job uses its assigned engine and account pool.
3. **Cross-review** — read-only. If `review_engine` differs from the execution engine, the review runs with a different adapter and account pool.
4. **Final audit** — the controller inspects the diff and runs tests independently. The bridge report is advisory.

### 8.3 No recursive delegation

The orchestrator is the only router. An executor agent may suggest follow-up work, but it does not invoke the bridge or another agent directly. This avoids infinite loops, runaway costs, and unclear responsibility.

### 8.4 Plan-only and write approval

A write-capable run must be split into a visible plan and an approved execution:

1. `run --plan-only` performs planning only and stops in `pending`.
2. The controller shows the plan, target engines, accounts, risks, and assumptions to
   the user.
3. The user approves write execution for this specific run.
4. `resume --run-id <id> --allow-write` records the approval and continues.

The bridge refuses to dispatch a write job unless the run has a recorded approval.
`allow_write: true` in a spec is a declaration, not an approval. The record contains
a timestamp and the source (`user` or `ci`), never an email address or token.

For non-interactive use, `run --spec ... --allow-write` is allowed only when the
caller has already obtained approval. CI must pass the flag explicitly; there is no
environment variable that silently enables writes.

---

## 9. Permissions and safety

`canWrite` must map to real CLI flags, not prompt text.

| Phase | `canWrite` | agy | claude | codex |
|---|---|---|---|---|
| Planning | false | least-privilege mode; prompt restriction if no flag | `--permission-mode plan` | `--sandbox read-only` |
| Read-only execution | false | least-privilege mode | `--permission-mode plan` | `--sandbox read-only` |
| Write execution | true | `--dangerously-skip-permissions` | `--permission-mode bypassPermissions` | `--sandbox workspace-write` (and explicit approval policy) |
| Cross-review | false | least-privilege mode | `--permission-mode plan` | `--sandbox read-only` |

Rules:

- Read-only is the default. `allow_write: true` must be explicit.
- The skill requires explicit user approval before any write-capable run.
- `autoApprove` is replaced by `canWrite`. It is only true for approved write jobs and must never be set for planning or review.
- `--dangerously-skip-permissions` and `--dangerously-bypass-approvals-and-sandbox` grant host access. They are not a sandbox.
- For untrusted repositories, run inside a disposable worktree, container, or VM.
- Never delegate secrets, credentials, production deployments, or destructive commands.
- Review generated code independently; the executor's self-report is not proof.

---

## 10. Model and effort policy

Per-engine `ModelPolicy`:

```ts
interface ModelPolicy {
  resolveModel(input: {
    requested: string | null;
    catalog?: string;
    now: Date;
  }): Promise<SelectedModel>;
  resolveEffort(input: {
    requested: string;
    capabilities: EngineCapabilities;
  }): Promise<SelectedEffort>;
}
```

### 10.1 agy

- Keep the existing `agy models` + `/effort` probing.
- Keep the strict model-confirmation behavior.
- Move the personal Gemini-only date out of the default code path. Make it configurable via `config.json` or `OMEGA_AGY_GEMINI_ONLY_FROM`; document it as a local access policy, not a universal rule.
- Preserve existing tests and behavior when the policy is unset.

### 10.2 claude

- `model: "strongest"` resolves through the adapter's catalog or the CLI's documented
  strongest alias. Do not hardcode family names in the skill or in defaults that can
  go stale.
- `effort`: `low`, `medium`, `high`, `xhigh`, `max` map directly to `--effort`.
- Use `--output-format json` and, where possible, `--json-schema` generated from the existing zod schemas.
- Verify the actual model from the CLI result if the field is present; otherwise mark `verified: false`.

### 10.3 codex

- `model: "strongest"` → configured model or the CLI default; do not invent model names.
- Effort via `-c model_reasoning_effort="<level>"`; verify valid values against the installed CLI.
- Use `codex exec --json` for events and `--output-last-message` for the final structured response.
- Use `--output-schema` generated from the existing zod schemas.
- Verify the actual model from the JSONL events if available; otherwise mark `verified: false`.

### 10.4 No silent downgrade

- A missing model, mismatched confirmation, or unsupported effort stops the job.
- Automatic account rotation is only allowed for quota errors within the same engine's account pool.
- Cross-engine fallback requires explicit `fallback_engines`.
- Every fallback is recorded in `runtime.fallbackFrom` and `runtime.fallbackReason`.

### 10.5 Legacy agy quota fallback

The existing agy adapter may fall back to a different model after an Opus quota
error. The 70-test baseline covers this behavior, so it is preserved for
backward compatibility:

- It applies only to `agy`.
- It applies only after a quota error, never after a parse error, timeout, or
  model mismatch.
- It is recorded in `runtime.fallbackFrom` and `runtime.fallbackReason`.
- It is reported in the run summary and the controller's final report.
- It can be disabled with `legacyAgyQuotaFallback: false`.
- New engines do not inherit it. Claude and Codex fail on quota after exhausting
  the account pool unless `fallback_engines` is explicit.

This is a recorded compatibility fallback, not a silent downgrade. The skill must
surface it rather than hiding it.

---

## 11. CLI and output contracts

### 11.1 Commands

```text
omega-agent-bridge setup [--engine <engine>] [--dry-run] [--no-login] [--migrate-legacy] [--json]
omega-agent-bridge run --spec <path> [--engine <engine>] [--planning-engine <engine>] [--review-engine <engine|auto>] [--allowed-engines <list>] [--account <ref>] [--plan-only] [--allow-write] [--json]
omega-agent-bridge resume --run-id <id> [--engine <engine>] [--account <ref>] [--allow-write] [--json]
omega-agent-bridge status --run-id <id> [--json]
omega-agent-bridge show-run --run-id <id> [--json]
omega-agent-bridge list-runs [--json]
omega-agent-bridge cancel --run-id <id> [--json]
omega-agent-bridge account login <engine:id>
omega-agent-bridge account list [--json] [--show-emails]
omega-agent-bridge account status <engine:id> [--json]
omega-agent-bridge account prune <engine:id> --yes [--json]
omega-agent-bridge account migrate [--from <path>] [--dry-run] [--json]
omega-agent-bridge account clean <engine:id> --sessions [--json]
omega-agent-bridge doctor [--json]
```

### 11.2 Output shapes

- `run`, `resume`, `status`, `list-runs` → compact summary:
  - `run_id`, `state`, `workspace`, `state_dir`
  - `completed_jobs`, `failed_jobs`, `pending_jobs`
  - `summary`, `final_report`
  - `agent_runs[]` with `job_id`, `kind`, `engine`, `runtime`
- `show-run` → full `BridgeRun` with `jobs[]`, `changedFiles`, `checksRun`, `finalReport`.
- The skill must use `show-run` for job-level details, not assume `run --json` contains them.

### 11.3 Exit codes

- `0`: completed
- non-zero: failed, cancelled, or incomplete
- `doctor`: non-zero if a required engine/account is unavailable

---

## 12. Storage

```text
~/.omega-agent-bridge/
├─ config.json
├─ account-health.json
├─ accounts/
│  ├─ agy/<id>/
│  ├─ claude/<id>/
│  └─ codex/<id>/
└─ runs/<run-id>/
   ├─ run.json
   ├─ artifacts/
   └─ logs/
```

- Atomic run writes with a serialized save queue.
- Artifacts contain prompts and responses; logs contain CLI output.
- Retention: keep runs by default; `runs clean --older-than <days>` optional.
- No tokens or passwords in run metadata.

---

## 13. Security and privacy

### 13.1 Threat model

- Executor CLIs can read/write the host filesystem when auto-approval is enabled.
- Directory copies are not a security boundary.
- Prompt injection from repository content can influence the executor.
- Logs and prompts may contain sensitive code or secrets.
- Account directories contain OAuth credentials.

### 13.2 Rules

- Read-only by default; explicit write opt-in.
- Use a disposable worktree/VM for untrusted code.
- Never pass secrets in prompts; redact known account emails from logs where feasible.
- Mask account emails in `account list` by default.
- Keep the state directory out of the repository.
- Use GitHub noreply for commits.
- No PII, tokens, or personal paths in skills, docs, examples, or tests.
- The skill must warn that review is advisory, not a security audit.

---

## 14. Testing and CI

### 14.1 Test layers

- **Unit:** adapters with mocked `spawn`/`execFile`; success, invalid JSON, timeout, process error, model mismatch.
- **AccountStore:** 20-account cap, legacy migration, masking, LRU, cooldown, auth skip, all-exhausted.
- **ModelPolicy:** per-engine selection, effort mapping, strict failure.
- **Orchestrator:** engine routing, per-job engine, cross-review, fallback, backward compatibility.
- **Contract:** zod schemas and CLI JSON shapes.
- **Integration:** fake CLI binaries (Node scripts) for each engine; no real auth.

### 14.2 Quality gate

```bash
npm run typecheck
npm test
npm run build
```

- The original 70 baseline tests must continue to pass.
- The multi-engine suite adds routing, account, approval, fallback, and onboarding
  coverage.
- CI: Node 24 on Ubuntu; verify locally on Windows and macOS.

---

## 15. Migration and rollout

1. Copy the current `main` baseline into `Github Omega Agent Bridge`.
2. Add `DESIGN.md` and the new skill.
3. Implement the account store and adapter registry behind a feature flag; keep agy as the default.
4. Add Claude and Codex adapters with mocked tests.
5. Add cross-engine review and per-job routing.
6. Verify the full suite.
7. Scan the new tree and history for PII, secrets, absolute paths, and model names
   that should not ship. Do not copy `backup-main` or any old feature branch.
8. Delete the old repository and create `OmegaProjct/omega-agent-bridge` with a fresh history and GitHub noreply author.
9. Push, enable CI, publish to npm when green.

---

## 16. Skill

One source of truth, generated variants:

```text
skills/omega-agent-bridge/
├─ SKILL.md
└─ references/
   ├─ engines.md
   ├─ accounts.md
   ├─ security.md
   ├─ troubleshooting.md
   └─ onboarding.md
```

The skill is controller-agnostic. It describes the role, the approval protocol, the
spec template, engine and account selection, the audit checklist, failure handling,
and the reporting contract. It contains:

- no email addresses,
- no absolute user paths,
- no hardcoded model names,
- no personal dates or one-off access windows.

Generated variants for Codex, Claude, and Antigravity are byte-identical copies of
the source plus a controller-specific frontmatter block if required. The build
script writes them; no variant is edited by hand.

The skill's command examples use `omega-agent-bridge` without a machine-specific
path. Local development entry points belong in the repository README, not in the
skill.

---

## 17. Open questions

- Does `agy` expose a true read-only/permission mode? If not, how do we enforce read-only beyond prompt instructions?
- Which fields in Claude's JSON output confirm the actual model and effort?
- Which fields in Codex's JSONL events confirm the actual model and effort?
- Do we need per-account plan/model capability metadata (e.g., Pro vs Max)?
- Should `review_engine: "auto"` prefer a stronger or a different engine?
- Should cross-engine fallback ever be automatic, or always explicit?
- Do we keep the legacy flat agy account layout indefinitely or migrate it once?
