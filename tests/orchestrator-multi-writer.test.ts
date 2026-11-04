import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  executeIsolatedWriteBatch,
  MAX_CONCURRENT_WRITE_JOBS,
  PARALLEL_WRITING_SUPPORTED,
  startRun
} from "../src/orchestrator.js";
import { parseRunSpec } from "../src/schema.js";
import { createJob, createRun, requestRunCancellation } from "../src/store.js";
import type { AgentAdapter, AgentInvocation, AgentResult } from "../src/types.js";

class ConcurrencyTrackingAgent implements AgentAdapter {
  readonly name = "agy" as const;
  readonly invocations: AgentInvocation[] = [];
  currentConcurrency = 0;
  maxConcurrency = 0;
  readonly activeLabels: Set<string> = new Set();
  readonly concurrentSnapshots: Array<{ label: string; active: string[]; concurrency: number }> = [];

  constructor(
    private readonly handler: (
      invocation: AgentInvocation
    ) => Promise<string | { output: string; exitCode?: number }> | string | { output: string; exitCode?: number }
  ) {}

  async run(invocation: AgentInvocation): Promise<AgentResult> {
    this.invocations.push(invocation);
    this.currentConcurrency++;
    this.maxConcurrency = Math.max(this.maxConcurrency, this.currentConcurrency);
    this.activeLabels.add(invocation.runLabel);
    this.concurrentSnapshots.push({
      label: invocation.runLabel,
      active: Array.from(this.activeLabels),
      concurrency: this.currentConcurrency
    });

    try {
      const result = await this.handler(invocation);
      const output = typeof result === "string" ? result : result.output;
      const exitCode = typeof result === "string" ? 0 : (result.exitCode ?? 0);
      return {
        rawOutput: output,
        combinedOutput: output,
        exitCode,
        durationMs: 5,
        runtime: {
          requestedModel: invocation.model ?? "strongest",
          requestedEffort: invocation.effort ?? "highest",
          selectedModel: "claude-opus-4-6-thinking",
          effectiveModel: "claude-opus-4-6-thinking",
          effectiveEffort: "fixed-thinking",
          effortAdjustable: false,
          verified: true,
          account: "account-2"
        }
      };
    } finally {
      this.currentConcurrency--;
      this.activeLabels.delete(invocation.runLabel);
    }
  }
}

const tempRoots: string[] = [];

async function createTempWorkspace(): Promise<{ workspace: string; stateDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omega-multi-writer-reg-"));
  tempRoots.push(root);
  const workspace = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "README.md"), "# Original README\n", "utf8");
  return { workspace, stateDir };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (target) => {
      await fs.rm(target, { recursive: true, force: true });
    })
  );
});

describe("orchestrator - multi-writer safety and sequential write enforcement", () => {
  it("exports PARALLEL_WRITING_SUPPORTED as false and MAX_CONCURRENT_WRITE_JOBS as 1", () => {
    expect(PARALLEL_WRITING_SUPPORTED).toBe(false);
    expect(MAX_CONCURRENT_WRITE_JOBS).toBe(1);
  });

  it("never dispatches multiple write jobs concurrently in parallel workspaces, executing them strictly sequentially with exclusive workspace access", async () => {
    const { workspace, stateDir } = await createTempWorkspace();

    // Prepare dirty uncommitted file and untracked file in live workspace
    await fs.writeFile(path.join(workspace, "dirty_uncommitted.ts"), "// user uncommitted edit\n", "utf8");
    await fs.writeFile(path.join(workspace, "untracked_user_notes.md"), "# Untracked note\n", "utf8");
    await fs.writeFile(path.join(workspace, "module_a.ts"), "export const a = 1;\n", "utf8");

    const writeConcurrencies: number[] = [];

    const agent = new ConcurrencyTrackingAgent(async (invocation) => {
      // 1. Planning phase
      if (invocation.runLabel.startsWith("planning")) {
        return JSON.stringify({
          summary: "Two write jobs planned at same priority.",
          jobs: [
            {
              title: "Implement Module A Feature",
              objective: "Update module_a.ts",
              success_criteria: ["module_a updated"],
              can_write: true,
              priority: 1
            },
            {
              title: "Implement Module B Feature",
              objective: "Create module_b.ts",
              success_criteria: ["module_b created"],
              can_write: true,
              priority: 1
            }
          ],
          risks: [],
          assumptions: []
        });
      }

      // 2. Execution phase for writers
      if (invocation.runLabel === "execution-002") {
        // Must execute directly in live workspace, NEVER in an isolated directory copy
        expect(invocation.workspace).toBe(workspace);
        expect(invocation.workspace).not.toContain("workspaces");

        // Record concurrency during write
        writeConcurrencies.push(agent.currentConcurrency);

        // Edit module_a.ts directly in live workspace
        await fs.writeFile(path.join(workspace, "module_a.ts"), "export const a = 2;\n", "utf8");
        await new Promise((resolve) => setTimeout(resolve, 25));

        return JSON.stringify({
          summary: "Writer 1 completed module A.",
          outcome: "done",
          changed_files: ["module_a.ts"],
          checks_run: ["typecheck"],
          open_questions: [],
          follow_up_instructions: null
        });
      }

      if (invocation.runLabel === "execution-003") {
        // Must execute directly in live workspace, NEVER in an isolated directory copy
        expect(invocation.workspace).toBe(workspace);
        expect(invocation.workspace).not.toContain("workspaces");

        // Record concurrency during write
        writeConcurrencies.push(agent.currentConcurrency);

        // Verify module_a.ts was already updated by Writer 1 before Writer 2 started (strictly sequential!)
        const modA = await fs.readFile(path.join(workspace, "module_a.ts"), "utf8");
        expect(modA).toBe("export const a = 2;\n");

        await fs.writeFile(path.join(workspace, "module_b.ts"), "export const b = 'module b';\n", "utf8");
        await new Promise((resolve) => setTimeout(resolve, 25));

        return JSON.stringify({
          summary: "Writer 2 completed module B.",
          outcome: "done",
          changed_files: ["module_b.ts"],
          checks_run: ["unit tests"],
          open_questions: [],
          follow_up_instructions: null
        });
      }

      // 3. Final review pass (Phase 3)
      return JSON.stringify({
        summary: "Final review pass: all criteria satisfied.",
        verdict: "pass",
        checks_run: ["full integration verification"],
        remaining_gaps: [],
        next_action: "none"
      });
    });

    const spec = parseRunSpec({
      goal: "Implement independent features sequentially.",
      workspace,
      allow_write: true,
      success_criteria: ["Both features implemented."],
      state_dir: stateDir,
      max_subjobs: 5,
      timeout_minutes: 5,
      report_format: "full"
    }, workspace);

    const run = await startRun(spec, agent);
    expect(run.state).toBe("completed");
    expect(run.finalReport?.verdict).toBe("pass");

    // Concurrency verification: writers were NEVER concurrent!
    expect(writeConcurrencies).toEqual([1, 1]);
    expect(agent.maxConcurrency).toBe(1);

    // No auto-integration peer review was dispatched
    const peerReviewInvocations = agent.invocations.filter((i) => i.runLabel.startsWith("peer-review"));
    expect(peerReviewInvocations).toHaveLength(0);

    // Both files in live workspace are correctly updated
    expect(await fs.readFile(path.join(workspace, "module_a.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(await fs.readFile(path.join(workspace, "module_b.ts"), "utf8")).toBe("export const b = 'module b';\n");

    // Uncommitted and untracked user files preserved
    expect(await fs.readFile(path.join(workspace, "dirty_uncommitted.ts"), "utf8")).toBe("// user uncommitted edit\n");
    expect(await fs.readFile(path.join(workspace, "untracked_user_notes.md"), "utf8")).toBe("# Untracked note\n");
  });

  it("proves unsafe multi-writer execution path (executeIsolatedWriteBatch) is disabled and fails closed", async () => {
    const { workspace, stateDir } = await createTempWorkspace();
    const spec = parseRunSpec({
      goal: "Test disabled path.",
      workspace,
      allow_write: true,
      success_criteria: ["Done."],
      state_dir: stateDir
    }, workspace);

    const run = await createRun(spec);
    const job1 = createJob("execution", 1, {
      title: "Write 1",
      objective: "Write 1",
      successCriteria: ["Done"],
      canWrite: true,
      priority: 1
    });
    const job2 = createJob("execution", 2, {
      title: "Write 2",
      objective: "Write 2",
      successCriteria: ["Done"],
      canWrite: true,
      priority: 1
    });

    const agent = new ConcurrencyTrackingAgent(() => "{}");

    await expect(executeIsolatedWriteBatch(run, [job1, job2], agent)).rejects.toThrow(
      /Unsafe multi-writer dispatch is disabled/i
    );
  });

  it("enforces sequential write execution when jobs are explicitly marked isolated: true, never dispatching parallel workspaces or auto-integration", async () => {
    const { workspace, stateDir } = await createTempWorkspace();
    const executionsRunInWorkspace: string[] = [];

    const agent = new ConcurrencyTrackingAgent(async (invocation) => {
      if (invocation.runLabel.startsWith("planning")) {
        return JSON.stringify({
          summary: "Isolated jobs planned.",
          jobs: [
            { title: "Writer A", objective: "Write A", success_criteria: ["Done"], can_write: true, priority: 1 },
            { title: "Writer B", objective: "Write B", success_criteria: ["Done"], can_write: true, priority: 1 }
          ],
          risks: [],
          assumptions: []
        });
      }

      if (invocation.runLabel.startsWith("execution")) {
        // Track the workspace path passed to the agent
        executionsRunInWorkspace.push(invocation.workspace);
        expect(invocation.workspace).toBe(workspace);
        expect(agent.currentConcurrency).toBe(1);

        return JSON.stringify({
          summary: `${invocation.runLabel} completed.`,
          outcome: "done",
          changed_files: [],
          checks_run: [],
          open_questions: [],
          follow_up_instructions: null
        });
      }

      return JSON.stringify({
        summary: "Review pass.",
        verdict: "pass",
        checks_run: [],
        remaining_gaps: [],
        next_action: "none"
      });
    });

    const spec = parseRunSpec({
      goal: "Isolated job safety.",
      workspace,
      allow_write: true,
      success_criteria: ["Done."],
      state_dir: stateDir,
      max_subjobs: 5,
      timeout_minutes: 5,
      report_format: "full"
    }, workspace);

    const run = await startRun(spec, agent);
    expect(run.state).toBe("completed");

    // All execution jobs ran directly in live workspace sequentially
    expect(executionsRunInWorkspace).toHaveLength(2);
    expect(executionsRunInWorkspace[0]).toBe(workspace);
    expect(executionsRunInWorkspace[1]).toBe(workspace);
    expect(agent.maxConcurrency).toBe(1);

    // No peer review jobs were dispatched
    expect(agent.invocations.some((i) => i.runLabel.startsWith("peer-review"))).toBe(false);
  });

  it("preserves read parallelism alongside sequential write execution across multiple writers", async () => {
    const { workspace, stateDir } = await createTempWorkspace();

    const agent = new ConcurrencyTrackingAgent(async (invocation) => {
      if (invocation.runLabel.startsWith("planning")) {
        return JSON.stringify({
          summary: "Mixed plan with concurrent reads and sequential writes.",
          jobs: [
            { title: "Read 1", objective: "Read 1", success_criteria: ["Done"], can_write: false, priority: 1 },
            { title: "Read 2", objective: "Read 2", success_criteria: ["Done"], can_write: false, priority: 1 },
            { title: "Write 1", objective: "Write 1", success_criteria: ["Done"], can_write: true, priority: 2 },
            { title: "Write 2", objective: "Write 2", success_criteria: ["Done"], can_write: true, priority: 2 },
            { title: "Read 3", objective: "Read 3", success_criteria: ["Done"], can_write: false, priority: 3 },
            { title: "Read 4", objective: "Read 4", success_criteria: ["Done"], can_write: false, priority: 3 }
          ],
          risks: [],
          assumptions: []
        });
      }

      if (invocation.runLabel.startsWith("execution")) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return JSON.stringify({
          summary: `${invocation.runLabel} finished.`,
          outcome: "done",
          changed_files: [],
          checks_run: ["check"],
          open_questions: [],
          follow_up_instructions: null
        });
      }

      return JSON.stringify({
        summary: "Review pass.",
        verdict: "pass",
        checks_run: ["review"],
        remaining_gaps: [],
        next_action: "none"
      });
    });

    const spec = parseRunSpec({
      goal: "Mixed concurrency run.",
      workspace,
      allow_write: true,
      success_criteria: ["Done."],
      state_dir: stateDir,
      max_subjobs: 10,
      timeout_minutes: 5,
      report_format: "full"
    }, workspace);

    const run = await startRun(spec, agent);
    expect(run.state).toBe("completed");

    // Planning was execution 001, so:
    // Read 1: execution-002, Read 2: execution-003
    // Write 1: execution-004, Write 2: execution-005
    // Read 3: execution-006, Read 4: execution-007

    // Read 1 & Read 2 ran concurrently
    const read2Snap = agent.concurrentSnapshots.find((s) => s.label === "execution-003");
    expect(read2Snap?.active).toContain("execution-002");

    // Write 1 ran strictly alone with exclusive workspace access
    const write1Snap = agent.concurrentSnapshots.find((s) => s.label === "execution-004");
    expect(write1Snap).toBeDefined();
    expect(write1Snap?.concurrency).toBe(1);
    expect(write1Snap?.active).toEqual(["execution-004"]);

    // Write 2 ran strictly alone with exclusive workspace access, after Write 1
    const write2Snap = agent.concurrentSnapshots.find((s) => s.label === "execution-005");
    expect(write2Snap).toBeDefined();
    expect(write2Snap?.concurrency).toBe(1);
    expect(write2Snap?.active).toEqual(["execution-005"]);

    // Read 3 & Read 4 ran concurrently after writes finished
    const read4Snap = agent.concurrentSnapshots.find((s) => s.label === "execution-007");
    expect(read4Snap?.active).toContain("execution-006");
    expect(read4Snap?.active).not.toContain("execution-004");
    expect(read4Snap?.active).not.toContain("execution-005");
  });

  it("preserves independent review pass (Phase 3) after sequential write jobs finish", async () => {
    const { workspace, stateDir } = await createTempWorkspace();
    let reviewInvocation: AgentInvocation | null = null;

    const agent = new ConcurrencyTrackingAgent(async (invocation) => {
      if (invocation.runLabel.startsWith("planning")) {
        return JSON.stringify({
          summary: "Plan with write and review.",
          jobs: [
            { title: "Write A", objective: "Write A", success_criteria: ["Done"], can_write: true, priority: 1 },
            { title: "Write B", objective: "Write B", success_criteria: ["Done"], can_write: true, priority: 1 }
          ],
          risks: [],
          assumptions: []
        });
      }

      if (invocation.runLabel.startsWith("execution")) {
        return JSON.stringify({
          summary: `${invocation.runLabel} done.`,
          outcome: "done",
          changed_files: [],
          checks_run: [],
          open_questions: [],
          follow_up_instructions: null
        });
      }

      if (invocation.runLabel.startsWith("review")) {
        reviewInvocation = invocation;
        return JSON.stringify({
          summary: "Independent review passed cleanly.",
          verdict: "pass",
          checks_run: ["final criteria verification"],
          remaining_gaps: [],
          next_action: "none"
        });
      }

      throw new Error(`Unexpected invocation: ${invocation.runLabel}`);
    });

    const spec = parseRunSpec({
      goal: "Test review preservation.",
      workspace,
      allow_write: true,
      success_criteria: ["Done."],
      state_dir: stateDir,
      max_subjobs: 5,
      timeout_minutes: 5,
      report_format: "full"
    }, workspace);

    const run = await startRun(spec, agent);
    expect(run.state).toBe("completed");
    expect(run.finalReport?.verdict).toBe("pass");
    const capturedReview = reviewInvocation as AgentInvocation | null;
    expect(capturedReview).not.toBeNull();
    expect(capturedReview?.workspace).toBe(workspace);
  });

  it("scales to 10 planned write jobs by executing strictly sequentially with exclusive workspace access and never concurrently", async () => {
    const { workspace, stateDir } = await createTempWorkspace();

    for (let i = 1; i <= 10; i++) {
      await fs.writeFile(path.join(workspace, `file_${i}.txt`), `original ${i}\n`, "utf8");
    }

    const concurrentCountsDuringWrites: number[] = [];

    const agent = new ConcurrencyTrackingAgent(async (invocation) => {
      if (invocation.runLabel.startsWith("planning")) {
        return JSON.stringify({
          summary: "10 write jobs at same priority.",
          jobs: Array.from({ length: 10 }, (_, i) => ({
            title: `Writer ${i + 1}`,
            objective: `Update file_${i + 1}.txt`,
            success_criteria: [`file_${i + 1} updated`],
            can_write: true,
            priority: 1
          })),
          risks: [],
          assumptions: []
        });
      }

      if (invocation.runLabel.startsWith("execution-")) {
        concurrentCountsDuringWrites.push(agent.currentConcurrency);
        // Verify running directly in live workspace
        expect(invocation.workspace).toBe(workspace);

        const idx = parseInt(invocation.runLabel.replace("execution-", ""), 10) - 1;
        const file = `file_${idx}.txt`;
        await fs.writeFile(path.join(workspace, file), `updated by writer ${idx}\n`, "utf8");

        await new Promise((resolve) => setTimeout(resolve, 5));

        return JSON.stringify({
          summary: `Writer ${idx} finished.`,
          outcome: "done",
          changed_files: [file],
          checks_run: ["check"],
          open_questions: [],
          follow_up_instructions: null
        });
      }

      return JSON.stringify({
        summary: "Final review pass.",
        verdict: "pass",
        checks_run: ["review all 10"],
        remaining_gaps: [],
        next_action: "none"
      });
    });

    const spec = parseRunSpec({
      goal: "10 sequential writers.",
      workspace,
      allow_write: true,
      success_criteria: ["All 10 updated."],
      state_dir: stateDir,
      max_subjobs: 10,
      timeout_minutes: 5,
      report_format: "full"
    }, workspace);

    const run = await startRun(spec, agent);
    expect(run.state).toBe("completed");

    // Concurrency verification: strictly 1 at all times for writers!
    expect(concurrentCountsDuringWrites).toHaveLength(10);
    expect(concurrentCountsDuringWrites.every((c) => c === 1)).toBe(true);
    expect(agent.maxConcurrency).toBe(1);

    // No peer reviews were executed
    expect(agent.invocations.some((i) => i.runLabel.startsWith("peer-review"))).toBe(false);

    // All 10 files in live workspace are updated
    for (let i = 1; i <= 10; i++) {
      expect(await fs.readFile(path.join(workspace, `file_${i}.txt`), "utf8")).toBe(`updated by writer ${i}\n`);
    }
  });

  it("handles cancellation during sequential write execution cleanly without dispatching subsequent write jobs", async () => {
    const { workspace, stateDir } = await createTempWorkspace();
    await fs.writeFile(path.join(workspace, "target.txt"), "untouched\n", "utf8");

    let runIdRef = "";
    const runsDir = path.join(stateDir, "runs");
    const executedWriteJobs: string[] = [];

    const agent = new ConcurrencyTrackingAgent(async (invocation) => {
      if (invocation.runLabel.startsWith("planning")) {
        return JSON.stringify({
          summary: "Plan ready.",
          jobs: [
            { title: "Writer 1", objective: "Change target.txt", success_criteria: ["Done"], can_write: true, priority: 1 },
            { title: "Writer 2", objective: "Add other.txt", success_criteria: ["Done"], can_write: true, priority: 1 }
          ],
          risks: [],
          assumptions: []
        });
      }

      if (invocation.runLabel === "execution-002") {
        executedWriteJobs.push(invocation.runLabel);
        await fs.writeFile(path.join(workspace, "target.txt"), "changed by writer 1\n", "utf8");
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Request cancellation mid-flight
        if (!runIdRef) {
          try {
            const entries = await fs.readdir(runsDir);
            const first = entries[0];
            if (first) runIdRef = first;
          } catch {}
        }
        if (runIdRef) {
          await requestRunCancellation(runIdRef, stateDir);
        }

        return JSON.stringify({
          summary: "Writer 1 finished before cancel acknowledgment.",
          outcome: "done",
          changed_files: ["target.txt"],
          checks_run: [],
          open_questions: [],
          follow_up_instructions: null
        });
      }

      if (invocation.runLabel === "execution-003") {
        executedWriteJobs.push(invocation.runLabel);
        return JSON.stringify({
          summary: "Writer 2 should not run.",
          outcome: "done",
          changed_files: [],
          checks_run: [],
          open_questions: [],
          follow_up_instructions: null
        });
      }

      return JSON.stringify({
        summary: "Review.",
        verdict: "pass",
        checks_run: [],
        remaining_gaps: [],
        next_action: "none"
      });
    });

    const spec = parseRunSpec({
      goal: "Test cancellation during sequential writes.",
      workspace,
      allow_write: true,
      success_criteria: ["Done."],
      state_dir: stateDir,
      max_subjobs: 5,
      timeout_minutes: 5,
      report_format: "full"
    }, workspace);

    const run = await startRun(spec, agent);
    expect(run.state).toBe("cancelled");

    // Writer 1 executed, but Writer 2 was NEVER dispatched!
    expect(executedWriteJobs).toEqual(["execution-002"]);
    expect(await fs.access(path.join(workspace, "other.txt")).then(() => true).catch(() => false)).toBe(false);
  });
});
