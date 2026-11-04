import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  getEngineAccountInfo,
  listEngineAccounts,
  migrateLegacyAgyAccounts,
  planLegacyAgyMigration
} from "../src/accounts.js";
import { ClaudeAdapter } from "../src/agents/claude.js";
import { CodexAdapter } from "../src/agents/codex.js";
import type { ProcessRunOptions, ProcessRunResult } from "../src/agents/processRunner.js";
import { resumeRun, startRun } from "../src/orchestrator.js";
import { accountsDir, parseRunSpec } from "../src/schema.js";
import { runDoctor, runSetup } from "../src/setup.js";
import { summarizeRun } from "../src/store.js";
import type {
  AgentAdapter,
  AgentInvocation,
  AgentResult,
  EngineName
} from "../src/types.js";

const tempRoots: string[] = [];

async function createTempRoot(prefix = "omega-multi-"): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (target) => {
      await fs.rm(target, { recursive: true, force: true });
    })
  );
});

function successResult(output: string): AgentResult {
  return {
    rawOutput: output,
    combinedOutput: output,
    exitCode: 0,
    durationMs: 1,
    runtime: {
      requestedModel: "strongest",
      requestedEffort: "highest",
      selectedModel: "cli-default",
      effectiveModel: null,
      effectiveEffort: "high",
      effortAdjustable: true,
      verified: false,
      account: null
    }
  };
}

class ScriptedAgent implements AgentAdapter {
  readonly invocations: AgentInvocation[] = [];

  constructor(
    readonly name: EngineName,
    private readonly outputs: string[]
  ) {}

  async run(invocation: AgentInvocation): Promise<AgentResult> {
    this.invocations.push(invocation);
    const output = this.outputs.shift();
    if (!output) {
      throw new Error(`No scripted output left for ${this.name}.`);
    }
    const result = successResult(output);
    return {
      ...result,
      runtime: {
        ...result.runtime!,
        engine: this.name,
        account: invocation.account ?? null
      }
    };
  }
}

const planResponse = JSON.stringify({
  summary: "Route the work.",
  jobs: [
    {
      title: "Claude inspection",
      objective: "Inspect with Claude.",
      success_criteria: ["Inspected."],
      can_write: false,
      priority: 1,
      engine: "claude"
    },
    {
      title: "Codex inspection",
      objective: "Inspect with Codex.",
      success_criteria: ["Inspected."],
      can_write: false,
      priority: 2,
      engine: "codex"
    }
  ],
  risks: [],
  assumptions: []
});

const executionResponse = JSON.stringify({
  summary: "Inspection done.",
  outcome: "done",
  changed_files: [],
  checks_run: ["inspection"],
  open_questions: [],
  follow_up_instructions: null
});

const reviewResponse = JSON.stringify({
  summary: "Review passed.",
  verdict: "pass",
  checks_run: ["review"],
  remaining_gaps: [],
  next_action: "none"
});

describe("spec validation", () => {
  it("requires allowed_engines to include the default execution engine", () => {
    expect(() => parseRunSpec({
      goal: "Invalid allowlist.",
      workspace: ".",
      engine: "agy",
      allowed_engines: ["claude"]
    })).toThrow(/allowed_engines must include/);
  });

  it("requires fallback_engines to be a subset of allowed_engines", () => {
    expect(() => parseRunSpec({
      goal: "Invalid fallback.",
      workspace: ".",
      engine: "agy",
      allowed_engines: ["agy"],
      fallback_engines: ["codex"]
    })).toThrow(/not in allowed_engines/);
  });
});

describe("engine routing", () => {
  it("routes planning, per-job execution, and review to the configured engines", async () => {
    const root = await createTempRoot();
    const workspace = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await fs.mkdir(workspace, { recursive: true });

    const agy = new ScriptedAgent("agy", [planResponse]);
    const claude = new ScriptedAgent("claude", [executionResponse, reviewResponse]);
    const codex = new ScriptedAgent("codex", [executionResponse]);
    const agents: Record<EngineName, ScriptedAgent> = { agy, claude, codex };

    const spec = parseRunSpec({
      goal: "Route work across engines.",
      workspace,
      allow_write: false,
      state_dir: stateDir,
      planning_engine: "agy",
      engine: "agy",
      review_engine: "claude",
      allowed_engines: ["agy", "claude", "codex"]
    }, workspace);

    const run = await startRun(spec, (engine) => agents[engine]);
    expect(run.state).toBe("completed");
    expect(agy.invocations.map((invocation) => invocation.runLabel)).toEqual(["planning-001"]);
    expect(claude.invocations.map((invocation) => invocation.runLabel)).toEqual([
      "execution-002",
      "review-004"
    ]);
    expect(codex.invocations.map((invocation) => invocation.runLabel)).toEqual(["execution-003"]);
    expect(run.jobs.find((job) => job.id === "execution-002")?.engine).toBe("claude");
    expect(run.jobs.find((job) => job.id === "execution-003")?.engine).toBe("codex");
    expect(run.jobs.find((job) => job.id === "review-004")?.engine).toBe("claude");
    expect(run.finalReport?.verdict).toBe("pass");
  });

  it("selects a different available engine for review_engine auto", async () => {
    const root = await createTempRoot();
    const workspace = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await fs.mkdir(workspace, { recursive: true });

    // The plan assigns both jobs to the default engine by omitting `engine`.
    const planForAgy = JSON.stringify({
      summary: "Two agy jobs.",
      jobs: [
        { title: "A", objective: "A", success_criteria: ["A"], can_write: false, priority: 1 },
        { title: "B", objective: "B", success_criteria: ["B"], can_write: false, priority: 2 }
      ],
      risks: [],
      assumptions: []
    });
    const agy = new ScriptedAgent("agy", [planForAgy, executionResponse, executionResponse]);
    const claude = new ScriptedAgent("claude", [reviewResponse]);
    const codex = new ScriptedAgent("codex", []);
    const agents: Record<EngineName, ScriptedAgent> = { agy, claude, codex };

    const spec = parseRunSpec({
      goal: "Auto review.",
      workspace,
      allow_write: false,
      state_dir: stateDir,
      engine: "agy",
      review_engine: "auto",
      allowed_engines: ["agy", "claude"]
    }, workspace);

    const run = await startRun(spec, (engine) => agents[engine]);
    expect(run.state).toBe("completed");
    expect(run.jobs.find((job) => job.id === "review-004")?.engine).toBe("claude");
    expect(claude.invocations.map((invocation) => invocation.runLabel)).toEqual(["review-004"]);
  });

  it("preserves a per-job account pin for the job's engine", async () => {
    const root = await createTempRoot();
    const workspace = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await fs.mkdir(workspace, { recursive: true });

    const pinnedPlan = JSON.stringify({
      summary: "One pinned Claude job.",
      jobs: [
        {
          title: "Pinned inspection",
          objective: "Inspect with a specific Claude account.",
          success_criteria: ["Inspected."],
          can_write: false,
          priority: 1,
          engine: "claude",
          account: "claude:account-02"
        }
      ],
      risks: [],
      assumptions: []
    });
    const agy = new ScriptedAgent("agy", [pinnedPlan, reviewResponse]);
    const claude = new ScriptedAgent("claude", [executionResponse]);
    const codex = new ScriptedAgent("codex", []);
    const agents: Record<EngineName, ScriptedAgent> = { agy, claude, codex };

    const spec = parseRunSpec({
      goal: "Pin one account.",
      workspace,
      allow_write: false,
      state_dir: stateDir,
      engine: "agy",
      review_engine: "agy",
      allowed_engines: ["agy", "claude"]
    }, workspace);

    const run = await startRun(spec, (engine) => agents[engine]);
    expect(run.state).toBe("completed");
    expect(claude.invocations).toHaveLength(1);
    expect(claude.invocations[0]?.account).toBe("account-02");
    expect(run.jobs.find((job) => job.id === "execution-002")?.account).toBe("account-02");
    expect(run.jobs.find((job) => job.id === "execution-002")?.runtime?.account).toBe("account-02");
  });

  it("keeps auto review independent when execution routed away from the default engine", async () => {
    const root = await createTempRoot();
    const workspace = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await fs.mkdir(workspace, { recursive: true });

    const planForClaude = JSON.stringify({
      summary: "Both jobs on Claude.",
      jobs: [
        {
          title: "Claude A",
          objective: "A",
          success_criteria: ["A"],
          can_write: false,
          priority: 1,
          engine: "claude"
        },
        {
          title: "Claude B",
          objective: "B",
          success_criteria: ["B"],
          can_write: false,
          priority: 2,
          engine: "claude"
        }
      ],
      risks: [],
      assumptions: []
    });
    const agy = new ScriptedAgent("agy", [planForClaude, reviewResponse]);
    const claude = new ScriptedAgent("claude", [executionResponse, executionResponse]);
    const codex = new ScriptedAgent("codex", []);
    const agents: Record<EngineName, ScriptedAgent> = { agy, claude, codex };

    const spec = parseRunSpec({
      goal: "Review away from execution.",
      workspace,
      allow_write: false,
      state_dir: stateDir,
      engine: "agy",
      review_engine: "auto",
      allowed_engines: ["agy", "claude"]
    }, workspace);

    const run = await startRun(spec, (engine) => agents[engine]);
    expect(run.state).toBe("completed");
    expect(run.jobs.find((job) => job.id === "review-004")?.engine).toBe("agy");
    expect(agy.invocations.map((invocation) => invocation.runLabel)).toEqual([
      "planning-001",
      "review-004"
    ]);
    expect(claude.invocations.map((invocation) => invocation.runLabel)).toEqual([
      "execution-002",
      "execution-003"
    ]);
  });

  it("rejects a plan that assigns a job outside allowed_engines", async () => {
    const root = await createTempRoot();
    const workspace = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await fs.mkdir(workspace, { recursive: true });

    const agy = new ScriptedAgent("agy", [planResponse]);
    const claude = new ScriptedAgent("claude", []);
    const codex = new ScriptedAgent("codex", []);
    const agents: Record<EngineName, ScriptedAgent> = { agy, claude, codex };

    const spec = parseRunSpec({
      goal: "Disallowed engine.",
      workspace,
      allow_write: false,
      state_dir: stateDir,
      engine: "agy",
      allowed_engines: ["agy"]
    }, workspace);

    const run = await startRun(spec, (engine) => agents[engine]);
    expect(run.state).toBe("failed");
    expect(run.error).toContain("not in allowed_engines");
    expect(claude.invocations).toHaveLength(0);
    expect(codex.invocations).toHaveLength(0);
  });
});

describe("write approval", () => {
  it("stops after planning and continues only after an explicit approval", async () => {
    const root = await createTempRoot();
    const workspace = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await fs.mkdir(workspace, { recursive: true });

    const plan = JSON.stringify({
      summary: "Write plan.",
      jobs: [
        {
          title: "Write the change",
          objective: "Change one file.",
          success_criteria: ["Changed."],
          can_write: true,
          priority: 1
        }
      ],
      risks: [],
      assumptions: []
    });
    const agent = new ScriptedAgent("agy", [plan, executionResponse, reviewResponse]);

    const spec = parseRunSpec({
      goal: "Approval flow.",
      workspace,
      allow_write: true,
      state_dir: stateDir,
      timeout_minutes: 5,
      review_pass_limit: 1
    }, workspace);

    const planned = await startRun(spec, () => agent, {
      planOnly: true,
      requireWriteApproval: true
    });
    expect(planned.state).toBe("pending");
    expect(summarizeRun(planned).write_approved).toBe(false);
    expect(agent.invocations.map((invocation) => invocation.runLabel)).toEqual(["planning-001"]);

    const blocked = await resumeRun(planned.runId, stateDir, () => agent, {
      requireWriteApproval: true
    });
    expect(blocked.state).toBe("pending");
    expect(agent.invocations.map((invocation) => invocation.runLabel)).toEqual(["planning-001"]);

    const resumed = await resumeRun(planned.runId, stateDir, () => agent, {
      allowWrite: true,
      requireWriteApproval: true
    });
    expect(resumed.state).toBe("completed");
    expect(resumed.writeApproval?.source).toBe("user");
    expect(summarizeRun(resumed).write_approved).toBe(true);
    expect(agent.invocations.map((invocation) => invocation.runLabel)).toEqual([
      "planning-001",
      "execution-002",
      "review-003"
    ]);
  });
});

describe("claude adapter", () => {
  async function createClaudeState(root: string, ids: string[]): Promise<string> {
    const stateDir = path.join(root, "state");
    for (const id of ids) {
      const dir = path.join(stateDir, "accounts", "claude", id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, ".claude.json"), "{}", "utf8");
    }
    return stateDir;
  }

  function claudeEnvelope(model = "claude-opus-test"): string {
    return JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: '{"ok":true}',
      modelUsage: { [model]: { inputTokens: 1 } }
    });
  }

  it("maps read-only and write intents to Claude permission modes", async () => {
    const root = await createTempRoot();
    const stateDir = await createClaudeState(root, ["account-01"]);
    const calls: ProcessRunOptions[] = [];
    const runner = async (options: ProcessRunOptions): Promise<ProcessRunResult> => {
      calls.push(options);
      return { stdout: claudeEnvelope(), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    };

    const adapter = new ClaudeAdapter({ binary: "claude", stateDir, runner });
    const base: AgentInvocation = {
      prompt: "inspect",
      workspace: root,
      timeoutMs: 1000,
      logPath: path.join(root, "job.log"),
      runLabel: "execution-001",
      model: "strongest",
      effort: "highest"
    };

    const readResult = await adapter.run({ ...base, canWrite: false });
    expect(calls[0]?.args).toEqual(expect.arrayContaining(["--permission-mode", "plan"]));
    expect(calls[0]?.env?.CLAUDE_CONFIG_DIR).toBe(path.join(stateDir, "accounts", "claude", "account-01"));
    expect(readResult.runtime?.verified).toBe(true);

    await adapter.run({ ...base, canWrite: true });
    expect(calls[1]?.args).toEqual(expect.arrayContaining(["--permission-mode", "bypassPermissions"]));
  });

  it("rotates to the next account after a quota failure", async () => {
    const root = await createTempRoot();
    const stateDir = await createClaudeState(root, ["account-01", "account-02"]);
    const calls: ProcessRunOptions[] = [];
    const runner = async (options: ProcessRunOptions): Promise<ProcessRunResult> => {
      calls.push(options);
      if (calls.length === 1) {
        return {
          stdout: JSON.stringify({ is_error: true, result: "429 rate limit reached" }),
          stderr: "",
          exitCode: 1,
          durationMs: 1,
          timedOut: false
        };
      }
      return { stdout: claudeEnvelope(), stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    };

    const adapter = new ClaudeAdapter({ binary: "claude", stateDir, runner });
    const result = await adapter.run({
      prompt: "inspect",
      workspace: root,
      timeoutMs: 1000,
      logPath: path.join(root, "job.log"),
      runLabel: "execution-001",
      model: "strongest",
      effort: "high"
    });

    expect(result.exitCode).toBe(0);
    expect(result.runtime?.account).toBe("account-02");
    expect(calls.map((call) => call.env?.CLAUDE_CONFIG_DIR)).toEqual([
      path.join(stateDir, "accounts", "claude", "account-01"),
      path.join(stateDir, "accounts", "claude", "account-02")
    ]);
  });
});

describe("codex adapter", () => {
  async function createCodexState(root: string, ids: string[]): Promise<string> {
    const stateDir = path.join(root, "state");
    for (const id of ids) {
      const dir = path.join(stateDir, "accounts", "codex", id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({ token: "test" }), "utf8");
    }
    return stateDir;
  }

  function runnerWithMessage(message: string) {
    const calls: ProcessRunOptions[] = [];
    const runner = async (options: ProcessRunOptions): Promise<ProcessRunResult> => {
      calls.push(options);
      const index = options.args.indexOf("--output-last-message");
      const messagePath = index >= 0 ? options.args[index + 1] : undefined;
      if (messagePath) {
        await fs.writeFile(messagePath, message, "utf8");
      }
      return {
        stdout: `${JSON.stringify({ type: "session", model: "gpt-test" })}\n${JSON.stringify({ type: "turn.completed" })}\n`,
        stderr: "",
        exitCode: 0,
        durationMs: 1,
        timedOut: false
      };
    };
    return { calls, runner };
  }

  it("maps read-only and write intents to Codex sandbox modes", async () => {
    const root = await createTempRoot();
    const stateDir = await createCodexState(root, ["account-01"]);
    const { calls, runner } = runnerWithMessage('{"ok":true}');
    const adapter = new CodexAdapter({ binary: "codex", stateDir, runner });

    const base: AgentInvocation = {
      prompt: "inspect",
      workspace: root,
      timeoutMs: 1000,
      logPath: path.join(root, "job.log"),
      runLabel: "execution-001",
      model: "strongest",
      effort: "high"
    };

    const readResult = await adapter.run({ ...base, canWrite: false });
    expect(calls[0]?.args).toEqual(expect.arrayContaining(["--sandbox", "read-only"]));
    expect(calls[0]?.env?.CODEX_HOME).toBe(path.join(stateDir, "accounts", "codex", "account-01"));
    expect(readResult.rawOutput).toBe('{"ok":true}');
    expect(readResult.runtime?.effectiveModel).toBe("gpt-test");
    expect(readResult.runtime?.verified).toBe(true);

    await adapter.run({ ...base, canWrite: true });
    expect(calls[1]?.args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write"]));
  });

  it("rotates to the next account after a quota failure", async () => {
    const root = await createTempRoot();
    const stateDir = await createCodexState(root, ["account-01", "account-02"]);
    const calls: ProcessRunOptions[] = [];
    const runner = async (options: ProcessRunOptions): Promise<ProcessRunResult> => {
      calls.push(options);
      if (calls.length === 1) {
        return {
          stdout: "",
          stderr: "429 rate limit reached",
          exitCode: 1,
          durationMs: 1,
          timedOut: false
        };
      }
      const index = options.args.indexOf("--output-last-message");
      const messagePath = index >= 0 ? options.args[index + 1] : undefined;
      if (messagePath) {
        await fs.writeFile(messagePath, '{"ok":true}', "utf8");
      }
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    };

    const adapter = new CodexAdapter({ binary: "codex", stateDir, runner });
    const result = await adapter.run({
      prompt: "inspect",
      workspace: root,
      timeoutMs: 1000,
      logPath: path.join(root, "job.log"),
      runLabel: "execution-001",
      model: "strongest",
      effort: "high"
    });

    expect(result.exitCode).toBe(0);
    expect(result.runtime?.account).toBe("account-02");
    expect(calls.map((call) => call.env?.CODEX_HOME)).toEqual([
      path.join(stateDir, "accounts", "codex", "account-01"),
      path.join(stateDir, "accounts", "codex", "account-02")
    ]);
  });
});

describe("account store and onboarding", () => {
  it("lists engine-scoped accounts and enforces the configured cap without deleting extras", async () => {
    const root = await createTempRoot();
    const stateDir = path.join(root, "state");
    for (const id of ["account-01", "account-02"]) {
      const dir = path.join(stateDir, "accounts", "claude", id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, ".claude.json"), "{}", "utf8");
    }

    const listed = await listEngineAccounts(stateDir, "claude", 1);
    expect(listed).toHaveLength(2);
    expect(listed[0]?.ignored).toBe(false);
    expect(listed[1]?.ignored).toBe(true);
    await expect(fs.access(path.join(stateDir, "accounts", "claude", "account-02"))).resolves.toBeUndefined();
  });

  it("copies legacy flat agy accounts without moving the originals", async () => {
    const root = await createTempRoot();
    const stateDir = path.join(root, "state");
    const legacy = path.join(accountsDir(stateDir), "account-1");
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, "marker.txt"), "legacy", "utf8");

    const plan = await planLegacyAgyMigration(stateDir);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.accountId).toBe("account-01");

    const result = await migrateLegacyAgyAccounts(stateDir);
    expect(result.copied).toEqual(["account-01"]);
    expect(await fs.readFile(path.join(legacy, "marker.txt"), "utf8")).toBe("legacy");
    expect(
      await fs.readFile(
        path.join(stateDir, "accounts", "agy", "account-01", "marker.txt"),
        "utf8"
      )
    ).toBe("legacy");

    const info = await getEngineAccountInfo(stateDir, "agy", "account-01");
    expect(info.engine).toBe("agy");
    expect(info.dir).toBe(path.join(stateDir, "accounts", "agy", "account-01"));
  });

  it("creates the setup layout and config without launching a login in non-interactive mode", async () => {
    const root = await createTempRoot();
    const stateDir = path.join(root, "state");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });

    const result = await runSetup({
      stateDir,
      engine: "agy",
      noLogin: true,
      binaries: { agy: process.execPath },
      cwd: workspace
    });

    expect(result.engines[0]?.detected.found).toBe(true);
    expect(result.stateDirOutsideRepository).toBe(true);
    const config = JSON.parse(await fs.readFile(path.join(stateDir, "config.json"), "utf8")) as {
      version: number;
      maxAccountsPerEngine: number;
      engines: { agy: { enabled: boolean } };
    };
    expect(config.version).toBe(1);
    expect(config.maxAccountsPerEngine).toBe(20);
    expect(config.engines.agy.enabled).toBe(true);
    await expect(fs.access(path.join(stateDir, "accounts", "agy"))).resolves.toBeUndefined();
  });

  it("does not create anything during a setup dry run", async () => {
    const root = await createTempRoot();
    const stateDir = path.join(root, "state");

    const result = await runSetup({
      stateDir,
      engine: "agy",
      dryRun: true,
      binaries: { agy: process.execPath },
      cwd: root
    });

    expect(result.dryRun).toBe(true);
    await expect(fs.access(stateDir)).rejects.toBeDefined();
  });

  it("reports a usable engine and authenticated account in doctor", async () => {
    const root = await createTempRoot();
    const stateDir = path.join(root, "state");
    const accountDir = path.join(stateDir, "accounts", "agy", "account-01", ".gemini");
    await fs.mkdir(accountDir, { recursive: true });
    await fs.writeFile(
      path.join(accountDir, "google_accounts.json"),
      JSON.stringify({ active: "user@example.com" }),
      "utf8"
    );

    const result = await runDoctor({
      stateDir,
      engine: "agy",
      binaries: { agy: process.execPath }
    });

    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.id === "engine:agy")?.status).toBe("ok");
    expect(result.checks.find((check) => check.id === "accounts:agy")?.status).toBe("ok");
  });
});
