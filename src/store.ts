import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import type {
  BridgeJob,
  BridgeRun,
  AgentRuntime,
  JobKind,
  ReviewResponse,
  RunSpec
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

export function createRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
}

export function createJobId(kind: JobKind, sequence: number): string {
  return `${kind}-${String(sequence).padStart(3, "0")}`;
}

export async function ensureDir(target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true });
}

export async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function writeJson(target: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(target));
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJson<T>(target: string): Promise<T> {
  const raw = await fs.readFile(target, "utf8");
  return JSON.parse(raw) as T;
}

export async function writeText(target: string, value: string): Promise<void> {
  await ensureDir(path.dirname(target));
  await fs.writeFile(target, value, "utf8");
}

export async function loadRun(runId: string, stateDir: string): Promise<BridgeRun> {
  return readJson<BridgeRun>(path.join(stateDir, "runs", runId, "run.json"));
}

const saveQueues = new Map<string, Promise<void>>();

export async function saveRun(run: BridgeRun): Promise<void> {
  run.updatedAt = nowIso();
  const filePath = path.join(run.runDir, "run.json");
  const tempPath = path.join(run.runDir, `run.json.tmp.${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);

  const previous = saveQueues.get(run.runId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    // Once cancellation is requested, it must never be reverted by a parallel save
    if (!run.cancelRequested) {
      try {
        const existing = await readJson<BridgeRun>(filePath);
        if (existing.cancelRequested) {
          run.cancelRequested = true;
        }
      } catch {
        // file may not exist yet on initial save
      }
    }
    const serialized = `${JSON.stringify(run, null, 2)}\n`;
    await ensureDir(run.runDir);
    await fs.writeFile(tempPath, serialized, "utf8");
    try {
      await fs.rename(tempPath, filePath);
    } catch {
      await fs.copyFile(tempPath, filePath);
      await fs.unlink(tempPath).catch(() => {});
    }
  });

  saveQueues.set(run.runId, next);
  try {
    await next;
  } finally {
    if (saveQueues.get(run.runId) === next) {
      saveQueues.delete(run.runId);
    }
  }
}

export async function createRun(spec: RunSpec): Promise<BridgeRun> {
  const runId = createRunId();
  const runDir = path.join(spec.state_dir, "runs", runId);
  const artifactsDir = path.join(runDir, "artifacts");
  const logsDir = path.join(runDir, "logs");
  const createdAt = nowIso();

  await ensureDir(artifactsDir);
  await ensureDir(logsDir);

  const run: BridgeRun = {
    runId,
    version: 1,
    engine: spec.engine,
    state: "pending",
    createdAt,
    updatedAt: createdAt,
    workspace: spec.workspace,
    stateDir: spec.state_dir,
    runDir,
    artifactsDir,
    logsDir,
    spec,
    planSummary: "",
    planningRisks: [],
    planningAssumptions: [],
    finalReport: null,
    summary: "",
    error: null,
    cancelRequested: false,
    writeApproval: null,
    jobs: []
  };

  await saveRun(run);
  return run;
}

export function createJob(kind: JobKind, sequence: number, input: {
  title: string;
  objective: string;
  successCriteria: string[];
  canWrite: boolean;
  priority?: number;
  isFollowUp?: boolean;
  isolated?: boolean;
  engine?: BridgeJob["engine"];
  account?: string | null;
}): BridgeJob {
  const createdAt = nowIso();
  return {
    id: createJobId(kind, sequence),
    kind,
    title: input.title,
    objective: input.objective,
    successCriteria: input.successCriteria,
    canWrite: input.canWrite,
    priority: input.priority ?? sequence,
    ...(input.engine !== undefined ? { engine: input.engine } : {}),
    ...(input.account !== undefined ? { account: input.account } : {}),
    isFollowUp: input.isFollowUp ?? false,
    ...(input.isolated !== undefined ? { isolated: input.isolated } : {}),
    status: "pending",
    attempts: 0,
    createdAt,
    startedAt: null,
    finishedAt: null,
    promptPath: null,
    responsePath: null,
    logPath: null,
    resultSummary: "",
    changedFiles: [],
    checksRun: [],
    openQuestions: [],
    followUpInstructions: null,
    error: null
  };
}

export function summarizeRun(run: BridgeRun): {
  run_id: string;
  state: string;
  workspace: string;
  state_dir: string;
  completed_jobs: number;
  failed_jobs: number;
  pending_jobs: number;
  summary: string;
  final_report: ReviewResponse | null;
  model_policy: string;
  effort_policy: string;
  engine: string;
  planning_engine: string;
  review_engine: string;
  write_approved: boolean;
  agent_runs: Array<{ job_id: string; kind: JobKind; engine: string; runtime: AgentRuntime | null }>;
} {
  const completedJobs = run.jobs.filter((job) => job.status === "completed").length;
  const failedJobs = run.jobs.filter((job) => job.status === "failed" || job.status === "blocked").length;
  const pendingJobs = run.jobs.filter((job) => job.status === "pending" || job.status === "running").length;

  return {
    run_id: run.runId,
    state: run.state,
    workspace: run.workspace,
    state_dir: run.stateDir,
    engine: run.spec.engine,
    planning_engine: run.spec.planning_engine,
    review_engine: run.spec.review_engine,
    write_approved: Boolean(run.writeApproval),
    model_policy: run.spec.model ?? "strongest",
    effort_policy: run.spec.effort ?? "highest",
    agent_runs: run.jobs.map(job => ({
      job_id: job.id,
      kind: job.kind,
      engine: job.engine ?? run.spec.engine,
      runtime: job.runtime ?? null
    })),
    completed_jobs: completedJobs,
    failed_jobs: failedJobs,
    pending_jobs: pendingJobs,
    summary: run.summary,
    final_report: run.finalReport
  };
}

export async function listRuns(stateDir: string): Promise<BridgeRun[]> {
  const runsDir = path.join(stateDir, "runs");
  if (!(await fileExists(runsDir))) {
    return [];
  }

  const entries = await fs.readdir(runsDir, { withFileTypes: true });
  const runs: BridgeRun[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const runPath = path.join(runsDir, entry.name, "run.json");
    if (!(await fileExists(runPath))) {
      continue;
    }
    runs.push(await readJson<BridgeRun>(runPath));
  }
  return runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function requestRunCancellation(runId: string, stateDir: string): Promise<BridgeRun> {
  const run = await loadRun(runId, stateDir);
  run.cancelRequested = true;
  if (run.state === "pending") {
    run.state = "cancelled";
  }
  await saveRun(run);
  return run;
}
