import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { getAccountInfo, launchInteractiveLogin } from "./agents/agy.js";
import { accountsDir, engineAccountsDir } from "./schema.js";
import type { AccountInfo, EngineName } from "./types.js";

const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ENGINES: EngineName[] = ["agy", "claude", "codex"];
export const DEFAULT_MAX_ACCOUNTS_PER_ENGINE = 20;

export interface AccountTarget {
  id: string | null;
  dir: string | null;
}

export interface AccountHealthEntry {
  lastUsedAt?: string | null;
  cooldownUntil?: string | null;
  authStatus?: "ok" | "auth_required" | "unknown";
  lastError?: string | null;
}

export type AccountHealth = Record<string, AccountHealthEntry>;

export function isEngineName(value: string): value is EngineName {
  return (ENGINES as string[]).includes(value);
}

export function validateAccountId(id: string): string {
  if (!ACCOUNT_ID_RE.test(id)) {
    throw new Error(
      `Invalid account id '${id}'. Use lowercase letters, digits, '_' or '-', starting with a letter or digit (max 32 chars).`
    );
  }
  return id;
}

export function parseAccountRef(ref: string, defaultEngine: EngineName): { engine: EngineName; id: string } {
  const trimmed = ref.trim();
  const match = /^(agy|claude|codex):(.+)$/.exec(trimmed);
  if (match) {
    const engine = match[1] as EngineName;
    return { engine, id: validateAccountId(match[2]!) };
  }
  return { engine: defaultEngine, id: validateAccountId(trimmed) };
}

export function formatAccountRef(engine: EngineName, id: string): string {
  return `${engine}:${id}`;
}

export function accountDir(stateDir: string, engine: EngineName, id: string): string {
  if (path.isAbsolute(id)) {
    return path.resolve(id);
  }
  return path.join(engineAccountsDir(stateDir, engine), id);
}

export function legacyAccountDir(stateDir: string, id: string): string {
  return path.join(accountsDir(stateDir), id);
}

export function maskEmail(email: string | null | undefined): string | null {
  if (!email) {
    return null;
  }
  const at = email.indexOf("@");
  if (at <= 0) {
    return "***";
  }
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

async function readDirSafe(target: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await fs.readdir(target, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function detectClaudeAuth(dir: string): Promise<boolean> {
  for (const name of [".claude.json", "auth.json", "credentials.json"]) {
    if (await fileExists(path.join(dir, name))) {
      return true;
    }
  }
  return false;
}

async function detectCodexAuth(dir: string): Promise<boolean> {
  const authPath = path.join(dir, "auth.json");
  try {
    const raw = await fs.readFile(authPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

async function detectAgyAuth(dir: string, stateDir: string): Promise<{ authenticated: boolean; email: string | null }> {
  const info = await getAccountInfo(dir, stateDir);
  return { authenticated: info.authenticated, email: info.email };
}

export function healthPath(stateDir: string): string {
  return path.join(stateDir, "account-health.json");
}

export async function loadAccountHealth(stateDir: string): Promise<AccountHealth> {
  try {
    const raw = await fs.readFile(healthPath(stateDir), "utf8");
    const parsed = JSON.parse(raw) as AccountHealth;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const healthQueues = new Map<string, Promise<void>>();

export async function saveAccountHealth(stateDir: string, health: AccountHealth): Promise<void> {
  const target = healthPath(stateDir);
  const key = path.resolve(target);
  const previous = healthQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    await fs.mkdir(stateDir, { recursive: true });
    const temp = `${target}.tmp.${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await fs.writeFile(temp, `${JSON.stringify(health, null, 2)}\n`, "utf8");
    try {
      await fs.rename(temp, target);
    } catch {
      await fs.copyFile(temp, target);
      await fs.unlink(temp).catch(() => {});
    }
  });
  healthQueues.set(key, next);
  try {
    await next;
  } finally {
    if (healthQueues.get(key) === next) {
      healthQueues.delete(key);
    }
  }
}

async function updateHealth(
  stateDir: string,
  engine: EngineName,
  id: string,
  patch: Partial<AccountHealthEntry>
): Promise<void> {
  const health = await loadAccountHealth(stateDir);
  const key = formatAccountRef(engine, id);
  health[key] = { ...(health[key] ?? {}), ...patch };
  await saveAccountHealth(stateDir, health);
}

export async function recordAccountUse(stateDir: string, engine: EngineName, id: string): Promise<void> {
  await updateHealth(stateDir, engine, id, {
    lastUsedAt: new Date().toISOString(),
    authStatus: "ok",
    lastError: null
  });
}

export async function recordAccountCooldown(
  stateDir: string,
  engine: EngineName,
  id: string,
  minutes: number,
  error: string
): Promise<void> {
  const until = new Date(Date.now() + Math.max(1, minutes) * 60_000).toISOString();
  await updateHealth(stateDir, engine, id, {
    cooldownUntil: until,
    lastError: error
  });
}

export async function recordAccountAuthRequired(
  stateDir: string,
  engine: EngineName,
  id: string,
  error: string
): Promise<void> {
  await updateHealth(stateDir, engine, id, {
    authStatus: "auth_required",
    lastError: error
  });
}

export function isCoolingDown(entry: AccountHealthEntry | undefined, now = Date.now()): boolean {
  if (!entry?.cooldownUntil) {
    return false;
  }
  const until = Date.parse(entry.cooldownUntil);
  return Number.isFinite(until) && until > now;
}

function sortAccountIds(ids: string[]): string[] {
  return [...ids].sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
}

async function listAgyLegacyIds(stateDir: string): Promise<string[]> {
  const entries = await readDirSafe(accountsDir(stateDir));
  return sortAccountIds(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !ENGINES.includes(name as EngineName))
  );
}

async function listEngineIds(stateDir: string, engine: EngineName): Promise<{ ids: string[]; legacy: boolean }> {
  const entries = await readDirSafe(engineAccountsDir(stateDir, engine));
  const ids = sortAccountIds(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  if (ids.length > 0) {
    return { ids, legacy: false };
  }
  if (engine === "agy") {
    const legacy = await listAgyLegacyIds(stateDir);
    if (legacy.length > 0) {
      return { ids: legacy, legacy: true };
    }
  }
  return { ids: [], legacy: false };
}

export async function getEngineAccountInfo(
  stateDir: string,
  engine: EngineName,
  id: string,
  options: { useLegacy?: boolean } = {}
): Promise<AccountInfo> {
  const dir = options.useLegacy ? legacyAccountDir(stateDir, id) : accountDir(stateDir, engine, id);
  const health = await loadAccountHealth(stateDir);
  const entry = health[formatAccountRef(engine, id)] ?? {};

  if (engine === "agy") {
    const info = await detectAgyAuth(dir, stateDir);
    return {
      id,
      engine,
      dir,
      authenticated: info.authenticated,
      email: info.email,
      maskedEmail: maskEmail(info.email),
      lastUsedAt: entry.lastUsedAt ?? null,
      cooldownUntil: entry.cooldownUntil ?? null,
      authStatus: entry.authStatus ?? "unknown",
      lastError: entry.lastError ?? null
    };
  }

  const authenticated = engine === "claude" ? await detectClaudeAuth(dir) : await detectCodexAuth(dir);
  return {
    id,
    engine,
    dir,
    authenticated,
    email: null,
    maskedEmail: null,
    lastUsedAt: entry.lastUsedAt ?? null,
    cooldownUntil: entry.cooldownUntil ?? null,
    authStatus: entry.authStatus ?? "unknown",
    lastError: entry.lastError ?? null
  };
}

export async function listEngineAccounts(
  stateDir: string,
  engine: EngineName,
  maxAccountsPerEngine = DEFAULT_MAX_ACCOUNTS_PER_ENGINE
): Promise<AccountInfo[]> {
  const { ids, legacy } = await listEngineIds(stateDir, engine);
  const accounts: AccountInfo[] = [];
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index]!;
    const info = await getEngineAccountInfo(stateDir, engine, id, { useLegacy: legacy });
    accounts.push({
      ...info,
      ignored: index >= Math.max(1, maxAccountsPerEngine)
    });
  }
  return accounts;
}

export async function resolveAccountTargets(
  stateDir: string,
  engine: EngineName,
  requested: string | null | undefined,
  maxAccountsPerEngine = DEFAULT_MAX_ACCOUNTS_PER_ENGINE
): Promise<AccountTarget[]> {
  if (requested && requested.trim()) {
    const trimmed = requested.trim();
    if (path.isAbsolute(trimmed)) {
      return [{ id: path.basename(trimmed), dir: path.resolve(trimmed) }];
    }
    const parsed = parseAccountRef(trimmed, engine);
    if (parsed.engine !== engine) {
      throw new Error(`Account '${requested}' belongs to engine '${parsed.engine}', not '${engine}'.`);
    }
    return [{ id: parsed.id, dir: accountDir(stateDir, engine, parsed.id) }];
  }

  const accounts = await listEngineAccounts(stateDir, engine, maxAccountsPerEngine);
  const usable = accounts
    .filter((account) => !account.ignored && account.authenticated && !isCoolingDown(account))
    .sort((left, right) => {
      const leftTime = left.lastUsedAt ? Date.parse(left.lastUsedAt) : 0;
      const rightTime = right.lastUsedAt ? Date.parse(right.lastUsedAt) : 0;
      return leftTime - rightTime || left.id.localeCompare(right.id, undefined, { numeric: true });
    });

  if (usable.length > 0) {
    return usable.map((account) => ({ id: account.id, dir: account.dir }));
  }

  return [{ id: null, dir: null }];
}

export async function launchEngineLogin(
  engine: EngineName,
  accountId: string,
  options: {
    stateDir: string;
    binary?: string;
    env?: NodeJS.ProcessEnv;
  }
): Promise<number> {
  const id = validateAccountId(accountId);
  const dir = accountDir(options.stateDir, engine, id);
  await fs.mkdir(dir, { recursive: true });

  if (engine === "agy") {
    return launchInteractiveLogin(dir, options.binary, options.stateDir);
  }

  const binary = options.binary || (engine === "claude" ? process.env.CLAUDE_BIN : process.env.CODEX_BIN) || engine;
  const args = engine === "claude" ? ["auth", "login"] : ["login"];
  const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) };
  if (engine === "claude") {
    env.CLAUDE_CONFIG_DIR = dir;
  } else {
    env.CODEX_HOME = dir;
  }

  return new Promise<number>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: dir,
      env,
      stdio: "inherit",
      windowsHide: true,
      shell: needsShell(binary)
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });
}

function needsShell(binary: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  return /\.(cmd|bat)$/i.test(binary);
}

export interface MigrationPlan {
  source: string;
  target: string;
  accountId: string;
  action: "copy" | "skip";
  reason?: string;
}

export async function planLegacyAgyMigration(stateDir: string, fromDir?: string): Promise<MigrationPlan[]> {
  const sourceRoot = fromDir ? path.resolve(fromDir) : accountsDir(stateDir);
  const entries = await readDirSafe(sourceRoot);
  const ids = sortAccountIds(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !ENGINES.includes(name as EngineName))
  );

  return ids.map((id) => {
    const numeric = /^account-(\d+)$/.exec(id);
    const targetId = numeric ? `account-${numeric[1]!.padStart(2, "0")}` : id;
    const target = path.join(engineAccountsDir(stateDir, "agy"), targetId);
    return {
      source: path.join(sourceRoot, id),
      target,
      accountId: targetId,
      action: "copy" as const
    };
  });
}

export async function migrateLegacyAgyAccounts(
  stateDir: string,
  options: { fromDir?: string | undefined; dryRun?: boolean } = {}
): Promise<{ plan: MigrationPlan[]; copied: string[] }> {
  const plan = await planLegacyAgyMigration(stateDir, options.fromDir);
  const copied: string[] = [];

  for (const item of plan) {
    if (await fileExists(item.target)) {
      item.action = "skip";
      item.reason = "target already exists";
      continue;
    }
    if (options.dryRun) {
      continue;
    }
    await fs.mkdir(path.dirname(item.target), { recursive: true });
    await fs.cp(item.source, item.target, { recursive: true, force: false, errorOnExist: false });
    copied.push(item.accountId);
  }

  return { plan, copied };
}
