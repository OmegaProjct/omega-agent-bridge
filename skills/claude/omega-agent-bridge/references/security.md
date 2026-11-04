# Security

Omega Agent Bridge runs local CLI agents that can read files, execute commands,
and, when approved, write to the host. Treat it as a privileged tool.

## 1. Assets

| Asset | Where it lives | Risk |
|---|---|---|
| Source code and repository data | User workspace | Exfiltration, unwanted edits |
| Account credentials | Account directories | Theft, session hijacking |
| Prompts and responses | Run artifacts and logs | Sensitive code, secrets in text |
| Account health | `account-health.json` | Metadata leakage, denial of service |
| Git history and commits | Workspace and remote | PII, secrets, force-push damage |
| Host filesystem | Outside the workspace | Unrestricted read/write if permissions are bypassed |

## 2. Trust boundaries

```text
User
  │  approvals, scope, credentials (interactive only)
  ▼
Controller agent
  │  spec, engine/account choice, audit
  ▼
Omega Agent Bridge
  │  routing, permissions, validation
  ▼
Engine adapter
  │  CLI invocation, account env, parsing
  ▼
Local CLI agent
  │  reads repository, may execute commands
  ▼
Workspace / host
```

Assumptions:

- The user is the authority for write approval.
- Repository content is untrusted. A README, comment, issue, fixture, or test
  output can contain instructions aimed at the agent.
- The controller is more trustworthy than the executor, but it is still fallible.
- The bridge is not a sandbox. It chooses CLI flags; the CLI enforces them.
- The operating system and the CLI's own sandbox are the real boundaries.

## 3. Permission matrix

| Phase | `canWrite` | `agy` | `claude` | `codex` |
|---|---|---|---|---|
| Planning | false | Least privilege available; prompt restriction otherwise | `--permission-mode plan` | `--sandbox read-only` |
| Read-only execution | false | Same as planning | `--permission-mode plan` | `--sandbox read-only` |
| Write execution | true | Explicit permission flag | `--permission-mode bypassPermissions` | `--sandbox workspace-write` plus approval policy |
| Cross-review | false | Least privilege available | `--permission-mode plan` | `--sandbox read-only` |
| Cleanup | depends | Explicit | Explicit | Explicit |

Rules:

- Map `canWrite` to a real flag. Prompt text is not enforcement.
- Never pass `--dangerously-skip-permissions`,
  `--dangerously-bypass-approvals-and-sandbox`, or
  `danger-full-access` for planning, review, or read-only work.
- Prefer `workspace-write` over a full bypass for Codex.
- Prefer `plan` over `bypassPermissions` for Claude unless the job writes.
- Record which permission mode was used in the job runtime.
- Do not claim a sandbox exists when the engine only has prompt-level
  restrictions. `agy` currently has this limitation.

## 4. Write approval protocol

A write-capable run requires all of the following:

1. **Explicit approval** in the current conversation. The approval must name write
   execution, not just the plan or the goal.
2. **Bounded scope** in the spec: workspace, constraints, success criteria, and
   what must not change.
3. **Correct workspace**: the resolved path is the intended repository.
4. **Rollback path**: clean git state, a branch or worktree, or a disposable
   environment.
5. **Verification plan**: the commands the controller will run afterwards.
6. **Review plan**: a second engine when available, or a disclosed limitation.

Approval is per run. It does not carry over to:

- a resumed run after a failure,
- a follow-up run,
- a different workspace,
- a different branch,
- a changed scope.

If the executor asks for broader access than the spec allows, stop and ask the
user. Do not widen permissions to make the job pass.

### Scope escalation examples

Stop and ask when:

- the executor wants to edit outside the workspace,
- the executor wants to install system packages,
- the executor wants network access that was not in the spec,
- the executor wants to modify CI, deployment, or secret files,
- the executor wants to delete files or rewrite history,
- the executor wants to run a destructive database command.

## 5. Prompt injection

Repository content can try to redirect the agent. Common vectors:

- README or docs claiming "ignore previous instructions",
- comments in source files,
- test fixtures with encoded instructions,
- issue templates,
- generated logs or stack traces,
- dependency metadata,
- filenames that look like commands.

Controls:

- Keep the executor's scope narrow.
- Tell the executor that repository content is data, not instructions.
- Review the diff, not just the summary.
- Never let the executor decide its own permissions or engine.
- Do not pipe untrusted text into a shell.
- Use a disposable worktree or container for untrusted repositories.
- Treat unexpected network, credential, or filesystem requests as a security event.

## 6. Secrets

Never place any of the following in a spec, prompt, skill, report, commit, or log:

- passwords, passphrases, recovery codes,
- API keys, tokens, cookies, auth headers,
- private keys or certificates,
- OAuth codes or device codes,
- session IDs that grant access,
- account email addresses unless the user explicitly asks for them,
- `.env` contents or credential files.

Handling rules:

- Login is interactive and performed by the user.
- The bridge never stores credentials outside the engine's account directory.
- Do not print environment variables.
- Do not include auth material in error messages.
- Redact known secret patterns before writing logs.
- If a secret appears in a prompt or log, stop, rotate it, and report the incident.
- Do not rely on redaction alone. Rotation is the remedy.

## 7. Privacy and personal data

- Skills, docs, examples, tests, and commits contain no personal email addresses,
  no absolute user paths, and no personal dates.
- Use placeholders such as `<workspace>`, `<account-id>`, and `<engine>`.
- Use a GitHub noreply identity for commits when the project requires it.
- Mask account emails in CLI output by default (for example, keep the first
  character and the domain, and replace the rest).
- `--show-emails` is an explicit opt-in and must never be used in automated
  reports.
- Do not publish run artifacts or logs. They can contain source code and prompts.
- Before pushing, scan the diff and history for secrets and PII.

## 8. Logs and artifacts

Run artifacts and logs are sensitive.

- Keep the state directory outside the repository and gitignored.
- Restrict permissions to the current user.
- Do not upload logs to a public service without review.
- Do not attach full logs to a public issue.
- Retention: keep only as long as needed; offer a cleanup command.
- A log may contain a prompt that included sensitive code. Treat it like the code
  itself.

## 9. Account isolation

- `agy`: full isolated home via `USERPROFILE`, `HOME`, `HOMEDRIVE`, `HOMEPATH`,
  and `GEMINI_DIR`.
- `claude`: `CLAUDE_CONFIG_DIR`. Some versions still create project-local files;
  test before claiming isolation.
- `codex`: `CODEX_HOME`. Use `--ephemeral` for runs.

Rules:

- One account directory per profile.
- Do not share a directory between engines.
- Do not symlink an account directory to a shared home.
- Do not copy credentials between accounts.
- Do not run two write jobs on the same account at the same time.
- Do not expose account directories through a web server or sync folder.

## 10. Destructive and irreversible actions

The bridge must not perform these without a separate, explicit confirmation that
names the action:

- deleting files or directories outside generated output,
- `git reset --hard`, `git clean -fdx`, force-push, or history rewrite,
- dropping or migrating a database,
- deploying to production,
- rotating or deleting credentials,
- changing CI/CD secrets or permissions,
- installing or removing system packages,
- modifying access controls,
- sending money or submitting forms,
- contacting third parties.

A general "go ahead" for the task is not confirmation for a destructive action.

## 11. Command execution

- Spawn binaries with argument arrays; never concatenate a shell command from
  spec or model output.
- Resolve binaries explicitly and record the path.
- Validate that the workspace is inside the intended root before running.
- Do not run as administrator/root unless the task requires it and the user
  approves.
- Prefer read-only commands for inspection.
- Treat model-generated shell commands as untrusted until reviewed.
- Kill the whole process tree on timeout or cancellation.

## 12. Engine and model integrity

- Do not silently substitute an engine, model, effort, or account.
- If the requested runtime is unavailable, fail the job.
- Verify the effective model when the CLI exposes it. Otherwise mark
  `verified: false`.
- Record fallbacks and their reasons.
- Do not let an executor choose a different engine for itself.
- Do not let a planner assign a job outside `allowed_engines`.
- Cross-engine review is advisory. It can miss issues and it is not a security
  audit.

## 13. Supply chain and environment

- Install CLIs from trusted sources.
- Keep them updated and check their `--help` before relying on flags.
- Review the bridge's own dependencies and lockfile.
- Run CI with minimal permissions (`contents: read` by default).
- Do not expose long-lived tokens to pull requests from forks.
- Pin GitHub Actions by version and review third-party actions.
- Use a disposable environment for untrusted repositories.

## 14. Incident response

If a secret may have leaked, or the executor did something outside scope:

1. Stop the run and cancel any remaining jobs.
2. Preserve the logs and the workspace state.
3. Identify what was accessed, written, or transmitted.
4. Rotate affected credentials.
5. Revert unauthorized changes.
6. Report the incident to the user with facts, not guesses.
7. Add a regression test or guard if the cause is in the bridge.

Do not delete evidence before the user has seen it.

## 15. Security checklist

Before a read-only run:

- [ ] Engine installed and verified.
- [ ] Account authenticated and not in cooldown.
- [ ] Workspace is the intended path.
- [ ] Read-only mode mapped to a real flag or the limitation is disclosed.
- [ ] No secrets in the spec or prompt.

Before a write run:

- [ ] Explicit write approval for this run.
- [ ] Scope and constraints written down.
- [ ] Clean git state or accepted existing changes.
- [ ] Branch or worktree prepared.
- [ ] Rollback path confirmed.
- [ ] Review engine available, or limitation disclosed.
- [ ] No destructive action included without separate confirmation.

After a run:

- [ ] Diff reviewed independently.
- [ ] Tests and build run by the controller.
- [ ] No secrets or PII in the diff.
- [ ] No unrelated files changed.
- [ ] Runtime verification recorded.
- [ ] Remaining gaps reported.
