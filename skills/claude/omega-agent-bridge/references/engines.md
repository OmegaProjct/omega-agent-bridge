# Engines

Reference for the adapter layer. Flags were verified against the locally installed
CLIs at design time. Re-check `--help` before relying on a flag in a new
environment; CLIs change.

## 1. Adapter contract

```ts
type EngineName = "agy" | "claude" | "codex";

interface EngineCapabilities {
  readOnlyMode: boolean;
  structuredOutput: boolean;
  jsonSchema: boolean;
  effortControl: boolean;
  accountIsolation: "home" | "config-dir" | "state-dir";
  maxPromptArgBytes: number | null;
}

interface AgentInvocation {
  prompt: string;
  workspace: string;
  timeoutMs: number;
  logPath: string;
  runLabel: string;
  canWrite: boolean;
  model: string | null;
  effort: string;
  account: string | null;
  responseSchema?: object;
}

interface AgentResult {
  rawOutput: string;
  combinedOutput: string;
  exitCode: number;
  durationMs: number;
  runtime: AgentRuntime;
}

interface AgentRuntime {
  engine: EngineName;
  requestedModel: string;
  requestedEffort: string;
  selectedModel: string;
  effectiveModel: string | null;
  effectiveEffort: string;
  effortAdjustable: boolean;
  verified: boolean;
  account: string | null;
  fallbackFrom?: string;
  fallbackReason?: string;
}

interface AgentAdapter {
  readonly name: EngineName;
  readonly capabilities: EngineCapabilities;
  checkAuth(account: string | null): Promise<AuthStatus>;
  run(invocation: AgentInvocation): Promise<AgentResult>;
}
```

Rules that apply to every adapter:

- Spawn with an argument array. Never build a shell command from spec input.
- Resolve the binary in this order: explicit CLI flag, engine-specific environment
  variable, `PATH`. Record which one was used.
- Prefer stdin for long prompts. Windows command lines are size-limited and a
  multi-kilobyte prompt can fail before the CLI starts.
- Enforce the timeout on the process tree, not only the direct child.
- Treat a zero exit code as necessary but not sufficient. Validate the structured
  result before accepting it.
- Preserve raw stdout, stderr, and the exit code in the job log.
- Never log environment variables or account directory contents.
- Never trust `changed_files` from the executor. Compute the real change set with
  git or a workspace snapshot.

## 2. Structured output

The bridge validates three response shapes:

| Phase | Schema | Required fields |
|---|---|---|
| Planning | `planningResponseSchema` | `summary`, `jobs[]` with `title`, `objective`, `success_criteria`, `can_write`, `priority`; optional `risks`, `assumptions` |
| Execution | `executionResponseSchema` | `summary`, `outcome` (`done` / `needs_followup` / `blocked`), optional `changed_files`, `checks_run`, `open_questions`, `follow_up_instructions` |
| Review | `reviewResponseSchema` | `summary`, `verdict` (`pass` / `needs_followup` / `blocked`), `checks_run`, `remaining_gaps`, `next_action` |

General parsing rules:

1. Prefer the CLI's structured envelope when it provides one.
2. Extract the model's message from the envelope.
3. If the message is plain text containing a fenced JSON block, use
   `extractJsonDocument` to recover the first valid document.
4. Validate with zod. A validation failure fails the job.
5. Do not scan old transcripts or previous responses for a valid document. That
   hides a failed invocation and can return stale work.
6. Store the unmodified response in the run artifact before parsing.

## 3. `agy`

### Invocation

```text
agy --print <prompt>
    --print-timeout <duration>
    --log-file <path>
    --output-format stream-json
    --add-dir <workspace>
    --model <selected-model>
    [--effort <selected-effort>]
    [--dangerously-skip-permissions]
```

Current bridge behavior:

- `agy models` provides the model catalog.
- `/effort` with `--output-format json` probes the effort levels.
- The adapter confirms the selected effort by running `/effort` again and
  comparing the reported current value.
- The `init` event's model must match the selected model. A mismatch stops the
  job.

### Read-only mode

`agy`'s permission flag is all-or-nothing in the current bridge. Without it,
headless mode auto-denies tools, including read-only ones such as `git status` or
`grep`. With it, the agent gets broad host access.

Consequences:

- There is no verified read-only flag in the current adapter.
- Planning and review are only read-only by prompt instruction unless a
  least-privilege flag exists in the installed CLI version.
- Treat that as a residual risk and state it in the report.
- Do not claim that agy planning or review is sandboxed.

If a future CLI exposes a plan or read-only mode, map it to `canWrite: false` and
record the flag in `EngineCapabilities`.

### Account isolation

Set a full isolated home for the child process:

```text
USERPROFILE=<account-dir>
HOME=<account-dir>
HOMEDRIVE=<drive>
HOMEPATH=<path-without-drive>
GEMINI_DIR=<account-dir>/.gemini
```

`account` maps to a directory under `accounts/agy/`. A pinned absolute path is
supported for compatibility but is not used by the skill.

### Failure and rotation

- Quota detection: `RESOURCE_EXHAUSTED`, `quota reached`, `Resets in`.
- Quota rotates within the agy pool only.
- Invalid structured output, timeout, and model mismatch do not rotate.
- An interrupted attempt may already have changed files. Inspect before retrying.

## 4. `claude`

### Capabilities

- Print/headless mode: `-p`, `--print`.
- Structured output: `--output-format json` or `--output-format stream-json`.
- Schema validation: `--json-schema <schema>`.
- Permission modes: `acceptEdits`, `auto`, `bypassPermissions`, `manual`,
  `dontAsk`, `plan`.
- Effort: `--effort low|medium|high|xhigh|max`.
- Model: `--model <name-or-alias>`.
- Extra read paths: `--add-dir <dir>`.
- Account isolation: `CLAUDE_CONFIG_DIR`.
- Session control: `--continue`, `--resume <id>`.

### Read-only invocation

```text
claude -p <prompt>
       --output-format json
       --permission-mode plan
       --model <model>
       --effort <effort>
       --add-dir <workspace>
       [--json-schema <schema-json>]
```

`plan` is the read-only permission mode. Do not pass
`--dangerously-skip-permissions` for planning or review.

### Write invocation

```text
claude -p <prompt>
       --output-format json
       --permission-mode bypassPermissions
       --model <model>
       --effort <effort>
       [--json-schema <schema-json>]
```

`bypassPermissions` grants broad host access. Use it only after explicit write
approval. It is not a sandbox.

### Output envelope

Claude Code's JSON result typically includes:

- `type` / `subtype`
- `is_error`
- `result` — the assistant's final text
- `session_id`
- `usage`
- `total_cost_usd`
- `modelUsage` — per-model usage, keyed by model name

Parsing order:

1. If `is_error` is true, fail the job and preserve the envelope.
2. Take `result` as the message.
3. Extract and validate the bridge schema from `result`.
4. Do not assume `result` is bare JSON; it is often prose with a fenced block.

Runtime verification:

- `modelUsage` keys can confirm which model actually served the request.
- If multiple models appear (for example because of subagents), mark the runtime
  as `verified: false` unless the primary model is unambiguous.
- Effort is not reliably echoed. Treat effort as unverified unless the CLI
  provides an explicit confirmation.
- Never infer the effective model from the `--model` argument alone.

### Account isolation

Set `CLAUDE_CONFIG_DIR` to the account directory. Known quirk: Claude Code may
still create a project-local `.claude/` directory for some features. Test this
per version and document it; do not assume the config dir isolates every file.

### Prompt delivery

Prefer stdin when the prompt is large. On Windows, passing a long prompt as an
argument can exceed the command-line limit. The adapter should detect the limit
and fail clearly rather than truncate.

### Model and effort mapping

- `"strongest"` resolves through the adapter's catalog or the CLI's documented
  alias. Never invent a dated model name.
- `"highest"` maps to the highest supported effort level. If the installed CLI
  rejects it, fail; do not silently drop to a lower level.
- An unsupported model or effort must fail the job.

## 5. `codex`

### Capabilities

- Headless mode: `codex exec`.
- Event stream: `--json` (JSONL on stdout).
- Structured final message: `--output-last-message <file>`.
- Schema validation: `--output-schema <file>`.
- Working directory: `-C, --cd <dir>`.
- Sandbox: `--sandbox read-only|workspace-write|danger-full-access`.
- Approval policy: `-a, --ask-for-approval untrusted|on-failure|on-request|never`.
- Full bypass: `--dangerously-bypass-approvals-and-sandbox`.
- Ephemeral run: `--ephemeral` (no persisted session files).
- Model: `-m, --model`.
- Reasoning effort: config override, typically
  `-c model_reasoning_effort="<level>"`.
- Extra writable roots: `--add-dir`.
- Account isolation: `CODEX_HOME`.

### Read-only invocation

```text
codex exec
  --json
  --sandbox read-only
  -C <workspace>
  -m <model>
  -c model_reasoning_effort="<level>"
  --output-schema <schema-file>
  --output-last-message <message-file>
  --ephemeral
  -
```

The trailing `-` reads the prompt from stdin.

### Write invocation

```text
codex exec
  --json
  --sandbox workspace-write
  -C <workspace>
  -m <model>
  -c model_reasoning_effort="<level>"
  --output-schema <schema-file>
  --output-last-message <message-file>
  --ephemeral
  -
```

Add the approval policy using the installed CLI's supported position:

```text
-a never
```

`workspace-write` is the preferred write mode. `danger-full-access` and
`--dangerously-bypass-approvals-and-sandbox` are reserved for an explicitly
approved, externally sandboxed environment.

### Output handling

- Parse stdout as JSONL. Ignore blank lines.
- Preserve unknown event types; do not fail on additive event fields.
- Read the final message from `--output-last-message`. If the file is missing or
  empty, fall back to the last assistant message in the event stream.
- Validate the final message against the bridge schema.
- Do not treat a `turn.completed` event as proof that the task succeeded; inspect
  the message and the process exit code.

Runtime verification:

- Use session or turn metadata if it reports the model.
- If the event stream does not report the effective model, set
  `verified: false`. Do not infer it from `-m`.
- Reasoning effort is usually not echoed. Mark it unverified unless the CLI
  provides confirmation.

### Account isolation

Set `CODEX_HOME` to the account directory. Use `--ephemeral` for runs to avoid
accumulating session history in the login profile. Login profiles still hold
credentials and must be protected.

### Sandbox and approval notes

- `read-only` permits inspection without writes.
- `workspace-write` permits writes inside the workspace and configured roots.
- `danger-full-access` removes the sandbox. It is not the default and must be
  justified.
- `--skip-git-repo-check` is only acceptable when the workspace is intentionally
  not a git repository and the user accepts the reduced auditability.

## 6. Runtime verification matrix

| Engine | Model evidence | Effort evidence | Accept `verified: true` when |
|---|---|---|---|
| `agy` | `init.model` compared to selected model | `/effort` confirmation | Both match |
| `claude` | `modelUsage` keys or equivalent metadata | Usually absent | Model is unambiguous and matches; report effort as unverified |
| `codex` | Session/turn metadata if present | Usually absent | Reported model matches; otherwise `verified: false` |

Rules:

- A requested setting is not evidence of the effective setting.
- A mismatch is a hard failure, not a warning.
- `verified: false` belongs in the report. It is not a reason to omit the run.
- A fallback is only valid when it was explicitly configured. Record
  `fallbackFrom` and `fallbackReason`.

## 7. Prompt and schema delivery

- Prefer stdin for prompts and files for schemas.
- On Windows, avoid embedding a large JSON schema in an argument.
- Keep schemas generated from the zod definitions so they cannot drift.
- If a CLI rejects a schema, fail the job. Do not silently fall back to
  unvalidated text unless the adapter records that downgrade and the spec allows
  it.

## 8. Logging

Write to the job log:

- engine, account ID, and the exact flags used (not environment values),
- start and end time,
- exit code,
- stdout and stderr, clearly separated,
- parse or validation errors,
- the runtime record.

Do not write:

- tokens, cookies, auth headers, or keyring contents,
- full environment dumps,
- account email addresses unless explicitly requested.

Logs and artifacts are sensitive because they contain source code and prompts.
Keep them outside the repository.
