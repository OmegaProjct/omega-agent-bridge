# Troubleshooting

Diagnose in this order:

1. Is the bridge itself reachable and healthy?
2. Is the requested engine installed and resolvable?
3. Is the account authenticated and outside cooldown?
4. Is the workspace correct and writable when needed?
5. Did the CLI produce a valid structured result?
6. Did the bridge validate and persist it correctly?

Run with `--json` and keep the run ID. Most answers are in
`show-run --run-id <id> --json` and the job logs, not in the terminal summary.

## 1. Quick diagnosis

```bash
omega-agent-bridge doctor --json
omega-agent-bridge account list --json
omega-agent-bridge status --run-id <run-id> --json
omega-agent-bridge show-run --run-id <run-id> --json
```

Check:

- `state` — `completed`, `failed`, `cancelled`, `running`, `pending`
- `error` — top-level failure
- `jobs[].status` and `jobs[].error`
- `jobs[].runtime` — engine, model, effort, account, `verified`
- `jobs[].logPath`, `promptPath`, `responsePath`
- `changedFiles` and `checksRun`

## 2. Error codes

| Code | Meaning | Action |
|---|---|---|
| `engine_not_found` | CLI binary not resolvable | Install it or set the engine-specific binary flag/env var |
| `engine_auth_required` | CLI reports no valid login for the account | Ask the user to log in interactively |
| `account_not_found` | Account ID does not exist | Create it with `account login` |
| `account_pinned_unavailable` | Pinned account is in cooldown or unauthenticated | Wait, re-authenticate, or unpin |
| `all_accounts_exhausted` | Every account in the pool is exhausted | Stop; wait for reset or add accounts |
| `quota_exhausted` | One account hit its quota | Same-engine rotation is allowed |
| `invalid_structured_output` | JSON missing or schema-invalid | Inspect the response artifact and log |
| `model_mismatch` | Effective model differs from requested | Stop; do not accept the default |
| `effort_mismatch` | Effective effort differs or was rejected | Stop; choose a supported level |
| `permission_denied` | CLI blocked an action | Check the permission mode; do not silently escalate |
| `timeout` | Invocation exceeded its budget | Inspect partial changes before retrying |
| `process_error` | Spawn failed or exited unexpectedly | Check the binary, arguments, and OS error |
| `workspace_invalid` | Workspace missing or not a directory | Fix the path |
| `workspace_dirty` | Write run started with uncommitted changes | Commit, stash, or explicitly accept |
| `state_dir_unwritable` | State directory cannot be written | Fix permissions or choose another state dir |
| `account_limit_reached` | More profiles than `maxAccountsPerEngine` | Remove extras or raise the cap |

## 3. Bridge-level problems

### `run --json` has no job details

The compact summary contains `agent_runs`, `final_report`, and `summary`. It does
not contain full job records. Use:

```bash
omega-agent-bridge show-run --run-id <run-id> --json
```

### `npx omega-agent-bridge` returns 404

The package is not published to the registry used by that `npx`. Use a local
install or the project's documented entry point. Do not assume a global package
exists.

### State directory is not writable

Check ownership and permissions. On Windows, check whether the directory is
controlled by another user or a sync tool. Do not run the bridge as administrator
just to work around permissions.

### Health file is locked or corrupted

- A parallel read-only job may be updating it. Retry after the run finishes.
- If it is corrupted, back it up, then let the bridge recreate it. Do not delete
  account directories.
- Health data is non-secret; losing it only loses cooldown and LRU hints.

### Account cap warning

Extra directories above `maxAccountsPerEngine` are ignored. Raise the cap in
`config.json` or remove the extras. The bridge never deletes them automatically.

### Cancellation does not stop the child

Verify that the adapter kills the process tree, not only the parent. On Windows,
a wrapper process may survive. Check the job log and terminate the remaining
process deliberately. Never start a second write run while an orphan may still be
writing.

### Windows path issues

- Long paths can exceed the legacy limit. Enable long paths or use a shorter
  workspace root.
- Quote paths with spaces in your own shell commands.
- The bridge uses argument arrays, so spaces are safe inside the bridge. Your
  manual reproduction commands still need quoting.
- Do not use `~` in JSON specs; resolve it or use a relative path.

### A run is stuck in `running`

- Check whether the process is still alive.
- Check the last log line and the job's `startedAt`.
- If the process is gone and the state was not updated, the run was interrupted.
- Mark it failed with the CLI if supported, then inspect the workspace before
  resuming.

## 4. `agy`

### Binary not found

`agy` may not be on `PATH`. Set the documented binary flag or environment
variable, or install it. Do not hardcode a machine-specific path in a spec.

### Not authenticated

Run the interactive login for the account. Verify with `account status`. Do not
paste OAuth codes into chat.

### Quota exhausted

Messages include `RESOURCE_EXHAUSTED`, `quota reached`, or `Resets in`.

- With rotation enabled, the bridge tries the next agy account.
- With a pinned account, the job fails by design.
- If every account is exhausted, the run stops with `all_accounts_exhausted`.
- Do not switch to another engine unless `fallback_engines` was explicitly set.

### Headless mode denies read-only tools

This is a known all-or-nothing permission behavior. Without the permission flag,
tools such as `git status` may be denied. With it, the agent gets broad access.

- For planning and review, prefer prompt-level restrictions and disclose the
  limitation.
- Do not claim the run was sandboxed.
- If a true read-only flag exists in the installed version, use it and record it.

### Model confirmation fails

The adapter compares the `init` event's model with the selected model. A mismatch
stops the job. Check the model catalog and the CLI version. Do not bypass the
check to make the run pass.

### Effort confirmation fails

The `/effort` probe must report the selected level. If the CLI does not support
the level, choose a supported one or fail. Do not silently drop effort.

### Invalid stream JSON

Any non-JSON line on the event stream stops the job. Inspect the log for CLI
banners, warnings, or partial writes. Do not accept a transcript from an earlier
attempt.

## 5. `claude`

### Binary not found

Verify `claude --version`. If it is not on `PATH`, set the documented binary flag
or environment variable.

### Authentication required

Ask the user to log in interactively. Do not request credentials. Verify the
account by running a trivial read-only prompt.

### `is_error` is true

The JSON envelope contains the error. Preserve it, inspect `result`, and report
the actual message. Do not treat a zero exit code as success.

### Permission mode rejected

Check the installed CLI's accepted modes:

```bash
claude --help
```

Use `plan` for read-only and `bypassPermissions` only for approved writes. Do not
fall back to a broader mode just because a flag was rejected.

### `--json-schema` rejected

- Validate that the schema is valid JSON.
- Keep it small; Windows argument limits apply.
- Prefer a file-based schema if the CLI supports it.
- If the CLI cannot accept the schema, fail the job unless the spec explicitly
  allows unvalidated output. Record the downgrade.

### Long prompt fails

Pass the prompt through stdin where supported. Do not truncate the prompt
silently. If truncation is unavoidable, fail with a clear error.

### Model or effort not available

- Confirm the model name with the CLI's own catalog or help.
- Confirm the effort level is supported.
- Fail the job. Do not let the CLI choose a default.
- Report `verified: false` when the effective setting cannot be confirmed.

### Config directory isolation looks incomplete

Some Claude Code versions create project-local files even with
`CLAUDE_CONFIG_DIR`. Check the workspace after a run. Report the leak; do not
assume full isolation.

### Rate limit or quota

- With rotation, try the next account in the same engine.
- With a pin, fail.
- Do not switch engines silently.

## 6. `codex`

### Binary not found on Windows

`codex` may be installed outside `PATH`. Use the documented binary flag or
environment variable. Do not assume `codex` resolves from a shell.

### `CODEX_HOME` not honored

- Confirm the environment variable is set for the child process, not only in your
  shell.
- Check that the account directory exists and is writable.
- Run `codex login status` with the same environment.

### Sandbox denies a needed write

- Confirm the job is actually a write job and was approved.
- Use `workspace-write`, not `danger-full-access`.
- Add only the specific extra root with `--add-dir`.
- Do not disable the sandbox to work around an unclear scope.

### `--output-schema` rejected

- Validate the schema file.
- Confirm the installed CLI supports the flag.
- Fail the job if structured output cannot be enforced; do not accept unvalidated
  text silently.

### JSONL parsing fails

- Stdout should be JSONL. Warnings usually go to stderr.
- Preserve unknown event types.
- Ignore blank lines.
- If a non-JSON line appears, record it and fail rather than skipping it silently.

### Final message file is empty

- Check `--output-last-message` path and permissions.
- Fall back to the last assistant message in the event stream.
- If neither exists, fail the job.

### `--skip-git-repo-check` confusion

Only use it when the workspace is intentionally not a git repository. It reduces
auditability. Prefer initializing a repository or using a worktree.

### Model or reasoning effort unsupported

- Confirm the model accepts the requested effort.
- Use the CLI's config override syntax exactly.
- Fail the job on rejection. Do not drop to a lower effort silently.

### Sessions accumulate on disk

Use `codex exec --ephemeral` for runs. Clean session history with
`account clean <ref> --sessions`. Keep authentication.

## 7. Cross-engine review problems

### Review engine unavailable

- If `review_engine` is pinned and unavailable, fail the review.
- If `"auto"`, pick another authenticated engine.
- If none is available, disclose that the review is not cross-engine. Do not
  pretend it is.

### Review disagrees with execution

- Treat `needs_followup` as a finding, not a failure of the bridge.
- Show the gaps to the user.
- A new write run needs new approval.
- Do not loop reviews until one passes.

### Review is too shallow

- Tighten the success criteria.
- Give the reviewer the diff and the verification commands.
- Use a different engine when available.
- Remember that review is advisory, not a security audit.

## 8. Recovery

### After a timeout

1. Read the log and the last event.
2. Check `git status` and `git diff`.
3. Preserve useful partial work.
4. Do not repeat destructive actions.
5. Start a new run only after the workspace state is understood.

### After a crash

1. Check the run state and the process list.
2. Inspect the state directory for a lock or partial write.
3. Verify the workspace.
4. Resume or restart deliberately.
5. Report what was preserved.

### After a suspected secret leak

1. Stop the run.
2. Preserve evidence.
3. Rotate the credential.
4. Remove the secret from logs and history if possible.
5. Report the incident. Do not rely on deletion alone.

## 9. Bug report contents

Include:

- bridge version and commit,
- engine and CLI version,
- operating system,
- the command shape with secrets removed,
- the run ID,
- the relevant error code,
- a redacted log excerpt,
- whether the account was pinned or rotated.

Do not include:

- tokens, cookies, or auth headers,
- account emails,
- full environment dumps,
- private source code that is not needed to reproduce,
- absolute personal paths.

## 10. Do not

- Do not bypass a model or effort check to make a run pass.
- Do not switch engines silently after an account failure.
- Do not delete account directories to "reset" authentication.
- Do not run a second write job while an orphan process may still be active.
- Do not paste raw logs into a public issue without review.
- Do not treat a green exit code as proof that the work is correct.
