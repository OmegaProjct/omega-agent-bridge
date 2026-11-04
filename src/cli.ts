#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";

import { createAgentResolver } from "./agents/index.js";
import {
  accountDir,
  formatAccountRef,
  getEngineAccountInfo,
  isEngineName,
  launchEngineLogin,
  listEngineAccounts,
  migrateLegacyAgyAccounts,
  parseAccountRef,
  planLegacyAgyMigration
} from "./accounts.js";
import { engineBinary, loadConfig } from "./config.js";
import { resumeRun, startRun, type RunOptions } from "./orchestrator.js";
import {
  accountsDir,
  defaultStateDir,
  engineAccountsDir,
  parseRunSpec
} from "./schema.js";
import { ENGINES, runDoctor, runSetup } from "./setup.js";
import {
  listRuns,
  loadRun,
  requestRunCancellation,
  saveRun,
  summarizeRun
} from "./store.js";
import type { AccountInfo, EngineName, ReviewEngine, RunSpec } from "./types.js";

async function readSpec(specPath: string): Promise<unknown> {
  const resolved = path.resolve(process.cwd(), specPath);
  const raw = (await fs.readFile(resolved, "utf8")).replace(/^\uFEFF/, "");
  return JSON.parse(raw) as unknown;
}

function printResult(value: unknown, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }

  if (typeof value === "string") {
    process.stdout.write(`${value}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function applyRunExitCode(state: string): void {
  if (state === "failed" || state === "cancelled") {
    process.exitCode = 1;
  }
}

function parseEngine(value: string): EngineName {
  const normalized = value.trim().toLowerCase();
  if (!isEngineName(normalized)) {
    throw new Error(`Unknown engine '${value}'. Use one of: ${ENGINES.join(", ")}.`);
  }
  return normalized;
}

function parseReviewEngine(value: string): ReviewEngine {
  if (value.trim().toLowerCase() === "auto") {
    return "auto";
  }
  return parseEngine(value);
}

function parseEngineList(value: string): EngineName[] {
  const engines = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseEngine);
  if (engines.length === 0) {
    throw new Error("--allowed-engines requires at least one engine.");
  }
  return Array.from(new Set(engines));
}

interface BinaryOptions {
  agyBin?: string;
  claudeBin?: string;
  codexBin?: string;
}

async function buildResolver(
  stateDir: string,
  options: BinaryOptions,
  maxAccountsPerEngine?: number
) {
  const config = await loadConfig(stateDir);
  const resolver = createAgentResolver({
    stateDir,
    agyBin: options.agyBin ?? engineBinary("agy", config),
    claudeBin: options.claudeBin ?? engineBinary("claude", config),
    codexBin: options.codexBin ?? engineBinary("codex", config),
    maxAccountsPerEngine: maxAccountsPerEngine ?? config.maxAccountsPerEngine,
    cooldownMinutes: config.cooldownMinutes
  });
  return { config, resolver };
}

function applyEngineOverrides(
  spec: RunSpec,
  rawSpec: Record<string, unknown>,
  options: {
    engine?: string;
    planningEngine?: string;
    reviewEngine?: string;
    allowedEngines?: string;
    account?: string;
  }
): void {
  if (options.engine) {
    const engine = parseEngine(options.engine);
    spec.engine = engine;
    if (rawSpec.planning_engine === undefined) {
      spec.planning_engine = engine;
    }
    if (rawSpec.review_engine === undefined) {
      spec.review_engine = engine;
    }
    if (rawSpec.allowed_engines === undefined) {
      spec.allowed_engines = [engine];
    }
  }
  if (options.planningEngine) {
    spec.planning_engine = parseEngine(options.planningEngine);
  }
  if (options.reviewEngine) {
    spec.review_engine = parseReviewEngine(options.reviewEngine);
  }
  if (options.allowedEngines) {
    spec.allowed_engines = parseEngineList(options.allowedEngines);
  }
  if (options.account) {
    spec.account = options.account;
  }
  if (!spec.allowed_engines.includes(spec.engine)) {
    throw new Error(
      `The default execution engine '${spec.engine}' is not in allowed_engines (${spec.allowed_engines.join(", ")}). ` +
      "Add it with --allowed-engines or choose another engine."
    );
  }
  for (const engine of spec.fallback_engines) {
    if (!spec.allowed_engines.includes(engine)) {
      throw new Error(
        `fallback_engines contains '${engine}', which is not in allowed_engines.`
      );
    }
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function resolveAccountStatus(
  stateDir: string,
  reference: string
): Promise<AccountInfo> {
  const parsed = parseAccountRef(reference, "agy");
  const scoped = accountDir(stateDir, parsed.engine, parsed.id);
  const useLegacy =
    parsed.engine === "agy" &&
    !(await pathExists(scoped));
  return getEngineAccountInfo(stateDir, parsed.engine, parsed.id, { useLegacy });
}

function maskedAccount(account: AccountInfo, showEmails: boolean): AccountInfo {
  if (showEmails) {
    return account;
  }
  return { ...account, email: account.maskedEmail ?? null };
}

const program = new Command();
program
  .name("omega-agent-bridge")
  .description(
    "Delegate bounded local engineering work to agy, Claude Code, or Codex with isolated accounts and cross-engine review."
  )
  .version("0.2.0");

program
  .command("setup")
  .description("Guided first-run onboarding: detect engines, create accounts, write config, verify.")
  .option("--engine <engine>", "Configure only one engine.")
  .option("--state-dir <path>", "State directory.", defaultStateDir())
  .option("--dry-run", "Show the plan without creating anything or starting a login.")
  .option("--no-login", "Create the layout and config without interactive login.")
  .option("--migrate-legacy", "Copy legacy flat agy accounts into the engine-scoped layout.")
  .option("--json", "Print JSON output.")
  .option("--agy-bin <path>", "Explicit path to the agy executable.")
  .option("--claude-bin <path>", "Explicit path to the claude executable.")
  .option("--codex-bin <path>", "Explicit path to the codex executable.")
  .action(async (options: {
    engine?: string;
    stateDir: string;
    dryRun?: boolean;
    login?: boolean;
    migrateLegacy?: boolean;
    json?: boolean;
  } & BinaryOptions) => {
    const result = await runSetup({
      stateDir: path.resolve(process.cwd(), options.stateDir),
      engine: options.engine ? parseEngine(options.engine) : undefined,
      dryRun: Boolean(options.dryRun),
      noLogin: options.login === false,
      login: options.login !== false,
      migrateLegacy: Boolean(options.migrateLegacy),
      binaries: {
        agy: options.agyBin,
        claude: options.claudeBin,
        codex: options.codexBin
      }
    });

    if (options.json) {
      printResult(result, true);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }

    process.stdout.write(`Omega Agent Bridge setup${result.dryRun ? " (dry run)" : ""}\n\n`);
    process.stdout.write(`State directory: ${result.stateDir}\n`);
    process.stdout.write(`Config:          ${result.configPath}\n\n`);

    for (const entry of result.engines) {
      const detection = entry.detected;
      const status = detection.found ? `found (${detection.version ?? "version unknown"})` : "not found";
      process.stdout.write(`- ${entry.engine}: ${status}\n`);
      process.stdout.write(`  binary: ${detection.binary} (${detection.source})\n`);
      if (entry.account) {
        const accountState = entry.account.authenticated ? "authenticated" : "not authenticated";
        process.stdout.write(`  account: ${entry.account.id} (${accountState})\n`);
      } else {
        process.stdout.write(`  next:    ${entry.loginCommand}\n`);
      }
    }

    if (result.migration.length > 0) {
      process.stdout.write(`\nLegacy agy migration:\n`);
      for (const item of result.migration) {
        process.stdout.write(`  ${item.source} -> ${item.target} (${item.action})\n`);
      }
      if (result.migrated.length > 0) {
        process.stdout.write(`  copied: ${result.migrated.join(", ")}\n`);
      }
    }

    if (result.warnings.length > 0) {
      process.stdout.write(`\nWarnings:\n`);
      for (const warning of result.warnings) {
        process.stdout.write(`  - ${warning}\n`);
      }
    }

    process.stdout.write(`\nNext steps:\n`);
    for (const step of result.nextSteps) {
      process.stdout.write(`  ${step}\n`);
    }
    process.exitCode = result.ok ? 0 : 1;
  });

program
  .command("run")
  .description("Create a new bridge run from a JSON spec.")
  .requiredOption("--spec <path>", "Path to the run spec JSON file.")
  .option("--engine <engine>", "Override the default execution engine.")
  .option("--planning-engine <engine>", "Override the planning engine.")
  .option("--review-engine <engine|auto>", "Override the review engine.")
  .option("--allowed-engines <list>", "Comma-separated allowlist for per-job engines.")
  .option("--account <ref>", "Account identifier or engine:id reference to use for this run.")
  .option("--plan-only", "Plan read-only and stop before execution.")
  .option("--allow-write", "Record explicit write approval for this run.")
  .option("--state-dir <path>", "Override the state directory from the spec.")
  .option("--json", "Print JSON output.")
  .option("--agy-bin <path>", "Explicit path to the agy executable.")
  .option("--claude-bin <path>", "Explicit path to the claude executable.")
  .option("--codex-bin <path>", "Explicit path to the codex executable.")
  .action(async (options: {
    spec: string;
    engine?: string;
    planningEngine?: string;
    reviewEngine?: string;
    allowedEngines?: string;
    account?: string;
    planOnly?: boolean;
    allowWrite?: boolean;
    stateDir?: string;
    json?: boolean;
  } & BinaryOptions) => {
    const specInput = await readSpec(options.spec);
    const spec = parseRunSpec(specInput, path.dirname(path.resolve(process.cwd(), options.spec)));
    if (options.stateDir) {
      spec.state_dir = path.resolve(process.cwd(), options.stateDir);
    }
    applyEngineOverrides(spec, specInput as Record<string, unknown>, options);

    const runOptions: RunOptions = {
      planOnly: Boolean(options.planOnly),
      allowWrite: Boolean(options.allowWrite),
      requireWriteApproval: true
    };

    const { resolver } = await buildResolver(spec.state_dir, options, spec.max_accounts_per_engine);
    const run = await startRun(spec, resolver, runOptions);
    printResult(summarizeRun(run), Boolean(options.json));

    if (!options.json && run.state === "pending") {
      process.stdout.write(
        `\nRun is pending. Approve write execution, then resume with:\n` +
        `  omega-agent-bridge resume --run-id ${run.runId} --allow-write\n`
      );
    }
    applyRunExitCode(run.state);
  });

program
  .command("resume")
  .description("Resume an existing run.")
  .requiredOption("--run-id <id>", "Run identifier.")
  .option("--account <ref>", "Account identifier or engine:id reference to use when resuming.")
  .option("--engine <engine>", "Override the default execution engine for future jobs.")
  .option("--allow-write", "Record explicit write approval and continue.")
  .option("--state-dir <path>", "State directory used by the run.", defaultStateDir())
  .option("--json", "Print JSON output.")
  .option("--agy-bin <path>", "Explicit path to the agy executable.")
  .option("--claude-bin <path>", "Explicit path to the claude executable.")
  .option("--codex-bin <path>", "Explicit path to the codex executable.")
  .action(async (options: {
    runId: string;
    account?: string;
    engine?: string;
    allowWrite?: boolean;
    stateDir: string;
    json?: boolean;
  } & BinaryOptions) => {
    const stateDir = path.resolve(process.cwd(), options.stateDir);
    const existing = await loadRun(options.runId, stateDir);
    if (options.account) {
      existing.spec.account = options.account;
    }
    if (options.engine) {
      const engine = parseEngine(options.engine);
      if (!existing.spec.allowed_engines.includes(engine)) {
        throw new Error(
          `The requested engine '${engine}' is not in allowed_engines (${existing.spec.allowed_engines.join(", ")}).`
        );
      }
      existing.spec.engine = engine;
    }
    await saveRun(existing);

    const { resolver } = await buildResolver(
      stateDir,
      options,
      existing.spec.max_accounts_per_engine
    );
    const run = await resumeRun(options.runId, stateDir, resolver, {
      allowWrite: Boolean(options.allowWrite),
      requireWriteApproval: true
    });
    printResult(summarizeRun(run), Boolean(options.json));

    if (!options.json && run.state === "pending") {
      process.stdout.write(
        `\nRun is pending. Approve write execution, then resume with:\n` +
        `  omega-agent-bridge resume --run-id ${run.runId} --allow-write\n`
      );
    }
    applyRunExitCode(run.state);
  });

program
  .command("doctor")
  .description("Check state, engines, binaries, and authenticated accounts.")
  .option("--state-dir <path>", "State directory to inspect.", defaultStateDir())
  .option("--engine <engine>", "Check only one engine.")
  .option("--json", "Print JSON output.")
  .option("--agy-bin <path>", "Explicit path to the agy executable.")
  .option("--claude-bin <path>", "Explicit path to the claude executable.")
  .option("--codex-bin <path>", "Explicit path to the codex executable.")
  .action(async (options: {
    stateDir: string;
    engine?: string;
    json?: boolean;
  } & BinaryOptions) => {
    const stateDir = path.resolve(process.cwd(), options.stateDir);
    const result = await runDoctor({
      stateDir,
      engine: options.engine ? parseEngine(options.engine) : undefined,
      binaries: {
        agy: options.agyBin,
        claude: options.claudeBin,
        codex: options.codexBin
      }
    });

    if (options.json) {
      printResult(result, true);
    } else {
      for (const check of result.checks) {
        const marker = check.status === "ok" ? "ok  " : check.status === "warn" ? "warn" : "fail";
        process.stdout.write(`${marker} ${check.id}: ${check.detail}\n`);
      }
      process.stdout.write(`\nOverall: ${result.ok ? "usable" : "not usable"}\n`);
    }
    process.exitCode = result.ok ? 0 : 1;
  });

program
  .command("status")
  .description("Show a compact status summary for one run.")
  .requiredOption("--run-id <id>", "Run identifier.")
  .option("--state-dir <path>", "State directory used by the run.", defaultStateDir())
  .option("--json", "Print JSON output.")
  .action(async (options: { runId: string; stateDir: string; json?: boolean; }) => {
    const run = await loadRun(options.runId, path.resolve(process.cwd(), options.stateDir));
    printResult(summarizeRun(run), Boolean(options.json));
  });

program
  .command("show-run")
  .description("Print the full stored run document.")
  .requiredOption("--run-id <id>", "Run identifier.")
  .option("--state-dir <path>", "State directory used by the run.", defaultStateDir())
  .option("--json", "Print JSON output.")
  .action(async (options: { runId: string; stateDir: string; json?: boolean; }) => {
    const run = await loadRun(options.runId, path.resolve(process.cwd(), options.stateDir));
    printResult(run, Boolean(options.json));
  });

program
  .command("list-runs")
  .description("List known runs from one state directory.")
  .option("--state-dir <path>", "State directory to inspect.", defaultStateDir())
  .option("--json", "Print JSON output.")
  .action(async (options: { stateDir: string; json?: boolean; }) => {
    const runs = await listRuns(path.resolve(process.cwd(), options.stateDir));
    const summaries = runs.map((run) => summarizeRun(run));
    printResult(summaries, Boolean(options.json));
  });

program
  .command("cancel")
  .description("Mark a run for cancellation.")
  .requiredOption("--run-id <id>", "Run identifier.")
  .option("--state-dir <path>", "State directory used by the run.", defaultStateDir())
  .option("--json", "Print JSON output.")
  .action(async (options: { runId: string; stateDir: string; json?: boolean; }) => {
    const run = await requestRunCancellation(options.runId, path.resolve(process.cwd(), options.stateDir));
    printResult(summarizeRun(run), Boolean(options.json));
  });

const accountCommand = program
  .command("account")
  .description("Manage isolated accounts for agy, Claude Code, and Codex.");

accountCommand
  .command("list")
  .description("List configured accounts and their authentication and cooldown status.")
  .option("--state-dir <path>", "State directory containing accounts.", defaultStateDir())
  .option("--engine <engine>", "List only one engine.")
  .option("--show-emails", "Show full account email addresses instead of masking them.")
  .option("--json", "Print JSON output.")
  .action(async (options: {
    stateDir: string;
    engine?: string;
    showEmails?: boolean;
    json?: boolean;
  }) => {
    const stateDir = path.resolve(process.cwd(), options.stateDir);
    const config = await loadConfig(stateDir);
    const engines = options.engine ? [parseEngine(options.engine)] : ENGINES;

    const accounts: AccountInfo[] = [];
    for (const engine of engines) {
      const listed = await listEngineAccounts(stateDir, engine, config.maxAccountsPerEngine);
      accounts.push(...listed);
    }
    const visible = accounts.map((account) => maskedAccount(account, Boolean(options.showEmails)));

    if (options.json) {
      printResult(visible, true);
      return;
    }

    if (visible.length === 0) {
      process.stdout.write(`No accounts found in ${accountsDir(stateDir)}\n`);
      process.stdout.write(`Run 'omega-agent-bridge setup' or 'omega-agent-bridge account login agy:account-01'.\n`);
      return;
    }

    process.stdout.write(`Configured accounts (${visible.length}):\n`);
    for (const acc of visible) {
      const status = acc.authenticated ? "authenticated" : "not authenticated";
      const email = acc.email ? ` (${acc.email})` : "";
      const cooldown = acc.cooldownUntil ? ` [cooldown until ${acc.cooldownUntil}]` : "";
      const ignored = acc.ignored ? " [ignored: account limit]" : "";
      process.stdout.write(
        `  - ${formatAccountRef(acc.engine, acc.id)}: ${status}${email}${cooldown}${ignored}\n` +
        `    Directory: ${acc.dir}\n`
      );
    }
  });

accountCommand
  .command("status")
  .description("Check authentication status for a specific account.")
  .argument("<account-ref>", "Account reference such as agy:account-01 or claude:03.")
  .option("--state-dir <path>", "State directory containing accounts.", defaultStateDir())
  .option("--show-emails", "Show the full email address instead of masking it.")
  .option("--json", "Print JSON output.")
  .action(async (accountRef: string, options: {
    stateDir: string;
    showEmails?: boolean;
    json?: boolean;
  }) => {
    const stateDir = path.resolve(process.cwd(), options.stateDir);
    const info = await resolveAccountStatus(stateDir, accountRef);
    const visible = maskedAccount(info, Boolean(options.showEmails));

    if (options.json) {
      printResult(visible, true);
    } else {
      const status = info.authenticated ? `authenticated${info.email ? ` (${visible.email})` : ""}` : "not authenticated";
      process.stdout.write(`Account:   ${formatAccountRef(info.engine, info.id)}\n`);
      process.stdout.write(`Status:    ${status}\n`);
      process.stdout.write(`Directory: ${info.dir}\n`);
    }
    if (!info.authenticated) {
      process.exitCode = 1;
    }
  });

accountCommand
  .command("login")
  .description("Launch the engine's interactive login for an account.")
  .argument("<account-ref>", "Account reference such as agy:account-01 or codex:02.")
  .option("--state-dir <path>", "State directory containing accounts.", defaultStateDir())
  .option("--agy-bin <path>", "Explicit path to the agy executable.")
  .option("--claude-bin <path>", "Explicit path to the claude executable.")
  .option("--codex-bin <path>", "Explicit path to the codex executable.")
  .action(async (accountRef: string, options: {
    stateDir: string;
  } & BinaryOptions) => {
    const stateDir = path.resolve(process.cwd(), options.stateDir);
    const parsed = parseAccountRef(accountRef, "agy");
    const binary =
      parsed.engine === "agy"
        ? options.agyBin ?? process.env.AGY_BIN ?? "agy"
        : parsed.engine === "claude"
          ? options.claudeBin ?? process.env.CLAUDE_BIN ?? "claude"
          : options.codexBin ?? process.env.CODEX_BIN ?? "codex";

    process.stdout.write(
      `Starting interactive ${parsed.engine} login for '${formatAccountRef(parsed.engine, parsed.id)}'...\n`
    );
    process.stdout.write(`Complete authentication in your terminal or browser if prompted.\n\n`);

    const code = await launchEngineLogin(parsed.engine, parsed.id, { stateDir, binary });
    if (code === 0) {
      const info = await resolveAccountStatus(stateDir, `${parsed.engine}:${parsed.id}`);
      if (info.authenticated) {
        process.stdout.write(`\nAccount '${formatAccountRef(parsed.engine, parsed.id)}' is authenticated.\n`);
      } else {
        process.stdout.write(
          `\nLogin process exited, but no credentials were detected in ${info.dir}.\n`
        );
      }
    }
    process.exitCode = code;
  });

accountCommand
  .command("migrate")
  .description("Copy legacy flat agy accounts into the engine-scoped layout.")
  .option("--state-dir <path>", "State directory containing accounts.", defaultStateDir())
  .option("--from <path>", "Legacy accounts root (defaults to <state-dir>/accounts).")
  .option("--dry-run", "Show the migration plan without copying.")
  .option("--json", "Print JSON output.")
  .action(async (options: {
    stateDir: string;
    from?: string;
    dryRun?: boolean;
    json?: boolean;
  }) => {
    const stateDir = path.resolve(process.cwd(), options.stateDir);
    const fromDir = options.from ? path.resolve(process.cwd(), options.from) : undefined;
    let result;
    if (options.dryRun) {
      result = {
        plan: await planLegacyAgyMigration(stateDir, fromDir),
        copied: [] as string[]
      };
    } else {
      result = await migrateLegacyAgyAccounts(stateDir, { fromDir });
    }

    if (options.json) {
      printResult(result, true);
      return;
    }
    if (result.plan.length === 0) {
      process.stdout.write("No legacy agy accounts found.\n");
      return;
    }
    for (const item of result.plan) {
      const suffix = item.reason ? ` (${item.reason})` : "";
      process.stdout.write(`${item.action}: ${item.source} -> ${item.target}${suffix}\n`);
    }
    if (!options.dryRun) {
      process.stdout.write(`\nCopied ${result.copied.length} account(s). Originals were not modified.\n`);
    }
  });

accountCommand
  .command("prune")
  .description("Remove one account profile after an explicit confirmation.")
  .argument("<account-ref>", "Account reference such as claude:03.")
  .option("--state-dir <path>", "State directory containing accounts.", defaultStateDir())
  .option("--yes", "Confirm removal without an interactive prompt.")
  .option("--json", "Print JSON output.")
  .action(async (accountRef: string, options: {
    stateDir: string;
    yes?: boolean;
    json?: boolean;
  }) => {
    if (!options.yes) {
      throw new Error("Refusing to remove an account without --yes. Inspect it first with 'account status'.");
    }
    const stateDir = path.resolve(process.cwd(), options.stateDir);
    const parsed = parseAccountRef(accountRef, "agy");
    const target = accountDir(stateDir, parsed.engine, parsed.id);
    const root = engineAccountsDir(stateDir, parsed.engine);
    if (path.resolve(target) === path.resolve(root)) {
      throw new Error("Refusing to remove the shared account root.");
    }
    await fs.rm(target, { recursive: true, force: false });
    const result = { removed: formatAccountRef(parsed.engine, parsed.id), directory: target };
    printResult(result, Boolean(options.json));
  });

accountCommand
  .command("clean")
  .description("Remove stored session history while keeping authentication.")
  .argument("<account-ref>", "Account reference such as claude:03 or codex:02.")
  .option("--state-dir <path>", "State directory containing accounts.", defaultStateDir())
  .option("--sessions", "Remove the engine's session history directory.")
  .option("--json", "Print JSON output.")
  .action(async (accountRef: string, options: {
    stateDir: string;
    sessions?: boolean;
    json?: boolean;
  }) => {
    if (!options.sessions) {
      throw new Error("Specify what to clean, for example --sessions.");
    }
    const stateDir = path.resolve(process.cwd(), options.stateDir);
    const parsed = parseAccountRef(accountRef, "agy");
    const dir = accountDir(stateDir, parsed.engine, parsed.id);
    const targets =
      parsed.engine === "claude"
        ? [path.join(dir, "projects"), path.join(dir, "todos")]
        : parsed.engine === "codex"
          ? [path.join(dir, "sessions"), path.join(dir, "log")]
          : [path.join(dir, ".gemini", "antigravity-cli", "brain")];

    const removed: string[] = [];
    for (const target of targets) {
      if (await pathExists(target)) {
        await fs.rm(target, { recursive: true, force: true });
        removed.push(target);
      }
    }
    printResult(
      { account: formatAccountRef(parsed.engine, parsed.id), removed },
      Boolean(options.json)
    );
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
