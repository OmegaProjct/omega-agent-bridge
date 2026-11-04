import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resumeRun, startRun } from "../src/orchestrator.js";
import { parseRunSpec } from "../src/schema.js";
import { createRun, loadRun, requestRunCancellation, saveRun, summarizeRun } from "../src/store.js";
import type { AgentAdapter, AgentInvocation, AgentResult } from "../src/types.js";

class FakeAgent implements AgentAdapter {
  readonly name = "agy" as const;
  readonly invocations: AgentInvocation[] = [];

  constructor(private readonly outputs: string[]) {}

  async run(invocation: AgentInvocation): Promise<AgentResult> {
    this.invocations.push(invocation);
    const output = this.outputs.shift();
    if (!output) {
      throw new Error("No fake output left.");
    }
    return {
      rawOutput: output,
      combinedOutput: output,
      exitCode: 0,
      durationMs: 1,
      runtime: {
        requestedModel: invocation.model ?? "strongest", requestedEffort: invocation.effort ?? "highest",
        selectedModel: "claude-opus-4-6-thinking", effectiveModel: "claude-opus-4-6-thinking",
        effectiveEffort: "fixed-thinking", effortAdjustable: false, verified: true, account: "account-2"
      }
    };
  }
}

class ConcurrencyTrackingAgent implements AgentAdapter {
  readonly name = "agy" as const;
  readonly invocations: AgentInvocation[] = [];
  currentConcurrency = 0;
  maxConcurrency = 0;
  readonly activeLabels: Set<string> = new Set();
  readonly concurrentSnapshots: Array<{ label: string; active: string[]; concurrency: number }> = [];

  constructor(
    private readonly handler: (invocation: AgentInvocation) => Promise<string | { output: string; exitCode?: number }> | string | { output: string; exitCode?: number }
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

async function createTempWorkspace(): Promise<{ workspace: string; stateDir: string; }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omega-agent-bridge-"));
  tempRoots.push(root);
  const workspace = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "README.md"), "# Demo\n", "utf8");
  return { workspace, stateDir };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (target) => {
    await fs.rm(target, { recursive: true, force: true });
  }));
});

describe("orchestrator", () => {
  it("completes a happy-path run", async () => {
    const { workspace, stateDir } = await createTempWorkspace();
    const agent = new FakeAgent([
      JSON.stringify({
        summary: "Plan ready.",
        jobs: [
          {
            title: "Implement change",
            objective: "Update one file.",
            success_criteria: ["A file is updated."],
            can_write: true,
            priority: 1
          }
        ],
        risks: [],
        assumptions: []
      }),
      JSON.stringify({
        summary: "Implemented the change.",
        outcome: "done",
        changed_files: ["README.md"],
        checks_run: ["manual inspection"],
        open_questions: [],
        follow_up_instructions: null
      }),
      JSON.stringify({
        summary: "All success criteria are satisfied.",
        verdict: "pass",
        checks_run: ["reviewed README.md"],
        remaining_gaps: [],
        next_action: "none"
      })
    ]);

    const spec = parseRunSpec({
      goal: "Make one bounded improvement.",
      workspace,
      allow_write: true,
      success_criteria: ["A change is present."],
      state_dir: stateDir,
      max_subjobs: 3,
      timeout_minutes: 5,
      report_format: "full"
    }, workspace);

    const run = await startRun(spec, agent);
    expect(run.state).toBe("completed");
    expect(run.finalReport?.verdict).toBe("pass");
    expect(run.jobs.filter((job) => job.kind === "execution")).toHaveLength(1);
    expect(agent.invocations).toHaveLength(3);
    expect(agent.invocations.every(invocation => invocation.model === "strongest" && invocation.effort === "highest")).toBe(true);
    const saved = await loadRun(run.runId, stateDir);
    expect(saved.jobs.every(job => job.runtime?.verified && job.runtime.effectiveEffort === "fixed-thinking")).toBe(true);
    expect(summarizeRun(saved).agent_runs).toHaveLength(3);
    expect(summarizeRun(saved).agent_runs.every(job => job.runtime?.effectiveModel === "claude-opus-4-6-thinking")).toBe(true);
  });

  it("creates a follow-up job when execution asks for it", async () => {
    const { workspace, stateDir } = await createTempWorkspace();
    const agent = new FakeAgent([
      JSON.stringify({
        summary: "Plan ready.",
        jobs: [
          {
            title: "Primary change",
            objective: "Do the main change.",
            success_criteria: ["Main change is complete."],
            can_write: true,
            priority: 1
          }
        ],
        risks: [],
        assumptions: []
      }),
      JSON.stringify({
        summary: "Main change done, cleanup still needed.",
        outcome: "needs_followup",
        changed_files: ["README.md"],
        checks_run: ["manual inspection"],
        open_questions: [],
        follow_up_instructions: "Clean up the last rough edge and verify it."
      }),
      JSON.stringify({
        summary: "Cleanup complete.",
        outcome: "done",
        changed_files: ["README.md"],
        checks_run: ["manual inspection"],
        open_questions: [],
        follow_up_instructions: null
      }),
      JSON.stringify({
        summary: "Run is complete.",
        verdict: "pass",
        checks_run: ["final review"],
        remaining_gaps: [],
        next_action: "none"
      })
    ]);

    const spec = parseRunSpec({
      goal: "Complete one task with follow-up.",
      workspace,
      allow_write: true,
      success_criteria: ["The task is complete."],
      state_dir: stateDir,
      max_subjobs: 3,
      timeout_minutes: 5,
      report_format: "full"
    }, workspace);

    const run = await startRun(spec, agent);
    const executionJobs = run.jobs.filter((job) => job.kind === "execution");
    expect(run.state).toBe("completed");
    expect(executionJobs).toHaveLength(2);
    expect(executionJobs[1]?.title).toContain("follow-up");
  });

  it("auto-approves read-only execution jobs so headless agy can inspect", async () => {
    const { workspace, stateDir } = await createTempWorkspace();
    const agent = new FakeAgent([
      JSON.stringify({
        summary: "Plan ready.",
        jobs: [
          {
            title: "Inspect only",
            objective: "Inspect the workspace without writing.",
            success_criteria: ["The workspace is inspected."],
            can_write: false,
            priority: 1
          }
        ],
        risks: [],
        assumptions: []
      }),
      JSON.stringify({
        summary: "Inspection complete.",
        outcome: "done",
        changed_files: [],
        checks_run: ["inspection"],
        open_questions: [],
        follow_up_instructions: null
      }),
      JSON.stringify({
        summary: "Review passed.",
        verdict: "pass",
        checks_run: ["review"],
        remaining_gaps: [],
        next_action: "none"
      })
    ]);

    const spec = parseRunSpec({
      goal: "Inspect only.",
      workspace,
      allow_write: true,
      success_criteria: ["The workspace was inspected."],
      state_dir: stateDir,
      max_subjobs: 3,
      timeout_minutes: 5,
      report_format: "full"
    }, workspace);

    const run = await startRun(spec, agent);
    expect(run.state).toBe("completed");
    expect(agent.invocations[1]?.autoApprove).toBe(true);
  });

  it("resumes a pending run", async () => {
    const { workspace, stateDir } = await createTempWorkspace();
    const firstAgent = new FakeAgent([
      JSON.stringify({
        summary: "Plan ready.",
        jobs: [
          {
            title: "Primary change",
            objective: "Do the main change.",
            success_criteria: ["Main change is complete."],
            can_write: true,
            priority: 1
          }
        ],
        risks: [],
        assumptions: []
      })
    ]);

    const spec = parseRunSpec({
      goal: "Resume after planning.",
      workspace,
      allow_write: true,
      success_criteria: ["The task is complete."],
      state_dir: stateDir,
      max_subjobs: 3,
      timeout_minutes: 5,
      report_format: "full"
    }, workspace);

    const initialRun = await startRun(spec, firstAgent);
    const executionJob = initialRun.jobs.find((job) => job.kind === "execution");
    if (!executionJob) {
      throw new Error("Expected an execution job.");
    }
    executionJob.status = "pending";
    initialRun.state = "running";
    await fs.writeFile(path.join(initialRun.runDir, "run.json"), `${JSON.stringify(initialRun, null, 2)}\n`, "utf8");

    const secondAgent = new FakeAgent([
      JSON.stringify({
        summary: "Primary change complete.",
        outcome: "done",
        changed_files: ["README.md"],
        checks_run: ["manual inspection"],
        open_questions: [],
        follow_up_instructions: null
      }),
      JSON.stringify({
        summary: "Resume review passed.",
        verdict: "pass",
        checks_run: ["final review"],
        remaining_gaps: [],
        next_action: "none"
      })
    ]);

    const resumed = await resumeRun(initialRun.runId, stateDir, secondAgent);
    const stored = await loadRun(initialRun.runId, stateDir);
    expect(resumed.state).toBe("completed");
    expect(stored.state).toBe("completed");
  });

  it("executes independent read-only execution jobs concurrently", async () => {
    const { workspace, stateDir } = await createTempWorkspace();
    const agent = new ConcurrencyTrackingAgent(async (invocation) => {
      if (invocation.runLabel.startsWith("planning")) {
        return JSON.stringify({
          summary: "Audit plan ready.",
          jobs: Array.from({ length: 5 }, (_, i) => ({
            title: `Audit component ${i + 1}`,
            objective: `Inspect component ${i + 1} without writing.`,
            success_criteria: [`Component ${i + 1} is verified.`],
            can_write: false,
            priority: 1
          })),
          risks: [],
          assumptions: []
        });
      }
      if (invocation.runLabel.startsWith("execution")) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return JSON.stringify({
          summary: `Audit for ${invocation.runLabel} finished.`,
          outcome: "done",
          changed_files: [],
          checks_run: ["inspection"],
          open_questions: [],
          follow_up_instructions: null
        });
      }
      return JSON.stringify({
        summary: "Final review pass.",
        verdict: "pass",
        checks_run: ["review"],
        remaining_gaps: [],
        next_action: "none"
      });
    });

    const spec = parseRunSpec({
      goal: "Concurrent read-only audit.",
      workspace,
      allow_write: false,
      success_criteria: ["All components audited."],
      state_dir: stateDir,
      max_subjobs: 5,
      timeout_minutes: 5,
      report_format: "full"
    }, workspace);

    const run = await startRun(spec, agent);
    expect(run.state).toBe("completed");
    expect(agent.maxConcurrency).toBe(5);
    const executionJobs = run.jobs.filter((j) => j.kind === "execution");
    expect(executionJobs).toHaveLength(5);
    expect(executionJobs.every((j) => j.status === "completed")).toBe(true);

    const stored = await loadRun(run.runId, stateDir);
    expect(stored.state).toBe("completed");
    expect(stored.jobs.filter((j) => j.kind === "execution" && j.status === "completed")).toHaveLength(5);
  });

  it("caps concurrent read-only jobs to 10 workers", async () => {
    const { workspace, stateDir } = await createTempWorkspace();
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const agent = new ConcurrencyTrackingAgent(async (invocation) => {
      if (invocation.runLabel.startsWith("planning")) {
        return JSON.stringify({
          summary: "Large audit plan ready.",
          jobs: Array.from({ length: 12 }, (_, i) => ({
            title: `Audit module ${i + 1}`,
            objective: `Inspect module ${i + 1}.`,
            success_criteria: [`Module ${i + 1} inspected.`],
            can_write: false,
            priority: 1
          })),
          risks: [],
          assumptions: []
        });
      }
      if (invocation.runLabel.startsWith("execution")) {
        if (agent.currentConcurrency >= 10) {
          releaseBarrier();
        } else {
          await Promise.race([
            barrier,
            new Promise((resolve) => setTimeout(resolve, 300))
          ]);
        }
        return JSON.stringify({
          summary: `Module ${invocation.runLabel} audit finished.`,
          outcome: "done",
          changed_files: [],
          checks_run: ["audit"],
          open_questions: [],
          follow_up_instructions: null
        });
      }
      return JSON.stringify({
        summary: "Audit review pass.",
        verdict: "pass",
        checks_run: ["review"],
        remaining_gaps: [],
        next_action: "none"
      });
    });

    const spec = parseRunSpec({
      goal: "Large parallel audit.",
      workspace,
      allow_write: false,
      success_criteria: ["All modules audited."],
      state_dir: stateDir,
      max_subjobs: 12,
      timeout_minutes: 5,
      report_format: "full"
    }, workspace);

    const run = await startRun(spec, agent);
    expect(run.state).toBe("completed");
    expect(agent.maxConcurrency).toBe(10);
    const executionJobs = run.jobs.filter((j) => j.kind === "execution");
    expect(executionJobs).toHaveLength(12);
    expect(executionJobs.every((j) => j.status === "completed")).toBe(true);
  });

  it("strictly serializes write jobs with exclusive workspace access", async () => {
    const { workspace, stateDir } = await createTempWorkspace();
    const agent = new ConcurrencyTrackingAgent(async (invocation) => {
      if (invocation.runLabel.startsWith("planning")) {
        return JSON.stringify({
          summary: "Mixed plan ready.",
          jobs: [
            { title: "Read 1", objective: "Inspect 1", success_criteria: ["Done"], can_write: false, priority: 1 },
            { title: "Read 2", objective: "Inspect 2", success_criteria: ["Done"], can_write: false, priority: 2 },
            { title: "Write 3", objective: "Write 3", success_criteria: ["Done"], can_write: true, priority: 3 },
            { title: "Read 4", objective: "Inspect 4", success_criteria: ["Done"], can_write: false, priority: 4 },
            { title: "Read 5", objective: "Inspect 5", success_criteria: ["Done"], can_write: false, priority: 5 }
          ],
          risks: [],
          assumptions: []
        });
      }
      if (invocation.runLabel.startsWith("execution")) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return JSON.stringify({
          summary: `${invocation.runLabel} done.`,
          outcome: "done",
          changed_files: invocation.runLabel === "execution-004" ? ["README.md"] : [],
          checks_run: ["check"],
          open_questions: [],
          follow_up_instructions: null
        });
      }
      return JSON.stringify({
        summary: "Mixed review pass.",
        verdict: "pass",
        checks_run: ["review"],
        remaining_gaps: [],
        next_action: "none"
      });
    });

    const spec = parseRunSpec({
      goal: "Mixed read-write run.",
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

    // Write 3 is execution-004 (planning was planning-001)
    const writeSnapshot = agent.concurrentSnapshots.find((s) => s.label === "execution-004");
    expect(writeSnapshot).toBeDefined();
    expect(writeSnapshot?.concurrency).toBe(1);
    expect(writeSnapshot?.active).toEqual(["execution-004"]);

    // Verify read jobs before write ran concurrently despite distinct priorities (1 and 2)
    const read2Snapshot = agent.concurrentSnapshots.find((s) => s.label === "execution-002");
    const read3Snapshot = agent.concurrentSnapshots.find((s) => s.label === "execution-003");
    expect(read2Snapshot?.active).not.toContain("execution-004");
    expect(read3Snapshot?.active).not.toContain("execution-004");
    expect(read3Snapshot?.active).toContain("execution-002");

    // Verify read jobs after write ran concurrently despite distinct priorities (4 and 5)
    // and neither overlapped with the write job
    const read5Snapshot = agent.concurrentSnapshots.find((s) => s.label === "execution-005");
    const read6Snapshot = agent.concurrentSnapshots.find((s) => s.label === "execution-006");
    expect(read5Snapshot?.active).not.toContain("execution-004");
    expect(read6Snapshot?.active).not.toContain("execution-004");
    expect(read6Snapshot?.active).toContain("execution-005");
  });

  it("strictly serializes follow-up jobs with exclusive workspace access", async () => {
    const { workspace, stateDir } = await createTempWorkspace();
    const agent = new ConcurrencyTrackingAgent(async (invocation) => {
      if (invocation.runLabel.startsWith("planning")) {
        return JSON.stringify({
          summary: "Followup test plan ready.",
          jobs: [
            { title: "Task 1", objective: "Do task 1", success_criteria: ["Done"], can_write: false, priority: 1 },
            { title: "Task 2", objective: "Do task 2", success_criteria: ["Done"], can_write: false, priority: 1 },
            { title: "Task 3", objective: "Do task 3", success_criteria: ["Done"], can_write: false, priority: 1 }
          ],
          risks: [],
          assumptions: []
        });
      }
      if (invocation.runLabel === "execution-002") {
        // Fast job that requests follow-up
        await new Promise((resolve) => setTimeout(resolve, 5));
        return JSON.stringify({
          summary: "Task 1 needs follow-up.",
          outcome: "needs_followup",
          changed_files: [],
          checks_run: ["check"],
          open_questions: [],
          follow_up_instructions: "Complete remaining parts of Task 1."
        });
      }
      if (invocation.runLabel === "execution-003" || invocation.runLabel === "execution-004") {
        // Slower parallel jobs
        await new Promise((resolve) => setTimeout(resolve, 40));
        return JSON.stringify({
          summary: `${invocation.runLabel} done.`,
          outcome: "done",
          changed_files: [],
          checks_run: ["check"],
          open_questions: [],
          follow_up_instructions: null
        });
      }
      if (invocation.runLabel === "execution-005") {
        // The follow-up job spawned by Task 1
        await new Promise((resolve) => setTimeout(resolve, 15));
        return JSON.stringify({
          summary: "Task 1 follow-up complete.",
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
      goal: "Follow-up serialization test.",
      workspace,
      allow_write: false,
      success_criteria: ["Done."],
      state_dir: stateDir,
      max_subjobs: 5,
      timeout_minutes: 5,
      report_format: "full"
    }, workspace);

    const run = await startRun(spec, agent);
    expect(run.state).toBe("completed");

    // The follow-up job (execution-005) must run exclusively with concurrency 1
    const followUpSnapshot = agent.concurrentSnapshots.find((s) => s.label === "execution-005");
    expect(followUpSnapshot).toBeDefined();
    expect(followUpSnapshot?.concurrency).toBe(1);
    expect(followUpSnapshot?.active).toEqual(["execution-005"]);
  });

  it("executes independent read-only jobs with distinct priorities concurrently in priority order", async () => {
    const { workspace, stateDir } = await createTempWorkspace();
    const agent = new ConcurrencyTrackingAgent(async (invocation) => {
      if (invocation.runLabel.startsWith("planning")) {
        return JSON.stringify({
          summary: "Audit plan ready.",
          jobs: [
            { title: "Audit module A", objective: "Inspect A", success_criteria: ["Done"], can_write: false, priority: 1 },
            { title: "Audit module B", objective: "Inspect B", success_criteria: ["Done"], can_write: false, priority: 2 },
            { title: "Audit module C", objective: "Inspect C", success_criteria: ["Done"], can_write: false, priority: 3 },
            { title: "Audit module D", objective: "Inspect D", success_criteria: ["Done"], can_write: false, priority: 4 }
          ],
          risks: [],
          assumptions: []
        });
      }
      if (invocation.runLabel.startsWith("execution")) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return JSON.stringify({
          summary: `${invocation.runLabel} audit finished.`,
          outcome: "done",
          changed_files: [],
          checks_run: ["audit"],
          open_questions: [],
          follow_up_instructions: null
        });
      }
      return JSON.stringify({
        summary: "Audit review pass.",
        verdict: "pass",
        checks_run: ["review"],
        remaining_gaps: [],
        next_action: "none"
      });
    });

    const spec = parseRunSpec({
      goal: "Concurrent distinct priority audit.",
      workspace,
      allow_write: false,
      success_criteria: ["All audited."],
      state_dir: stateDir,
      max_subjobs: 5,
      timeout_minutes: 5,
      report_format: "full"
    }, workspace);

    const run = await startRun(spec, agent);
    expect(run.state).toBe("completed");

    // All 4 execution jobs with distinct priorities must have executed concurrently
    expect(agent.maxConcurrency).toBe(4);

    // Verify invocations started in ascending priority order (1, 2, 3, 4)
    const executionInvocations = agent.invocations.filter((i) => i.runLabel.startsWith("execution"));
    expect(executionInvocations.map((i) => i.runLabel)).toEqual([
      "execution-002",
      "execution-003",
      "execution-004",
      "execution-005"
    ]);

    // Verify snapshots confirm distinct priorities actually overlapped
    const snapLast = agent.concurrentSnapshots.find((s) => s.label === "execution-005");
    expect(snapLast).toBeDefined();
    expect(snapLast?.concurrency).toBe(4);
    expect(snapLast?.active).toEqual(
      expect.arrayContaining(["execution-002", "execution-003", "execution-004", "execution-005"])
    );
  });

  it("handles execution failures under concurrency and halts further dispatch", async () => {
    const { workspace, stateDir } = await createTempWorkspace();
    const agent = new ConcurrencyTrackingAgent(async (invocation) => {
      if (invocation.runLabel.startsWith("planning")) {
        return JSON.stringify({
          summary: "Plan ready.",
          jobs: [
            { title: "Task 1", objective: "Inspect 1", success_criteria: ["Done"], can_write: false, priority: 1 },
            { title: "Task 2", objective: "Inspect 2", success_criteria: ["Done"], can_write: false, priority: 1 },
            { title: "Task 3", objective: "Inspect 3", success_criteria: ["Done"], can_write: false, priority: 1 },
            { title: "Task 4", objective: "Apply fix 4", success_criteria: ["Done"], can_write: true, priority: 2 }
          ],
          risks: [],
          assumptions: []
        });
      }
      if (invocation.runLabel === "execution-003") {
        // Task 2 fails
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { output: "Fatal process error during execution", exitCode: 1 };
      }
      if (invocation.runLabel.startsWith("execution")) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return JSON.stringify({
          summary: `${invocation.runLabel} done.`,
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
      goal: "Failure under concurrency test.",
      workspace,
      allow_write: true,
      success_criteria: ["Done."],
      state_dir: stateDir,
      max_subjobs: 5,
      timeout_minutes: 5,
      report_format: "full"
    }, workspace);

    const run = await startRun(spec, agent);
    expect(run.state).toBe("failed");
    expect(run.error).toContain("execution-003");

    // Task 4 (execution-005, priority 2, exclusive write) must never have been dispatched
    expect(agent.invocations.some((i) => i.runLabel === "execution-005")).toBe(false);

    // Verify stored state on disk
    const stored = await loadRun(run.runId, stateDir);
    expect(stored.state).toBe("failed");
    expect(stored.jobs.find((j) => j.id === "execution-003")?.status).toBe("failed");
  });

  it("handles run cancellation under concurrency cleanly", async () => {
    const { workspace, stateDir } = await createTempWorkspace();
    let runIdRef = "";
    const runsDir = path.join(stateDir, "runs");

    const agent = new ConcurrencyTrackingAgent(async (invocation) => {
      if (invocation.runLabel.startsWith("planning")) {
        return JSON.stringify({
          summary: "Plan ready.",
          jobs: [
            { title: "Task 1", objective: "Inspect 1", success_criteria: ["Done"], can_write: false, priority: 1 },
            { title: "Task 2", objective: "Inspect 2", success_criteria: ["Done"], can_write: false, priority: 1 },
            { title: "Task 3", objective: "Apply fix 3", success_criteria: ["Done"], can_write: true, priority: 2 },
            { title: "Task 4", objective: "Apply fix 4", success_criteria: ["Done"], can_write: true, priority: 2 }
          ],
          risks: [],
          assumptions: []
        });
      }
      if (invocation.runLabel === "execution-002") {
        await new Promise((resolve) => setTimeout(resolve, 10));
        // Cancel the run mid-flight while task 1 and task 2 are executing
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
          summary: "Task 1 done before cancel acknowledged.",
          outcome: "done",
          changed_files: [],
          checks_run: ["check"],
          open_questions: [],
          follow_up_instructions: null
        });
      }
      if (invocation.runLabel === "execution-003") {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return JSON.stringify({
          summary: "Task 2 done.",
          outcome: "done",
          changed_files: [],
          checks_run: ["check"],
          open_questions: [],
          follow_up_instructions: null
        });
      }
      return JSON.stringify({
        summary: "Default response.",
        outcome: "done",
        changed_files: [],
        checks_run: ["check"],
        open_questions: [],
        follow_up_instructions: null
      });
    });

    const spec = parseRunSpec({
      goal: "Cancellation under concurrency test.",
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

    // Tasks 3 and 4 (execution-004 and execution-005, priority 2) must never have been dispatched
    expect(agent.invocations.some((i) => i.runLabel === "execution-004")).toBe(false);
    expect(agent.invocations.some((i) => i.runLabel === "execution-005")).toBe(false);

    // Stored state on disk must be cancelled
    const stored = await loadRun(run.runId, stateDir);
    expect(stored.state).toBe("cancelled");
  });

  it("handles highly concurrent saveRun operations without corrupting run.json", async () => {
    const { workspace, stateDir } = await createTempWorkspace();
    const spec = parseRunSpec({
      goal: "Concurrent saveRun test.",
      workspace,
      allow_write: false,
      success_criteria: ["Integrity verified."],
      state_dir: stateDir,
      max_subjobs: 5,
      timeout_minutes: 5,
      report_format: "full"
    }, workspace);

    const run = await createRun(spec);

    // Concurrently trigger multiple saveRun operations updating properties
    const saveCount = 20;
    await Promise.all(
      Array.from({ length: saveCount }, async (_, i) => {
        run.summary = `Update ${i}`;
        await saveRun(run);
      })
    );

    const loaded = await loadRun(run.runId, stateDir);
    expect(loaded.runId).toBe(run.runId);
    expect(loaded.summary).toMatch(/^Update \d+$/);
    expect(loaded.state).toBe("pending");
  });
});
