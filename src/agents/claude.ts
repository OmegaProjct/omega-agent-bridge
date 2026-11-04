import path from "node:path";

import {
  recordAccountAuthRequired,
  recordAccountCooldown,
  recordAccountUse,
  resolveAccountTargets,
  type AccountTarget
} from "../accounts.js";
import { defaultStateDir } from "../schema.js";
import { extractJsonDocument } from "../json.js";
import type {
  AgentAdapter,
  AgentInvocation,
  AgentResult,
  AgentRuntime,
  EngineCapabilities,
  EngineName
} from "../types.js";
import { defaultProcessRunner, type ProcessRunner } from "./processRunner.js";

export interface ClaudeAdapterOptions {
  binary?: string;
  stateDir?: string;
  maxAccountsPerEngine?: number;
  cooldownMinutes?: number;
  runner?: ProcessRunner;
}

interface ClaudeEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  error?: unknown;
  modelUsage?: Record<string, unknown>;
  session_id?: string;
  total_cost_usd?: number;
}

const CAPABILITIES: EngineCapabilities = {
  readOnlyMode: true,
  structuredOutput: true,
  jsonSchema: true,
  effortControl: true,
  accountIsolation: "config-dir"
};

function isQuotaText(text: string): boolean {
  return /rate.?limit|quota|usage limit|too many requests|429|resource_exhausted/i.test(text);
}

function isAuthText(text: string): boolean {
  return /not logged in|login required|authentication required|unauthorized|401|invalid api key|auth(?:entication)? failed/i.test(text);
}

function mapEffort(effort: string | undefined): string {
  const requested = effort ?? "highest";
  if (requested === "highest") {
    return "max";
  }
  if (["low", "medium", "high", "xhigh", "max"].includes(requested)) {
    return requested;
  }
  throw new Error(`Claude does not support effort '${requested}'.`);
}

function runtimeFor(
  invocation: AgentInvocation,
  model: string | null,
  effectiveModel: string | null,
  effort: string,
  account: string | null
): AgentRuntime {
  const selectedModel = model && model !== "strongest" ? model : "cli-default";
  const verified = Boolean(
    effectiveModel &&
    (selectedModel === "cli-default" ||
      effectiveModel.toLowerCase() === selectedModel.toLowerCase() ||
      effectiveModel.toLowerCase().includes(selectedModel.toLowerCase()))
  );
  return {
    engine: "claude",
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

function failureResult(
  invocation: AgentInvocation,
  stdout: string,
  stderr: string,
  message: string,
  account: string | null,
  effort: string,
  timedOut = false
): AgentResult {
  return {
    rawOutput: stdout,
    combinedOutput: [message.trim(), stderr.trim()].filter(Boolean).join("\n"),
    exitCode: timedOut ? 124 : 1,
    durationMs: 0,
    ...(timedOut ? { timedOut: true } : {}),
    runtime: runtimeFor(invocation, invocation.model, null, effort, account)
  };
}

function extractModelUsage(envelope: ClaudeEnvelope): string[] {
  if (!envelope.modelUsage || typeof envelope.modelUsage !== "object") {
    return [];
  }
  return Object.keys(envelope.modelUsage);
}

export class ClaudeAdapter implements AgentAdapter {
  readonly name: EngineName = "claude";
  readonly capabilities = CAPABILITIES;

  private readonly binary: string;
  private readonly stateDir: string;
  private readonly maxAccountsPerEngine: number;
  private readonly cooldownMinutes: number;
  private readonly runner: ProcessRunner;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.binary = options.binary || process.env.CLAUDE_BIN || "claude";
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

    const exhausted = last ?? failureResult(invocation, "", "", "No Claude account is available.", null, effort);
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
    const args = [
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      canWrite ? "bypassPermissions" : "plan",
      "--effort",
      effort
    ];

    if (invocation.model && invocation.model !== "strongest") {
      args.push("--model", invocation.model);
    }
    if (invocation.responseSchema) {
      args.push("--json-schema", JSON.stringify(invocation.responseSchema));
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (target.dir) {
      env.CLAUDE_CONFIG_DIR = target.dir;
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

    if (processResult.timedOut) {
      return {
        ...failureResult(
          invocation,
          processResult.stdout,
          processResult.stderr,
          "Agent process exceeded the invocation timeout.",
          target.id,
          effort,
          true
        ),
        durationMs: Date.now() - started
      };
    }

    const runtime = runtimeFor(invocation, invocation.model, null, effort, target.id);

    let envelope: ClaudeEnvelope;
    try {
      const raw = processResult.stdout.trim();
      if (!raw) {
        throw new Error("Claude returned no output.");
      }
      try {
        envelope = JSON.parse(raw) as ClaudeEnvelope;
      } catch {
        envelope = JSON.parse(extractJsonDocument(raw)) as ClaudeEnvelope;
      }
    } catch (error) {
      return {
        rawOutput: processResult.stdout,
        combinedOutput: [
          processResult.stdout.trim(),
          processResult.stderr.trim(),
          `Invalid or missing Claude JSON output: ${error instanceof Error ? error.message : String(error)}`
        ].filter(Boolean).join("\n"),
        exitCode: 1,
        durationMs: Date.now() - started,
        runtime
      };
    }

    const models = extractModelUsage(envelope);
    const effectiveModel = models.length === 1 ? models[0]! : models[0] ?? null;
    const parsedRuntime = runtimeFor(invocation, invocation.model, effectiveModel, effort, target.id);
    if (models.length > 1) {
      parsedRuntime.verified = false;
    }

    const message = typeof envelope.result === "string"
      ? envelope.result
      : envelope.result === undefined
        ? ""
        : JSON.stringify(envelope.result);
    const errorText = envelope.error === undefined
      ? ""
      : typeof envelope.error === "string"
        ? envelope.error
        : JSON.stringify(envelope.error);

    const failed = Boolean(envelope.is_error) || processResult.exitCode !== 0 || Boolean(envelope.subtype && /error/i.test(envelope.subtype));
    const combined = [message.trim(), processResult.stderr.trim(), failed ? errorText.trim() : ""]
      .filter(Boolean)
      .join("\n");

    return {
      rawOutput: message,
      combinedOutput: combined || message,
      exitCode: failed ? 1 : 0,
      durationMs: Date.now() - started,
      runtime: parsedRuntime
    };
  }
}

export function claudeBinaryFromEnv(): string {
  return process.env.CLAUDE_BIN || "claude";
}

export function claudeAccountDir(stateDir: string, id: string): string {
  return path.join(stateDir, "accounts", "claude", id);
}
