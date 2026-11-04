# Accounts

An account is an isolated authentication and quota profile for one engine. It is
not a model and not a permission level. Up to 20 accounts per engine are
supported by default, configurable through `maxAccountsPerEngine`.

## 1. Layout

```text
~/.omega-agent-bridge/
├─ config.json
├─ account-health.json
├─ accounts/
│  ├─ agy/
│  │  ├─ account-01/
│  │  ├─ account-02/
│  │  └─ ... up to account-20/
│  ├─ claude/
│  │  ├─ account-01/
│  │  └─ ... up to account-20/
│  └─ codex/
│     ├─ account-01/
│     └─ ... up to account-20/
└─ runs/
   └─ <run-id>/
```

Each account directory is the engine's isolated configuration root:

| Engine | Isolation | Directory contents |
|---|---|---|
| `agy` | Full home | `.gemini/`, OAuth credentials, CLI cache and logs |
| `claude` | `CLAUDE_CONFIG_DIR` | Claude Code settings, sessions, and auth state |
| `codex` | `CODEX_HOME` | `auth.json`, `config.toml`, sessions, and logs |

The directory name is the account ID. Credentials stay inside it. They never
appear in `config.json`, `account-health.json`, run metadata, logs, reports,
skills, or commits.

## 2. IDs

- Default IDs: `account-01` … `account-20`, zero-padded and naturally sortable.
- Custom labels are allowed: `work-01`, `max-07`, `laptop`.
- Validation: `^[a-z0-9][a-z0-9_-]{0,31}$`.
- Account reference: `<engine>:<id>`, for example `claude:account-03`.
- A bare ID is used as-is against the default execution engine. The bridge does
  not auto-pad it, so use `account-03`, not `03`, unless you deliberately created
  a profile named `03`.
- IDs are case-sensitive in storage but sorted case-insensitively by the CLI to
  keep listings stable.

## 3. Limits

Default configuration:

```json
{
  "maxAccountsPerEngine": 20,
  "rotation": "least-recently-used",
  "cooldownMinutes": 15
}
```

Behavior above the cap:

- Extra directories are ignored by rotation.
- Nothing is deleted automatically.
- `account list` shows them as `ignored` so the user can decide.

The configured cap is the rotation limit, not a filesystem quota. Directories
above it remain on disk until the user removes them.

## 4. CLI

```bash
# Create and authenticate interactively
omega-agent-bridge account login agy:03
omega-agent-bridge account login claude:07
omega-agent-bridge account login codex:12

# Inspect
omega-agent-bridge account list
omega-agent-bridge account list --json
omega-agent-bridge account list --json --show-emails
omega-agent-bridge account status claude:07 --json

# Remove a profile (confirmation required)
omega-agent-bridge account prune agy:account-03 --yes

# Copy legacy agy profiles
omega-agent-bridge account migrate --from ~/.omega-agent-bridge/accounts --dry-run
omega-agent-bridge account migrate --from ~/.omega-agent-bridge/accounts

# Reclaim space without removing authentication
omega-agent-bridge account clean claude:07 --sessions
omega-agent-bridge account clean codex:12 --sessions
```

`account login` is interactive. The controller must not run it inside a
non-interactive job, and must never ask for a password, OAuth code, or token in
chat. Ask the user to run it in their own terminal.

`account prune` requires `--yes`. It has no automatic run-lock check, so never
prune a profile while a run that may use it is active. It must never be part of an
automated cleanup.

## 5. Pinning and rotation

### Default: rotation

Omit `account`. The bridge:

1. Lists authenticated accounts for the engine.
2. Removes accounts in cooldown.
3. Removes accounts marked `auth_required`.
4. Sorts by `lastUsedAt` ascending, then by ID.
5. Uses the first account.
6. On quota failure, marks the account in cooldown and tries the next one.

Rotation is per engine. An exhausted `claude` pool never falls through to `agy` or
`codex` unless `fallback_engines` is explicitly configured.

### Pinned: reproducibility

Set `account` in the spec or pass `--account`:

```json
{
  "engine": "claude",
  "account": "claude:account-07"
}
```

A pinned account does not rotate. If it is in cooldown, unauthenticated, or out of
quota, the job fails with a clear error. This is intentional: a pin is a promise
about which profile was used.

### Per-job accounts

A job may pin an account, but only inside the same engine pool:

```json
{
  "title": "Run the migration",
  "engine": "codex",
  "account": "codex:account-02",
  "can_write": true
}
```

The orchestrator validates the reference before dispatch. An executor cannot
choose a different pool for itself.

## 6. Rotation and failure matrix

| Event | Rotate account? | Change engine? | Result |
|---|---|---|---|
| Quota exhausted / 429 | Yes, same engine | No | Continue with next account |
| Authentication required | Yes, skip account | No | Continue; report skipped profile |
| All accounts exhausted | No | Only if `fallback_engines` is set | Fail with `all_accounts_exhausted` |
| Invalid JSON | No | No | Fail the job |
| Timeout | No | No | Fail the job; inspect partial changes |
| Model or effort mismatch | No | No | Fail the job |
| Permission denied | No | No | Fail the job |
| Review `needs_followup` | No | No | Report; new approval needed for another write run |

Automatic account rotation is a quota strategy, not a quality strategy. Do not
rotate to hide a failing job.

## 7. Health state

`account-health.json` stores non-secret metadata only:

```json
{
  "claude:account-01": {
    "lastUsedAt": "<timestamp>",
    "cooldownUntil": null,
    "authStatus": "ok",
    "lastError": null
  },
  "codex:account-02": {
    "lastUsedAt": "<timestamp>",
    "cooldownUntil": "<timestamp>",
    "authStatus": "ok",
    "lastError": "quota_exhausted"
  }
}
```

Allowed fields:

- `lastUsedAt`
- `cooldownUntil`
- `authStatus`: `ok`, `auth_required`, `unknown`
- `lastError`: a short machine-readable code, never a raw provider response

Forbidden fields:

- email addresses
- tokens, cookies, API keys
- account directory contents
- provider billing details

Health updates must be atomic. Parallel read-only jobs can update the same file;
serialize writes through a queue or a lock file and merge before saving.

## 8. Concurrency

- Write-capable jobs: strictly sequential, one workspace, exclusive access.
- Read-only jobs: up to 10 concurrent workers.
- Up to 20 accounts per engine does not mean 20 parallel writers.
- Two write jobs must never share an account at the same time.
- Read-only jobs may share an account, but the LRU timestamp update still needs
  serialization.
- The orchestrator owns account leases. Executors never pick an account.

## 9. Migration from the legacy layout

The legacy bridge stored agy homes directly under:

```text
~/.omega-agent-bridge/accounts/account-1/
~/.omega-agent-bridge/accounts/account-2/
```

The new layout is engine-scoped:

```text
~/.omega-agent-bridge/accounts/agy/account-01/
~/.omega-agent-bridge/accounts/agy/account-02/
```

Migration rules:

1. Run `account migrate --from <legacy-root> --dry-run` first.
2. Copy, never move. The old tool keeps working during the transition.
3. Rename `account-1` to `account-01` only if the target does not exist.
4. Preserve permissions.
5. Verify authentication after copying with `account status`.
6. Do not delete the legacy directories until the user confirms and the new
   profiles have completed at least one successful read-only run.
7. Never migrate a directory that is a symlink into a shared home. Copy the
   resolved files or stop and report.

## 10. Provisioning a new account

1. Choose the engine and an unused ID.
2. Create the directory (the CLI does this).
3. Ask the user to run the interactive login.
4. Verify with `account status <engine:id> --json`.
5. Record no email or token outside the account directory.
6. Run a small read-only job to confirm the profile works.
7. Only then add it to a write-capable pool.

Do not create empty profiles in bulk just to reach 20. An unauthenticated profile
is skipped at runtime and only adds noise.

## 11. Disk and security

- Use `codex exec --ephemeral` for runs to avoid session growth in `CODEX_HOME`.
- Use `account clean <ref> --sessions` to remove session history while keeping
  authentication.
- Account directories can contain credentials. On Unix create them with mode
  `700`; on Windows restrict them to the current user where practical.
- Keep the state directory outside every repository.
- Do not sync account directories to cloud storage or include them in backups
  that are not encrypted.
- Backups must be encrypted and access-controlled.
- `account prune` is destructive. Confirm, then remove. Never prune all accounts
  in one automated step.

## 12. What the controller should report

- Which engine and account IDs were used.
- Whether the account was pinned or rotated.
- Any cooldown or skipped profile.
- `all_accounts_exhausted` as a hard stop, not a warning.
- Emails masked, or omitted entirely. Account IDs are enough for normal reports.
