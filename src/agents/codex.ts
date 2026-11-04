import fs from "node:fs/promises";
import path from "node:path";

import {
  recordAccountAuthRequired,
  recordAccountCooldown,
  recordAccountUse,
  resolveAccountTargets,
  type AccountTarget
} from "../accounts.js";
import { defaultStateDir } from "../schema.js";
import type {
  AgentAdapter,
  AgentInvocation,
  AgentResult,
  AgentRuntime,
  EngineCapabilities,
  EngineName
} from "../types.js";
import { defaultProcessRunner, type ProcessRunner } from "./processRunner.js";

export interface CodexAdapterOptions {
  binary?: string;
  stateDir?: string;
  maxAccountsPerEngine?: number;
  cooldownMinutes?: number;
  runner?: ProcessRunner;
}

const CAPABILITIES: EngineCapabilities = {
  readOnlyMode: true,
  structuredOutput: true,
  jsonSchema: true,
  effortControl: true,
  accountIsolation: "state-dir"
};

function isQuotaText(text: string): boolean {
  return /rate.?limit|quota|usage limit|too many requests|429|resource_exhausted/i.test(text);
}

function isAuthText(text: string): boolean {
  return /not logged in|login required|authentication required|unauthorized|401|invalid api key|auth(?:entication)? failed/i.test(text);
}

function mapEffort(effort: string | undefined): string {
  const requested = effort ?? "highest";
  if (requested === "highest" || requested === "max") {
    return "xhigh";
  }
  if (["low", "medium", "high", "xhigh"].includes(requested)) {
    return requested;
  }
  throw new Error(`Codex does not support effort '${requested}'.`);
}

function runtimeFor(
  invocation: AgentInvocation,
  effectiveModel: string | null,
  effort: string,
  account: string | null
): AgentRuntime {
  const selectedModel = invocation.model && invocation.model !== "strongest" ? invocation.model : "cli-default";
  const verified = Boolean(effectiveModel);
  return {
    engine: "codex",
    requestedModel: invocation.model ?? "strongest",
    requestedEffort: invocation.effort ?? "highest",
    selectedModel,
    effectiveModel,
    effectiveEffort: effort,
    effortAdjustable: true,
    effortVerified: false,
    verified,
    readOnlyEnforced: true,
    account
  };
}

function collectStrings(value: unknown, keyNames: Set<string>, out: string[]): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, keyNames, out);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && keyNames.has(key)) {
      out.push(child);
    } else {
      collectStrings(child, keyNames, out);
    }
  }
}

function collectModels(value: unknown, out: string[]): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectModels(item, out);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "model" && typeof child === "string" && child.trim()) {
      out.push(child.trim());
    } else {
      collectModels(child, out);
    }
  }
}

function parseEvents(stdout: string): { events: unknown[]; warnings: string[] } {
  const events: unknown[] = [];
  const warnings: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed) as unknown);
    } catch {
      warnings.push(trimmed);
    }
  }
  return { events, warnings };
}

function lastAssistantText(events: unknown[]): string | null {
  const texts: string[] = [];
  for (const event of events) {
    collectStrings(event, new Set(["text", "message", "content", "output_text"]), texts);
  }
  const nonEmpty = texts.map((text) => text.trim()).filter(Boolean);
  return nonEmpty.length > 0 ? nonEmpty[nonEmpty.length - 1]! : null;
}

export class CodexAdapter implements AgentAdapter {
  readonly name: EngineName = "codex";
  readonly capabilities = CAPABILITIES;

  private readonly binary: string;
  private readonly stateDir: string;
  private readonly maxAccountsPerEngine: number;
  private readonly cooldownMinutes: number;
  private readonly runner: ProcessRunner;

  constructor(options: CodexAdapterOptions = {}) {
    this.binary = options.binary || process.env.CODEX_BIN || "codex";
    this.stateDir = options.stateDir || defaultStateDir();
    this.maxAccountsPerEngine = options.maxAccountsPerEngine ?? 20;
    this.cooldownMinutes = options.cooldownMinutes ?? 15;
    this.runner = options.runner ?? defaultProcessRunner;
  }

  async run(invocation: AgentInvocation): Promise<AgentResult> {
    const targets = await resolveAccountTargets(
      this.stateDir,
      this.name,
      invocation.account,
      this.maxAccountsPerEngine
    );
    const effort = mapEffort(invocation.effort);
    let last: AgentResult | null = null;

    for (const target of targets) {
      const result = await this.runOnce(invocation, target, effort);
      last = result;

      if (result.exitCode === 0) {
        if (target.id) {
          await recordAccountUse(this.stateDir, this.name, target.id);
        }
        return result;
      }

      if (invocation.account) {
        return result;
      }

      const text = result.combinedOutput;
      if (target.id && isQuotaText(text)) {
        await recordAccountCooldown(this.stateDir, this.name, target.id, this.cooldownMinutes, "quota_exhausted");
        continue;
      }
      if (target.id && isAuthText(text)) {
        await recordAccountAuthRequired(this.stateDir, this.name, target.id, "auth_required");
        continue;
      }
      return result;
    }

    const exhausted = last ?? {
      rawOutput: "",
      combinedOutput: "No Codex account is available.",
      exitCode: 1,
      durationMs: 0,
      runtime: runtimeFor(invocation, null, effort, null)
    };
    return {
      ...exhausted,
      exitCode: 1,
      combinedOutput: `all_accounts_exhausted\n${exhausted.combinedOutput}`.trim()
    };
  }

  private async runOnce(
    invocation: AgentInvocation,
    target: AccountTarget,
    effort: string
  ): Promise<AgentResult> {
    const canWrite = invocation.canWrite ?? invocation.autoApprove ?? false;
    const lastMessagePath = `${invocation.logPath}.last-message.txt`;
    const schemaPath = `${invocation.logPath}.schema.json`;
    await fs.mkdir(path.dirname(lastMessagePath), { recursive: true });

    const args = [
      "exec",
      "--json",
      "--sandbox",
      canWrite ? "workspace-write" : "read-only",
      "--cd",
      invocation.workspace,
      "--ephemeral",
      "--output-last-message",
      lastMessagePath
    ];

    if (invocation.model && invocation.model !== "strongest") {
      args.push("-m", invocation.model);
    }
    args.push("-c", `model_reasoning_effort="${effort}"`);

    if (invocation.responseSchema) {
      await fs.writeFile(schemaPath, `${JSON.stringify(invocation.responseSchema, null, 2)}\n`, "utf8");
      args.push("--output-schema", schemaPath);
    }

    args.push("-");

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (target.dir) {
      env.CODEX_HOME = target.dir;
    }

    const started = Date.now();
    const processResult = await this.runner({
      binary: this.binary,
      args,
      cwd: invocation.workspace,
      env,
      stdin: invocation.prompt,
      timeoutMs: invocation.timeoutMs
    });

    const { events, warnings } = parseEvents(processResult.stdout);
    const models: string[] = [];
    collectModels(events, models);
    const effectiveModel = models[0] ?? null;
    const runtime = runtimeFor(invocation, effectiveModel, effort, target.id);

    if (processResult.timedOut) {
      return {
        rawOutput: "",
        combinedOutput: "Agent process exceeded the invocation timeout.",
        exitCode: 124,
        durationMs: Date.now() - started,
        timedOut: true,
        runtime
      };
    }

    let message = "";
    try {
      message = (await fs.readFile(lastMessagePath, "utf8")).trim();
    } catch {
      // The event stream is the fallback.
    }
    if (!message) {
      message = lastAssistantText(events) ?? "";
    }

    const warningText = warnings.join("\n");
    const stderrText = processResult.stderr.trim();
    const combined = [message.trim(), stderrText, warningText].filter(Boolean).join("\n");

    if (processResult.exitCode !== 0 || !message) {
      return {
        rawOutput: message,
        combinedOutput: combined || processResult.stdout.trim() || "Codex returned no final message.",
        exitCode: processResult.exitCode === 0 ? 1 : processResult.exitCode,
        durationMs: Date.now() - started,
        runtime
      };
    }

    return {
      rawOutput: message,
      combinedOutput: combined || message,
      exitCode: 0,
      durationMs: Date.now() - started,
      runtime
    };
  }
}

export function codexBinaryFromEnv(): string {
  return process.env.CODEX_BIN || "codex";
}
