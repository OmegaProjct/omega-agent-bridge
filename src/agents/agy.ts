import fs from "node:fs/promises";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { extractJsonDocument } from "../json.js";
import { accountsDir } from "../schema.js";
import type { AccountInfo, AgentAdapter, AgentInvocation, AgentResult, AgentRuntime } from "../types.js";
import { readAgyResult, selectHighestEffort, selectStrongestModel } from "./modelSelection.js";
import type { AgyEvent } from "./modelSelection.js";

const execFileAsync = promisify(execFile);

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(1, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m${seconds}s`;
}

function isQuotaExhausted(text: string): boolean {
  return /RESOURCE_EXHAUSTED|quota reached|Resets in/i.test(text);
}

function isEngineScopedAccountDir(accountDir: string): boolean {
  return path.basename(path.dirname(accountDir)) === "agy";
}

async function listEngineScopedAgyAccounts(stateDir?: string): Promise<AccountInfo[]> {
  const root = path.join(accountsDir(stateDir), "agy");
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const results: AccountInfo[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        results.push(await getAccountInfo(path.join(root, entry.name), stateDir));
      }
    }
    return results.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

function parseAccountHomesEnv(rawValue: string | undefined): string[] {
  if (!rawValue) {
    return [];
  }

  const seen = new Set<string>();
  return rawValue
    .split(path.delimiter)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => path.resolve(segment))
    .filter((segment) => {
      if (seen.has(segment)) {
        return false;
      }
      seen.add(segment);
      return true;
    });
}

export async function getAccountInfo(accountId: string, stateDir?: string): Promise<AccountInfo> {
  const accountDir = path.isAbsolute(accountId) ? accountId : path.join(accountsDir(stateDir), accountId);
  const id = path.basename(accountDir);
  const geminiDir = path.join(accountDir, ".gemini");
  const cliDir = path.join(geminiDir, "antigravity-cli");

  let authenticated = false;
  let email: string | null = null;

  for (const dir of [geminiDir, cliDir]) {
    try {
      const credsPath = path.join(dir, "oauth_creds.json");
      const credsStat = await fs.stat(credsPath);
      if (credsStat.isFile()) {
        authenticated = true;
      }
    } catch {
      // not authenticated via oauth_creds.json
    }

    try {
      const googleAccountsPath = path.join(dir, "google_accounts.json");
      const raw = await fs.readFile(googleAccountsPath, "utf8");
      const parsed = JSON.parse(raw) as { active?: string };
      if (parsed.active) {
        email = parsed.active;
        authenticated = true;
      }
    } catch {
      // google_accounts.json might not exist
    }
  }

  try {
    const onboardingPath = path.join(cliDir, "cache", "onboarding.json");
    const rawOnboarding = await fs.readFile(onboardingPath, "utf8");
    const parsed = JSON.parse(rawOnboarding) as { onboardingComplete?: boolean; consumerOnboardingComplete?: boolean };
    if (parsed.onboardingComplete || parsed.consumerOnboardingComplete) {
      authenticated = true;
    }
  } catch {
    // onboarding.json might not exist
  }

  try {
    const logPath = path.join(cliDir, "cli.log");
    const logContent = await fs.readFile(logPath, "utf8");
    const emailMatches = [...logContent.matchAll(/authenticated successfully as ([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)/g)];
    if (emailMatches.length > 0) {
      const lastMatch = emailMatches[emailMatches.length - 1];
      if (lastMatch && lastMatch[1]) {
        email = lastMatch[1];
        authenticated = true;
      }
    } else if (/keyringAuth: loaded token/i.test(logContent) || /ChainedAuth: authenticated/i.test(logContent)) {
      authenticated = true;
    }
  } catch {
    // cli.log might not exist
  }

  return {
    id,
    engine: "agy",
    dir: accountDir,
    authenticated,
    email
  };
}

export async function listConfiguredAccounts(stateDir?: string): Promise<AccountInfo[]> {
  const scoped = await listEngineScopedAgyAccounts(stateDir);
  if (scoped.length > 0) {
    return scoped;
  }

  const root = accountsDir(stateDir);
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const subdirs = entries.filter((e) => e.isDirectory() && e.name !== "agy" && e.name !== "claude" && e.name !== "codex");
    const results: AccountInfo[] = [];
    for (const subdir of subdirs) {
      results.push(await getAccountInfo(subdir.name, stateDir));
    }
    return results.sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

export async function launchInteractiveLogin(
  accountId: string,
  binary: string = process.env.AGY_BIN || "agy",
  stateDir?: string
): Promise<number> {
  const accountDir = path.isAbsolute(accountId) ? accountId : path.join(accountsDir(stateDir), accountId);
  await fs.mkdir(accountDir, { recursive: true });

  const env = applyAccountHomeToEnv(process.env, accountDir);

  return new Promise<number>((resolve, reject) => {
    const child = spawn(binary, [], {
      cwd: accountDir,
      env,
      windowsHide: true,
      stdio: "inherit",
      shell: process.platform === "win32"
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolve(code ?? 0));
  });
}

export async function resolveAccountHomes(requestedAccount?: string | null, stateDir?: string): Promise<Array<string | null>> {
  if (requestedAccount && requestedAccount.trim()) {
    const trimmed = requestedAccount.trim();
    if (path.isAbsolute(trimmed)) {
      return [trimmed];
    }
    const scoped = path.join(accountsDir(stateDir), "agy", trimmed);
    try {
      await fs.access(scoped);
      return [scoped];
    } catch {
      return [path.join(accountsDir(stateDir), trimmed)];
    }
  }

  const explicitHomes = parseAccountHomesEnv(process.env.OMEGA_AGENT_BRIDGE_ACCOUNT_HOMES);
  if (explicitHomes.length > 0) {
    return explicitHomes;
  }

  const singleHome = process.env.OMEGA_AGENT_BRIDGE_ACCOUNT_HOME?.trim();
  if (singleHome) {
    return [path.resolve(singleHome)];
  }

  const accounts = await listConfiguredAccounts(stateDir);
  if (accounts.length > 0) {
    return accounts.map((acc) => acc.dir);
  }

  return [null];
}

function applyAccountHomeToEnv(baseEnv: NodeJS.ProcessEnv, accountHome: string | null): NodeJS.ProcessEnv {
  if (!accountHome) {
    return { ...baseEnv };
  }

  const childEnv = { ...baseEnv };
  const resolvedAccountHome = path.resolve(accountHome);
  const drive = path.parse(resolvedAccountHome).root.replace(/[\\\/]+$/, "");
  const homePath = resolvedAccountHome.slice(drive.length) || "\\";
  childEnv.USERPROFILE = resolvedAccountHome;
  childEnv.HOME = resolvedAccountHome;
  childEnv.HOMEDRIVE = drive;
  childEnv.HOMEPATH = homePath;
  childEnv.GEMINI_DIR = path.join(resolvedAccountHome, ".gemini");
  return childEnv;
}

async function runAgyOnce(
  binary: string,
  invocation: AgentInvocation,
  startedAt: number,
  accountHome: string | null
): Promise<AgentResult> {
  const env = applyAccountHomeToEnv(process.env, accountHome);
  const probeOptions = { cwd: invocation.workspace, env, timeout: Math.min(invocation.timeoutMs, 20000), maxBuffer: 1024 * 1024, windowsHide: true };
  const catalog = await execFileAsync(binary, ["models"], probeOptions);
  const selectedModel = selectStrongestModel(catalog.stdout, invocation.model, new Date(), invocation.geminiOnly ?? false);
  const effortProbe = await execFileAsync(binary, ["--model", selectedModel, "--print", "/effort", "--output-format", "json", "--log-file", `${invocation.logPath}.effort`], probeOptions);
  const selectedEffort = selectHighestEffort(effortProbe.stdout, invocation.effort ?? "highest");
  if (selectedEffort.adjustable) {
    const confirmation = await execFileAsync(binary, ["--model", selectedModel, "--effort", selectedEffort.effort, "--print", "/effort", "--output-format", "json", "--log-file", `${invocation.logPath}.effort-confirm`], probeOptions);
    const current = JSON.parse(confirmation.stdout) as { status?: string; command?: { name?: string; data?: { current?: string } } };
    if (current.status !== "SUCCESS" || current.command?.name !== "effort" || current.command.data?.current !== selectedEffort.effort) {
      throw new Error("CLI did not confirm the highest requested effort; refusing to run.");
    }
  }
  const runtime: AgentRuntime = {
    requestedModel: invocation.model ?? "strongest",
    requestedEffort: invocation.effort ?? "highest",
    selectedModel,
    effectiveModel: null,
    effectiveEffort: selectedEffort.effort,
    effortAdjustable: selectedEffort.adjustable,
    verified: false,
    account: accountHome ? path.basename(accountHome) : null
  };
  const args = [
    "--print",
    invocation.prompt,
    "--print-timeout",
    formatDuration(invocation.timeoutMs),
    "--log-file",
    invocation.logPath,
    "--output-format",
    "stream-json",
    "--add-dir",
    path.resolve(invocation.workspace)
  ];

  args.push("--model", selectedModel);
  if (selectedEffort.adjustable) args.push("--effort", selectedEffort.effort);

  if (invocation.autoApprove) {
    args.push("--dangerously-skip-permissions");
  }

  return new Promise<AgentResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: invocation.workspace,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let pending = "";
    let protocolError: string | null = null;
    const deadline = setTimeout(() => { protocolError = "Agent process exceeded the invocation timeout."; child.kill(); }, invocation.timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      pending += text;
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as AgyEvent;
          if (event.event === "init" && event.init?.model !== selectedModel) {
            runtime.effectiveModel = event.init?.model ?? null;
            protocolError = `CLI selected ${runtime.effectiveModel ?? "an unknown model"} instead of ${selectedModel}; stopped.`;
            child.kill();
          }
        } catch {
          protocolError = "Invalid structured CLI output; stopped before accepting an unverified result.";
          child.kill();
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });

    child.on("close", (code) => {
      const durationMs = Date.now() - startedAt;
      clearTimeout(deadline);
      let rawOutput = "";
      try {
        const parsed = readAgyResult(stdout, runtime);
        rawOutput = parsed.rawOutput;
        protocolError ??= parsed.error;
      } catch {
        protocolError ??= "Missing or invalid CLI model confirmation; refusing an unverified result.";
      }
      resolve({
        rawOutput,
        combinedOutput: [rawOutput.trim(), stderr.trim(), protocolError].filter(Boolean).join("\n"),
        exitCode: protocolError ? 1 : (code ?? 1),
        durationMs,
        runtime
      });
    });
  });
}

export class AgyAdapter implements AgentAdapter {
  readonly name = "agy" as const;
  private opusQuotaFallback: string | null = null;

  constructor(
    private readonly binary: string = process.env.AGY_BIN || "agy",
    private readonly stateDir?: string
  ) {}

  async run(invocation: AgentInvocation): Promise<AgentResult> {
    const startedAt = Date.now();
    const accountHomes = await resolveAccountHomes(invocation.account, this.stateDir);
    let lastResult: AgentResult | null = null;

    const runAccount = async (accountHome: string | null, request: AgentInvocation): Promise<AgentResult> => {
      try {
        return await runAgyOnce(this.binary, request, startedAt, accountHome);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isQuotaExhausted(message)) throw error;
        return { rawOutput: "", combinedOutput: message, exitCode: 1, durationMs: Date.now() - startedAt };
      }
    };

    if (!this.opusQuotaFallback) {
      for (const accountHome of accountHomes) {
        const result = await runAccount(accountHome, invocation);
        lastResult = result;
        if (result.exitCode === 0 || !isQuotaExhausted(result.combinedOutput)) return result;
        if (result.runtime?.selectedModel.startsWith("claude-opus-")) {
          this.opusQuotaFallback = result.runtime.selectedModel;
        }
      }
    }

    const fallbackFrom = this.opusQuotaFallback;
    if (!fallbackFrom) return lastResult ?? {
      rawOutput: "",
      combinedOutput: "Agent process exited without any output.",
      exitCode: 1,
      durationMs: Date.now() - startedAt
    };

    const fallbackPrompt = "Opus quota was exhausted on the configured accounts. A previous attempt may have completed some work. Inspect the current workspace, preserve existing changes, and continue only remaining work. Do not blindly repeat completed destructive or external actions. All original constraints still apply.\n\n" + invocation.prompt;
    for (const accountHome of accountHomes) {
      const result = await runAccount(accountHome, {
        ...invocation,
        model: "strongest",
        effort: "highest",
        geminiOnly: true,
        prompt: fallbackPrompt
      });
      if (result.runtime) {
        result.runtime.fallbackFrom = fallbackFrom;
        result.runtime.fallbackReason = "opus_quota_exhausted";
      }
      lastResult = result;
      if (result.exitCode === 0 || !isQuotaExhausted(result.combinedOutput)) return result;
    }

    if (lastResult) {
      return lastResult;
    }

    return {
      rawOutput: "",
      combinedOutput: "Agent process exited without any output.",
      exitCode: 1,
      durationMs: Date.now() - startedAt
    };
  }
}

export async function readAgyTranscriptOutput(workspace: string, homeDir: string = os.homedir()): Promise<string> {
  const cliRoot = path.join(homeDir, ".gemini", "antigravity-cli");
  const conversationMapPath = path.join(cliRoot, "cache", "last_conversations.json");

  const conversationMap = JSON.parse(await fs.readFile(conversationMapPath, "utf8")) as Record<string, string>;
  const conversationId = conversationMap[path.resolve(workspace)];
  if (!conversationId) {
    throw new Error(`No Antigravity conversation found for workspace: ${workspace}`);
  }

  const transcriptPath = path.join(
    cliRoot,
    "brain",
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl"
  );
  const rawTranscript = await fs.readFile(transcriptPath, "utf8");
  const lines = rawTranscript
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const parsedEntries = lines.map((line) => JSON.parse(line) as {
    source?: string;
    type?: string;
    content?: string;
  });

  for (let index = parsedEntries.length - 1; index >= 0; index -= 1) {
    const entry = parsedEntries[index];
    if (entry?.source !== "MODEL" || !entry.content) {
      continue;
    }

    try {
      extractJsonDocument(entry.content);
      return entry.content.trim();
    } catch {
      continue;
    }
  }

  const lastModelText = [...parsedEntries].reverse().find((entry) => entry?.source === "MODEL" && entry.content?.trim());
  if (lastModelText?.content) {
    return lastModelText.content.trim();
  }

  throw new Error(`No usable Antigravity transcript content found for workspace: ${workspace}`);
}
