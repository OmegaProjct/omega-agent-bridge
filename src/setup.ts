import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  listEngineAccounts,
  migrateLegacyAgyAccounts,
  planLegacyAgyMigration,
  type MigrationPlan
} from "./accounts.js";
import { launchEngineLogin } from "./accounts.js";
import {
  DEFAULT_CONFIG,
  configPath,
  loadConfig,
  saveConfig,
  type BridgeConfig,
  type EngineConfig
} from "./config.js";
import { defaultStateDir, engineAccountsDir } from "./schema.js";
import type { AccountInfo, EngineName } from "./types.js";

export const ENGINES: EngineName[] = ["agy", "claude", "codex"];

export interface EngineDetection {
  engine: EngineName;
  found: boolean;
  binary: string;
  version: string | null;
  source: "override" | "config" | "env" | "path" | "candidate" | "missing";
  error: string | null;
}

export interface SetupOptions {
  stateDir?: string;
  engine?: EngineName | undefined;
  dryRun?: boolean;
  noLogin?: boolean;
  migrateLegacy?: boolean;
  json?: boolean;
  binaries?: Partial<Record<EngineName, string | undefined>>;
  maxAccountsPerEngine?: number;
  login?: boolean;
  cwd?: string;
}

export interface SetupEngineResult {
  engine: EngineName;
  selected: boolean;
  detected: EngineDetection;
  account: AccountInfo | null;
  loginStarted: boolean;
  loginExitCode: number | null;
  loginCommand: string;
}

export interface SetupResult {
  ok: boolean;
  dryRun: boolean;
  stateDir: string;
  stateDirOutsideRepository: boolean;
  configPath: string;
  engines: SetupEngineResult[];
  migration: MigrationPlan[];
  migrated: string[];
  warnings: string[];
  nextSteps: string[];
}

function needsShell(binary: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(binary);
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function engineCandidates(engine: EngineName): string[] {
  const home = os.homedir();
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    const names = engine === "agy"
      ? ["agy.exe", "agy.cmd", "agy.bat"]
      : engine === "claude"
        ? ["claude.exe", "claude.cmd", "claude.bat"]
        : ["codex.exe", "codex.cmd", "codex.bat"];
    const roots = engine === "codex"
      ? [path.join(localAppData, "Programs", "codex"), path.join(appData, "npm"), path.join(home, ".local", "bin")]
      : engine === "claude"
        ? [path.join(localAppData, "Programs", "claude"), path.join(appData, "npm"), path.join(home, ".local", "bin")]
        : [path.join(localAppData, "Programs", "agy"), path.join(appData, "npm"), path.join(home, ".local", "bin")];
    return roots.flatMap((root) => names.map((name) => path.join(root, name)));
  }
  return ["/usr/local/bin", "/opt/homebrew/bin", path.join(home, ".local", "bin")]
    .map((root) => path.join(root, engine));
}

export async function captureVersion(binary: string, timeoutMs = 10_000): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      resolve(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, ["--version"], {
        windowsHide: true,
        shell: needsShell(binary),
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      resolve(null);
      return;
    }

    let output = "";
    const deadline = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      finish(null);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      const line = output.split(/\r?\n/).map((value) => value.trim()).find(Boolean) ?? null;
      finish(code === 0 ? line?.slice(0, 160) ?? null : null);
    });
  });
}

async function tryDetection(
  engine: EngineName,
  binary: string,
  source: EngineDetection["source"]
): Promise<EngineDetection | null> {
  const version = await captureVersion(binary);
  if (!version) {
    return null;
  }
  return { engine, found: true, binary, version, source, error: null };
}

export async function detectEngine(
  engine: EngineName,
  config: BridgeConfig,
  overrides: Partial<Record<EngineName, string | undefined>> = {}
): Promise<EngineDetection> {
  const configured = overrides[engine] ?? config.engines[engine]?.binary ?? undefined;
  const envName = engine === "agy" ? "AGY_BIN" : engine === "claude" ? "CLAUDE_BIN" : "CODEX_BIN";
  const fromEnv = process.env[envName]?.trim();

  const explicit = [
    { binary: overrides[engine], source: "override" as const },
    { binary: config.engines[engine]?.binary, source: "config" as const },
    { binary: fromEnv, source: "env" as const }
  ].filter((entry): entry is { binary: string; source: "override" | "config" | "env" } => Boolean(entry.binary && entry.binary.trim()));

  for (const entry of explicit) {
    const detection = await tryDetection(engine, entry.binary.trim(), entry.source);
    if (detection) {
      return detection;
    }
  }

  const onPath = await tryDetection(engine, engine, "path");
  if (onPath) {
    return onPath;
  }

  for (const candidate of engineCandidates(engine)) {
    if (!(await fileExists(candidate))) {
      continue;
    }
    const detection = await tryDetection(engine, candidate, "candidate");
    if (detection) {
      return detection;
    }
  }

  const fallbackBinary = configured?.trim() || fromEnv || engine;
  return {
    engine,
    found: false,
    binary: fallbackBinary,
    version: null,
    source: "missing",
    error: `${engine} was not found on PATH or in the known install locations.`
  };
}

function selectedEngines(options: SetupOptions): EngineName[] {
  return options.engine ? [options.engine] : ENGINES;
}

function firstAccountId(accounts: AccountInfo[]): string {
  const sorted = [...accounts].sort((left, right) =>
    left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: "base" })
  );
  return sorted[0]?.id ?? "account-01";
}

function loginCommandFor(engine: EngineName, id: string): string {
  return `omega-agent-bridge account login ${engine}:${id}`;
}

function redactAccount(account: AccountInfo): AccountInfo {
  return {
    ...account,
    email: account.maskedEmail ?? null
  };
}

export async function runSetup(options: SetupOptions = {}): Promise<SetupResult> {
  const stateDir = path.resolve(options.stateDir ?? defaultStateDir());
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const config = await loadConfig(stateDir);
  const selected = selectedEngines(options);
  const warnings: string[] = [];
  const stateDirOutsideRepository = !isInside(cwd, stateDir);

  if (!stateDirOutsideRepository) {
    warnings.push(
      `The state directory is inside the current repository (${stateDir}). Move it outside before committing anything.`
    );
  }

  const detections: EngineDetection[] = [];
  for (const engine of selected) {
    detections.push(await detectEngine(engine, config, options.binaries ?? {}));
  }

  if (!options.dryRun) {
    await fs.mkdir(stateDir, { recursive: true });
    for (const engine of selected) {
      await fs.mkdir(engineAccountsDir(stateDir, engine), { recursive: true });
    }
  }

  const nextConfig: BridgeConfig = {
    ...config,
    engines: {
      agy: { ...config.engines.agy },
      claude: { ...config.engines.claude },
      codex: { ...config.engines.codex }
    }
  };
  if (options.maxAccountsPerEngine !== undefined) {
    nextConfig.maxAccountsPerEngine = options.maxAccountsPerEngine;
  }

  const engineResults: SetupEngineResult[] = [];
  for (const detection of detections) {
    const engine = detection.engine;
    const engineConfig: EngineConfig = {
      enabled: detection.found,
      binary: detection.found && detection.source === "candidate" ? detection.binary : config.engines[engine].binary
    };
    nextConfig.engines[engine] = engineConfig;

    const accounts = options.dryRun ? [] : await listEngineAccounts(stateDir, engine, nextConfig.maxAccountsPerEngine);
    let account = accounts.find((candidate) => candidate.authenticated) ?? accounts[0] ?? null;
    let loginStarted = false;
    let loginExitCode: number | null = null;
    const accountId = account?.id ?? firstAccountId(accounts);

    if (!options.dryRun && !options.noLogin && options.login !== false && detection.found && !account?.authenticated) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        loginStarted = true;
        try {
          const code = await launchEngineLogin(engine, accountId, {
            stateDir,
            binary: detection.binary
          });
          loginExitCode = code;
          const refreshed = await listEngineAccounts(stateDir, engine, nextConfig.maxAccountsPerEngine);
          account = refreshed.find((candidate) => candidate.id === accountId) ?? account;
          if (!account?.authenticated) {
            warnings.push(`${engine}:${accountId} did not authenticate successfully (exit code ${code}).`);
          }
        } catch (error) {
          warnings.push(
            `${engine}: interactive login failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      } else {
        warnings.push(
          `${engine}: interactive login needs a terminal. Run '${loginCommandFor(engine, accountId)}' yourself.`
        );
      }
    }

    if (detection.found && !account) {
      warnings.push(`${engine}: no account profile created yet. Run '${loginCommandFor(engine, accountId)}'.`);
    }
    if (!detection.found) {
      warnings.push(`${engine}: ${detection.error}`);
    }

    engineResults.push({
      engine,
      selected: true,
      detected: detection,
      account: account ? redactAccount(account) : null,
      loginStarted,
      loginExitCode,
      loginCommand: loginCommandFor(engine, accountId)
    });
  }

  if (!options.dryRun) {
    await saveConfig(stateDir, nextConfig);
  }

  let migration: MigrationPlan[] = [];
  let migrated: string[] = [];
  if (options.migrateLegacy) {
    migration = await planLegacyAgyMigration(stateDir);
    if (!options.dryRun) {
      const result = await migrateLegacyAgyAccounts(stateDir);
      migration = result.plan;
      migrated = result.copied;
    }
  }

  const usable = engineResults.filter(
    (result) => result.detected.found && (options.dryRun || result.account?.authenticated)
  );

  const nextSteps = [
    "omega-agent-bridge doctor --json",
    "omega-agent-bridge account list --json",
    "omega-agent-bridge run --spec ./task.spec.json --plan-only --json"
  ];

  return {
    ok: options.dryRun ? engineResults.some((result) => result.detected.found) : usable.length > 0,
    dryRun: Boolean(options.dryRun),
    stateDir,
    stateDirOutsideRepository,
    configPath: configPath(stateDir),
    engines: engineResults,
    migration,
    migrated,
    warnings,
    nextSteps
  };
}

export interface DoctorCheck {
  id: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  stateDir: string;
  checks: DoctorCheck[];
  accounts: AccountInfo[];
}

export async function runDoctor(
  options: {
    stateDir?: string;
    binaries?: Partial<Record<EngineName, string | undefined>>;
    engine?: EngineName | undefined;
  } = {}
): Promise<DoctorResult> {
  const stateDir = path.resolve(options.stateDir ?? defaultStateDir());
  const checks: DoctorCheck[] = [];
  const accounts: AccountInfo[] = [];

  checks.push({ id: "bridge", status: "ok", detail: "omega-agent-bridge CLI is running." });

  let stateWritable = false;
  try {
    await fs.mkdir(stateDir, { recursive: true });
    const probe = path.join(stateDir, `.doctor-${Date.now()}.tmp`);
    await fs.writeFile(probe, "ok", "utf8");
    await fs.unlink(probe);
    stateWritable = true;
  } catch (error) {
    checks.push({
      id: "state_dir",
      status: "fail",
      detail: `State directory is not writable: ${error instanceof Error ? error.message : String(error)}`
    });
  }
  if (stateWritable) {
    checks.push({ id: "state_dir", status: "ok", detail: `${stateDir} is writable.` });
    if (isInside(process.cwd(), stateDir)) {
      checks.push({
        id: "state_dir_location",
        status: "warn",
        detail: "State directory is inside the current working directory. Keep it outside the repository."
      });
    } else {
      checks.push({
        id: "state_dir_location",
        status: "ok",
        detail: "State directory is outside the current working directory."
      });
    }
  }

  const configExists = await fileExists(configPath(stateDir));
  const config = await loadConfig(stateDir);
  checks.push({
    id: "config",
    status: configExists ? "ok" : "warn",
    detail: configExists
      ? `${configPath(stateDir)} loaded.`
      : `${configPath(stateDir)} does not exist yet; defaults are in use. Run 'omega-agent-bridge setup'.`
  });

  const engines = options.engine ? [options.engine] : ENGINES;
  let usable = 0;

  for (const engine of engines) {
    const detection = await detectEngine(engine, config, options.binaries ?? {});
    if (!detection.found) {
      checks.push({ id: `engine:${engine}`, status: "warn", detail: detection.error ?? "Not found." });
      continue;
    }
    checks.push({
      id: `engine:${engine}`,
      status: "ok",
      detail: `${detection.version ?? "version unknown"} (${detection.binary}, ${detection.source})`
    });

    const engineAccounts = await listEngineAccounts(stateDir, engine, config.maxAccountsPerEngine);
    accounts.push(...engineAccounts.map(redactAccount));
    const authenticated = engineAccounts.filter((account) => account.authenticated && !account.ignored);
    if (authenticated.length > 0) {
      usable += 1;
      checks.push({
        id: `accounts:${engine}`,
        status: "ok",
        detail: `${authenticated.length} authenticated account(s).`
      });
    } else {
      checks.push({
        id: `accounts:${engine}`,
        status: "warn",
        detail: `No authenticated account. Run '${loginCommandFor(engine, firstAccountId(engineAccounts))}'.`
      });
    }
  }

  return {
    ok: usable > 0,
    stateDir,
    checks,
    accounts
  };
}

export function defaultSetupConfig(): BridgeConfig {
  return structuredClone(DEFAULT_CONFIG);
}
