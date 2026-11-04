# Onboarding

First-run setup for Omega Agent Bridge. The goal is a working, verified
installation without editing JSON by hand.

## 1. Quick start

```bash
omega-agent-bridge setup
omega-agent-bridge doctor --json
omega-agent-bridge account list --json
```

`setup` is interactive. It detects engines, creates the state layout, starts
interactive logins when a terminal is available, writes the local config, and
prints `doctor` plus a read-only plan as next steps. Add `--migrate-legacy` to copy
legacy flat `agy` profiles.

Run it in a real terminal. If a controller or automation environment cannot provide
a TTY, the user must run `setup` themselves; the controller can continue with
`doctor` and `account list` afterwards.

Preview without changing anything:

```bash
omega-agent-bridge setup --dry-run
```

## 2. What setup does

### Step 1 — State directory

Creates `~/.omega-agent-bridge` if needed and verifies that it is writable.

The state directory is outside every repository. It contains:

- `config.json`
- `account-health.json`
- `accounts/<engine>/<account-id>/`
- `runs/<run-id>/`

Nothing in this directory belongs in git.

### Step 2 — Engine detection

Probes the supported engines:

- `agy`
- `claude`
- `codex`

For each engine it reports:

- found or missing,
- resolved binary path,
- version,
- whether the path came from `PATH`, a CLI flag, or an environment variable.

Missing engines are skipped. Setup never installs or upgrades a CLI.

If an engine is installed but not on `PATH`, provide its path when prompted. The
path is stored in the local `config.json` only; it is never committed.

### Step 3 — Engine selection

By default setup checks all three engines and enables the ones it detects. Target
one engine explicitly when you want to keep the rest untouched:

```bash
omega-agent-bridge setup --engine claude
```

### Step 4 — First account

For each selected engine, setup targets `account-01` and launches the engine's
interactive login in your terminal. The profile directory is created when the
login starts. If no TTY is available, setup prints the exact login command
instead.

Examples:

```bash
omega-agent-bridge account login agy:account-01
omega-agent-bridge account login claude:account-01
omega-agent-bridge account login codex:account-01
```

Rules:

- The bridge never asks for a password, OAuth code, or token.
- The login is handled by the engine's own CLI.
- Credentials stay in the account directory.
- If a login fails, setup reports it and continues with the other engines.

Use `--no-login` to create the layout without launching a login.

### Step 5 — Authentication check

After login, setup re-reads the account metadata and reports whether credentials
were detected. It does not run a model invocation during onboarding.

A failed check is reported, not hidden. Setup does not retry with a different
account.

### Step 6 — Legacy migration

With `--migrate-legacy`, setup shows the legacy migration plan and copies the
profiles into the engine-scoped layout:

```text
legacy/account-1 -> accounts/agy/account-01
legacy/account-2 -> accounts/agy/account-02
```

The originals stay in place. Use `setup --migrate-legacy --dry-run` to preview
without copying.

Rules:

- Copy, never move.
- Never overwrite an existing target without confirmation.
- Never delete the legacy directory.
- Never migrate a symlink into a shared home. Stop and report it.

You can run migration separately:

```bash
omega-agent-bridge account migrate --from <legacy-root> --dry-run
omega-agent-bridge account migrate --from <legacy-root>
```

### Step 7 — Config

Setup writes a local `config.json`:

```json
{
  "version": 1,
  "maxAccountsPerEngine": 20,
  "rotation": "least-recently-used",
  "cooldownMinutes": 15,
  "engines": {
    "agy": {
      "enabled": true,
      "binary": null
    },
    "claude": {
      "enabled": true,
      "binary": null
    },
    "codex": {
      "enabled": false,
      "binary": null
    }
  }
}
```

`binary: null` means "resolve from `PATH`". A non-null value is a local path and
must never be committed or shared.

### Step 8 — Doctor

Setup prints `doctor` as the next step. Run it to get a checklist similar to:

```text
bridge        ok
state dir     ok (writable, outside repository)
engine agy    ok (version detected)
engine claude ok (version detected)
account agy:account-01    authenticated
account claude:account-01 authenticated
config        ok
```

```bash
omega-agent-bridge doctor --json
```

### Step 9 — Next steps

Setup prints the commands for:

- running `doctor --json`,
- listing accounts with `account list --json`,
- running a read-only plan with `run --plan-only --json`.

Add more accounts and cross-engine review explicitly after the first plan works.

## 3. Flags

```text
setup [--engine <engine>] [--dry-run] [--no-login] [--migrate-legacy] [--json]
```

| Flag | Effect |
|---|---|
| `--engine <engine>` | Configure only one engine |
| `--dry-run` | Print the plan; create nothing |
| `--no-login` | Create the layout and config without interactive login |
| `--migrate-legacy` | Include the legacy agy migration step |
| `--json` | Machine-readable summary for scripts |

## 4. Adding more accounts

Accounts are independent profiles. Add them one at a time:

```bash
omega-agent-bridge account login agy:account-02
omega-agent-bridge account login claude:account-02
omega-agent-bridge account login codex:account-02
```

Verify:

```bash
omega-agent-bridge account status claude:account-02 --json
omega-agent-bridge account list --json
```

Up to 20 per engine by default. To change the cap, edit `maxAccountsPerEngine` in
`config.json`, or set `max_accounts_per_engine` in a run spec for that run. Extra
directories above the cap are ignored by rotation, never deleted.

Do not create empty profiles in bulk. An unauthenticated account is skipped at
runtime and only adds noise.

## 5. First read-only run

Create a small spec:

```json
{
  "goal": "Summarize the repository structure and identify the test command.",
  "workspace": "./my-project",
  "constraints": [
    "Do not modify any file."
  ],
  "success_criteria": [
    "The summary names the main source directories.",
    "The test command is identified from project metadata."
  ],
  "allow_write": false,
  "max_subjobs": 2,
  "timeout_minutes": 10,
  "engine": "agy",
  "model": "strongest",
  "effort": "highest",
  "report_format": "summary"
}
```

Plan and run:

```bash
omega-agent-bridge run --spec ./onboarding.spec.json --plan-only --json
omega-agent-bridge show-run --run-id <run-id> --json
```

If `--plan-only` is not supported by the installed version, use
`allow_write: false` and treat the run as read-only.

## 6. First write run

Only after the read-only run succeeds:

1. Write a bounded spec with `allow_write: true`, which declares that the run may
   write without approving it.
2. Run `--plan-only` and inspect the plan, risks, and target engines.
3. Approve write execution explicitly for this run.
4. Run `resume --run-id <run-id> --allow-write --json`.
5. Inspect the diff and run the tests yourself.
6. Report any fallback or unverified runtime.

Do not skip the audit because the bridge reported success.

## 7. Cross-engine review

Add a different review engine to the spec:

```json
{
  "engine": "agy",
  "review_engine": "claude",
  "allowed_engines": ["agy", "claude"]
}
```

The review runs read-only after execution. If the review engine is unavailable,
the bridge fails or discloses the missing cross-review; it does not silently use
the executor as its own reviewer.

## 8. Common setup problems

### Engine not found

- Confirm the CLI is installed.
- Run its version command directly.
- If it is not on `PATH`, provide the path during setup or set the documented
  environment variable.
- Setup does not install CLIs.

### Engine found but login fails

- Run the login command directly in your terminal.
- Check the engine's own status command.
- Do not paste credentials into the bridge or into chat.
- Verify the account directory is writable.

### State directory not writable

- Check ownership and permissions.
- Check whether a sync tool or another user controls the directory.
- Choose a different state directory with the documented flag.
- Do not run the bridge as administrator just to work around permissions.

### Legacy migration target exists

- Setup refuses to overwrite.
- Choose a different account ID or remove the target after inspection.
- Never delete a profile to "reset" authentication without confirming what it
  contains.

### Account limit warning

- Extra directories above `maxAccountsPerEngine` are ignored.
- Raise the cap or remove the extras deliberately.
- The bridge never deletes them automatically.

### Codex not on `PATH`

- Provide the binary path during setup.
- Verify `codex --version` works with that path.
- Store the path only in local config.

### Claude config isolation looks incomplete

Some versions create project-local files even with `CLAUDE_CONFIG_DIR`. Check the
workspace after a run. Report the leak; do not assume full isolation.

## 9. What setup never does

- It never installs, upgrades, or removes a CLI.
- It never asks for passwords, OAuth codes, or tokens.
- It never deletes an account or a legacy directory.
- It never enables writes.
- It never commits the local config or state directory.
- It never prints account emails unless explicitly requested.
- It never runs a write job as part of onboarding.

## 10. Verification checklist

- [ ] `setup` completed without fatal errors.
- [ ] `doctor --json` reports the expected engines.
- [ ] At least one account per required engine is authenticated.
- [ ] `account list --json` shows the expected IDs.
- [ ] A read-only run completes and produces a valid report.
- [ ] `show-run` exposes job-level details.
- [ ] The state directory is outside the repository.
- [ ] No credentials or emails appear in the config, logs, or report.
- [ ] The first write run is approved explicitly and audited independently.
