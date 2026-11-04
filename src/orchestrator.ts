import fs from "node:fs/promises";
import path from "node:path";
import { ZodType } from "zod";

import { parseAccountRef } from "./accounts.js";
import { extractJsonDocument } from "./json.js";
import { buildExecutionPrompt, buildPeerReviewPrompt, buildPlanningPrompt, buildReviewPrompt } from "./prompts.js";
import {
  applyIntegration,
  cleanupIsolatedWorkspace,
  createIsolatedWorkspace,
  detectIntegrationConflicts,
  detectWorkerChanges,
  takeWorkspaceSnapshot,
  type WorkerChangeset
} from "./workspace-isolation.js";
import {
  createJob,
  createRun,
  ensureDir,
  loadRun,
  saveRun,
  writeText
} from "./store.js";
import {
  executionResponseSchema,
  planningResponseSchema,
  reviewResponseSchema
} from "./schema.js";
import type {
  AgentAdapter,
  AgentResolver,
  BridgeJob,
  BridgeRun,
  EngineName,
  ExecutionResponse,
  PlanningResponse,
  ReviewResponse,
  RunSpec,
  WriteApproval
} from "./types.js";

export interface RunOptions {
  /** Plan only; never dispatch execution jobs. */
  planOnly?: boolean;
  /** Explicit write approval for this run. */
  allowWrite?: boolean;
  /**
   * When true, a write-capable job may not run until `allowWrite` has been
   * recorded. Legacy callers that pass no options keep the historical
   * behaviour for backward compatibility.
   */
  requireWriteApproval?: boolean;
}

export type AgentSource = AgentAdapter | AgentResolver;

function nowIso(): string {
  return new Date().toISOString();
}

function ensureWorkspaceExists(runSpec: RunSpec): Promise<void> {
  return fs.access(runSpec.workspace);
}

function nextJobSequence(run: BridgeRun): number {
  const maxSeq = run.jobs.reduce((max, j) => {
    const parts = j.id.split("-");
    const lastPart = parts[parts.length - 1];
    const num = lastPart !== undefined ? parseInt(lastPart, 10) : NaN;
    return isNaN(num) ? max : Math.max(max, num);
  }, 0);
  return Math.max(run.jobs.length, maxSeq) + 1;
}

function isAgentResolver(source: AgentSource): source is AgentResolver {
  return typeof source === "function";
}

function agentFor(source: AgentSource, engine: EngineName): AgentAdapter {
  return isAgentResolver(source) ? source(engine) : source;
}

function reviewEngineFor(run: BridgeRun): EngineName {
  if (run.spec.review_engine !== "auto") {
    return run.spec.review_engine;
  }
  // Prefer an engine that did not execute any job in this run. This keeps the
  // review independent even when the planner routed execution away from the
  // default engine.
  const executed = new Set<EngineName>(
    run.jobs
      .filter((job) => job.kind === "execution" && job.engine !== undefined)
      .map((job) => job.engine as EngineName)
  );
  const independent = run.spec.allowed_engines.find((engine) => !executed.has(engine));
  if (independent) {
    return independent;
  }
  const alternate = run.spec.allowed_engines.find((engine) => engine !== run.spec.engine);
  return alternate ?? run.spec.engine;
}

function isAllAccountsExhausted(text: string): boolean {
  return /all_accounts_exhausted/i.test(text);
}

function accountForEngine(
  run: BridgeRun,
  engine: EngineName,
  jobAccount: string | null | undefined
): string | null {
  if (jobAccount && jobAccount.trim()) {
    const trimmed = jobAccount.trim();
    if (path.isAbsolute(trimmed)) {
      return engine === "agy" ? trimmed : null;
    }
    const parsed = parseAccountRef(trimmed, engine);
    if (parsed.engine !== engine) {
      throw new Error(
        `Job account '${trimmed}' belongs to engine '${parsed.engine}', but the job targets '${engine}'.`
      );
    }
    return parsed.id;
  }

  const requested = run.spec.account;
  if (!requested || !requested.trim()) {
    return null;
  }
  const trimmed = requested.trim();
  if (path.isAbsolute(trimmed)) {
    return engine === "agy" ? trimmed : null;
  }
  const parsed = parseAccountRef(trimmed, run.spec.engine);
  return parsed.engine === engine ? parsed.id : null;
}

function createExecutionJobsFromPlan(run: BridgeRun, plan: PlanningResponse): BridgeJob[] {
  const limitedJobs = plan.jobs.slice(0, run.spec.max_subjobs);
  const allowed = new Set<EngineName>(run.spec.allowed_engines);

  for (const job of limitedJobs) {
    if (job.engine && !allowed.has(job.engine)) {
      throw new Error(
        `Plan assigned '${job.title}' to engine '${job.engine}', which is not in allowed_engines (${run.spec.allowed_engines.join(", ")}).`
      );
    }
    if (job.account) {
      const targetEngine = job.engine ?? run.spec.engine;
      const parsed = parseAccountRef(job.account, targetEngine);
      if (parsed.engine !== targetEngine) {
        throw new Error(
          `Plan assigned account '${job.account}' to '${job.title}', but the job targets engine '${targetEngine}'.`
        );
      }
    }
  }

  if (limitedJobs.length === 0) {
    return [
      createJob("execution", nextJobSequence(run), {
        title: "Primary task",
        objective: run.spec.goal,
        successCriteria: run.spec.success_criteria.length > 0
          ? run.spec.success_criteria
          : ["Complete the requested work in the workspace."],
        canWrite: run.spec.allow_write,
        priority: 1,
        engine: run.spec.engine,
        account: accountForEngine(run, run.spec.engine, null)
      })
    ];
  }

  return limitedJobs.map((job, index) => {
    const engine = job.engine ?? run.spec.engine;
    return createJob("execution", run.jobs.length + index + 1, {
      title: job.title,
      objective: job.objective,
      successCriteria: job.success_criteria,
      canWrite: run.spec.allow_write && job.can_write,
      priority: job.priority,
      engine,
      account: accountForEngine(run, engine, job.account)
    });
  });
}

async function parseAgentJson<T>(schema: ZodType<T>, rawOutput: string): Promise<T> {
  const jsonDocument = extractJsonDocument(rawOutput);
  return schema.parse(JSON.parse(jsonDocument)) as T;
}

async function writeArtifacts(run: BridgeRun, job: BridgeJob, prompt: string, response: string): Promise<{ promptPath: string; responsePath: string; logPath: string; }> {
  const promptPath = path.join(run.artifactsDir, `${job.id}.prompt.txt`);
  const responsePath = path.join(run.artifactsDir, `${job.id}.response.txt`);
  const logPath = path.join(run.logsDir, `${job.id}.log`);
  await writeText(promptPath, prompt);
  await writeText(responsePath, response);
  return { promptPath, responsePath, logPath };
}

function summarizeCompletedJobs(run: BridgeRun): string {
  return run.jobs
    .filter((job) => job.kind === "execution" && job.status === "completed")
    .map((job) => job.resultSummary)
    .filter(Boolean)
    .join(" | ");
}

function summarizeAgentFailure(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) {
    return "Agent process exited without any output.";
  }
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  const quotaLines = lines.filter((line) =>
    /RESOURCE_EXHAUSTED|quota reached|Resets in|all_accounts_exhausted/i.test(line)
  );
  if (quotaLines.length > 0) {
    return quotaLines.slice(-3).join("\n");
  }
  return lines.slice(-40).join("\n");
}

/**
 * Dispatch one invocation, optionally falling back to an explicitly configured
 * engine. Fallback is only allowed when `fallback_engines` is non-empty and the
 * failure is an exhausted account pool.
 */
async function dispatch(
  run: BridgeRun,
  source: AgentSource,
  engine: EngineName,
  invocationBase: {
    prompt: string;
    workspace: string;
    timeoutMs: number;
    logPath: string;
    runLabel: string;
    autoApprove?: boolean;
    canWrite?: boolean;
    model: string | null;
    effort?: string;
    account?: string | null;
    responseSchema?: object;
  }
): Promise<ReturnType<AgentAdapter["run"]>> {
  const order = [engine, ...run.spec.fallback_engines.filter((candidate) => candidate !== engine)];
  let lastResult: Awaited<ReturnType<AgentAdapter["run"]>> | null = null;
  let lastError: unknown = null;

  for (let index = 0; index < order.length; index++) {
    const currentEngine = order[index]!;
    // Preserve a per-job account pin for the requested engine. A fallback
    // engine must not receive an account ID that belongs to another engine;
    // it uses the spec-level pin only when that pin matches its own pool.
    const invocation = {
      ...invocationBase,
      account: accountForEngine(run, currentEngine, index === 0 ? invocationBase.account : null)
    };

    let result: Awaited<ReturnType<AgentAdapter["run"]>>;
    try {
      result = await agentFor(source, currentEngine).run(invocation);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!isAllAccountsExhausted(message)) {
        throw error;
      }
      continue;
    }

    lastResult = result;

    if (result.runtime && index > 0) {
      result.runtime.fallbackFrom = order[index - 1]!;
      result.runtime.fallbackReason = "all_accounts_exhausted";
    }

    if (result.exitCode === 0 || !isAllAccountsExhausted(result.combinedOutput)) {
      return result;
    }
  }

  if (lastResult) {
    return lastResult;
  }
  throw lastError ?? new Error("No engine could dispatch the invocation.");
}

function ensureWriteExecutionApproval(run: BridgeRun): void {
  if (!run.writeApproval) {
    run.writeApproval = { at: nowIso(), source: "user" } satisfies WriteApproval;
  }
}

async function executePlanning(
  run: BridgeRun,
  source: AgentSource,
  options: RunOptions
): Promise<BridgeRun> {
  const engine = run.spec.planning_engine;
  const planningJob = createJob("planning", nextJobSequence(run), {
    title: "Plan delegated work",
    objective: "Inspect the workspace and generate a minimal execution plan.",
    successCriteria: ["A valid job plan exists."],
    canWrite: false,
    priority: 0,
    engine,
    account: accountForEngine(run, engine, null)
  });
  run.jobs.push(planningJob);
  await saveRun(run);

  const prompt = buildPlanningPrompt(run.spec);
  planningJob.status = "running";
  planningJob.startedAt = nowIso();
  planningJob.attempts += 1;
  await saveRun(run);

  const paths = await writeArtifacts(run, planningJob, prompt, "");
  planningJob.promptPath = paths.promptPath;
  planningJob.responsePath = paths.responsePath;
  planningJob.logPath = paths.logPath;
  await saveRun(run);

  try {
    const result = await dispatch(run, source, engine, {
      prompt,
      workspace: run.workspace,
      timeoutMs: run.spec.timeout_minutes * 60_000,
      logPath: paths.logPath,
      runLabel: planningJob.id,
      autoApprove: engine === "agy",
      canWrite: false,
      model: run.spec.model,
      effort: run.spec.effort ?? "highest",
      account: planningJob.account ?? null
    });

    planningJob.runtime = result.runtime ?? null;
    await writeText(paths.responsePath, result.combinedOutput);
    if (result.exitCode !== 0) {
      throw new Error(summarizeAgentFailure(result.combinedOutput));
    }
    const parsed = await parseAgentJson(planningResponseSchema, result.combinedOutput);
    planningJob.status = "completed";
    planningJob.finishedAt = nowIso();
    planningJob.resultSummary = parsed.summary;
    run.planSummary = parsed.summary;
    run.planningRisks = parsed.risks;
    run.planningAssumptions = parsed.assumptions;
    run.jobs.push(...createExecutionJobsFromPlan(run, parsed));
    run.summary = parsed.summary;
    await saveRun(run);

    if (options.planOnly) {
      run.state = "pending";
      run.summary = parsed.summary
        ? `Plan ready. ${parsed.summary}`
        : "Plan ready. Awaiting execution approval.";
      await saveRun(run);
    }

    return run;
  } catch (error) {
    planningJob.status = "failed";
    planningJob.finishedAt = nowIso();
    planningJob.error = error instanceof Error ? error.message : String(error);
    run.state = "failed";
    run.error = `Planning failed: ${planningJob.error}`;
    await saveRun(run);
    return run;
  }
}

function isExecutionJobPending(job: BridgeJob): boolean {
  return job.kind === "execution" && job.status === "pending";
}

function isFollowUpJob(job: BridgeJob): boolean {
  return (
    job.isFollowUp === true ||
    job.title.includes("follow-up") ||
    job.title.startsWith("Close review gaps")
  );
}

function isExclusiveJob(job: BridgeJob): boolean {
  return job.canWrite || isFollowUpJob(job);
}

function buildFollowUpJob(run: BridgeRun, sourceJob: BridgeJob): BridgeJob {
  return createJob("execution", nextJobSequence(run), {
    title: `${sourceJob.title} follow-up`,
    objective: sourceJob.followUpInstructions ?? `Finish the remaining work for ${sourceJob.title}.`,
    successCriteria: sourceJob.successCriteria,
    canWrite: sourceJob.canWrite,
    priority: sourceJob.priority + 1,
    isFollowUp: true,
    engine: sourceJob.engine ?? run.spec.engine,
    account: sourceJob.account ?? null
  });
}

function writeApprovalRequired(run: BridgeRun, job: BridgeJob, options: RunOptions): boolean {
  return (
    options.requireWriteApproval === true &&
    job.canWrite &&
    !run.writeApproval
  );
}

async function executeJob(
  run: BridgeRun,
  job: BridgeJob,
  source: AgentSource,
  options: RunOptions
): Promise<BridgeRun> {
  const engine = job.engine ?? run.spec.engine;
  const prompt = buildExecutionPrompt(run, job);
  job.status = "running";
  job.startedAt = nowIso();
  job.attempts += 1;
  await saveRun(run);

  const paths = await writeArtifacts(run, job, prompt, "");
  job.promptPath = paths.promptPath;
  job.responsePath = paths.responsePath;
  job.logPath = paths.logPath;
  await saveRun(run);

  try {
    if (job.canWrite && options.requireWriteApproval !== true) {
      // Legacy direct API calls predate the approval record. The CLI always
      // requires an explicit approval, so this branch is only for callers that
      // already own the run.
      ensureWriteExecutionApproval(run);
    }

    const result = await dispatch(run, source, engine, {
      prompt,
      // All write-capable jobs run in run.workspace exclusively. Directory copies
      // provide no OS-level security boundary against unrestricted host filesystem access
      // under --dangerously-skip-permissions.
      workspace: run.workspace,
      timeoutMs: run.spec.timeout_minutes * 60_000,
      logPath: paths.logPath,
      runLabel: job.id,
      // agy's permission flag is all-or-nothing: without it, headless mode
      // auto-denies every tool, including read-only ones like git status or
      // grep, so a read-only job could never run at all. The write restriction
      // for canWrite=false jobs is carried by the execution prompt instead.
      autoApprove: engine === "agy",
      canWrite: job.canWrite,
      model: run.spec.model,
      effort: run.spec.effort ?? "highest",
      account: job.account ?? null
    });
    job.runtime = result.runtime ?? null;
    await writeText(paths.responsePath, result.combinedOutput);
    if (result.exitCode !== 0) {
      throw new Error(summarizeAgentFailure(result.combinedOutput));
    }
    const parsed = await parseAgentJson(executionResponseSchema, result.combinedOutput);
    job.finishedAt = nowIso();
    job.resultSummary = parsed.summary;
    job.changedFiles = parsed.changed_files;
    job.checksRun = parsed.checks_run;
    job.openQuestions = parsed.open_questions;
    job.followUpInstructions = parsed.follow_up_instructions;

    if (parsed.outcome === "done") {
      job.status = "completed";
    } else if (parsed.outcome === "needs_followup") {
      job.status = "completed";
      if (job.attempts < 2) {
        run.jobs.push(buildFollowUpJob(run, job));
      }
    } else {
      job.status = "blocked";
      job.error = parsed.summary;
      run.state = "failed";
      run.error = `Execution blocked in ${job.id}: ${parsed.summary}`;
    }

    run.summary = summarizeCompletedJobs(run) || parsed.summary;
    await saveRun(run);
    return run;
  } catch (error) {
    job.status = "failed";
    job.finishedAt = nowIso();
    job.error = error instanceof Error ? error.message : String(error);
    run.error = `Execution failed in ${job.id}: ${job.error}`;
    run.state = "failed";
    await saveRun(run);
    return run;
  }
}

const MAX_CONCURRENT_READ_JOBS = 10;
export const MAX_CONCURRENT_WRITE_JOBS = 1;
export const PARALLEL_WRITING_SUPPORTED = false;

export async function executePeerReview(
  run: BridgeRun,
  targetJob: BridgeJob,
  agent: AgentAdapter
): Promise<ReviewResponse> {
  const prompt = buildPeerReviewPrompt(run, targetJob);
  const promptPath = path.join(run.artifactsDir, `peer-review-${targetJob.id}.prompt.txt`);
  const responsePath = path.join(run.artifactsDir, `peer-review-${targetJob.id}.response.txt`);
  const logPath = path.join(run.logsDir, `peer-review-${targetJob.id}.log`);

  await writeText(promptPath, prompt);

  const result = await agent.run({
    prompt,
    workspace: targetJob.isolatedWorkspace ?? run.workspace,
    timeoutMs: run.spec.timeout_minutes * 60_000,
    logPath,
    runLabel: `peer-review-${targetJob.id}`,
    autoApprove: true,
    canWrite: false,
    model: run.spec.model,
    effort: run.spec.effort ?? "highest",
    account: targetJob.account ?? null
  });

  await writeText(responsePath, result.combinedOutput);
  if (result.exitCode !== 0) {
    throw new Error(summarizeAgentFailure(result.combinedOutput));
  }

  const parsed = await parseAgentJson(reviewResponseSchema, result.combinedOutput);
  targetJob.peerReview = parsed;
  return parsed;
}

/**
 * @deprecated Multi-writer parallel dispatch and auto-integration are disabled.
 * Directory copies do not provide an OS-level security boundary against unrestricted host access
 * under --dangerously-skip-permissions, and applyIntegration suffers from TOCTOU races.
 * All write jobs execute strictly sequentially with exclusive workspace access.
 */
export async function executeIsolatedWriteBatch(
  run: BridgeRun,
  writeBatch: BridgeJob[],
  agent: AgentAdapter
): Promise<BridgeRun> {
  if (!PARALLEL_WRITING_SUPPORTED) {
    throw new Error(
      "Unsafe multi-writer dispatch is disabled: directory copies provide no security boundary under --dangerously-skip-permissions and lack OS-level restriction on Windows; auto-integration suffers from TOCTOU races. All write jobs must execute sequentially with exclusive workspace access."
    );
  }

  const baselineSnapshot = await takeWorkspaceSnapshot(run.workspace);

  // 1. Prepare isolated workspace for each worker
  for (const job of writeBatch) {
    const isoDir = path.join(run.runDir, "workspaces", job.id);
    await createIsolatedWorkspace(run.workspace, isoDir);
    job.isolatedWorkspace = isoDir;
    job.isolated = true;
  }
  await saveRun(run);

  // 2. Execute workers concurrently in their isolated workspaces
  const workerPromises = writeBatch.map(async (job) => {
    try {
      await executeJob(run, job, agent, {});
    } catch (err) {
      job.status = "failed";
      job.finishedAt = nowIso();
      job.error = err instanceof Error ? err.message : String(err);
      run.error = `Execution failed in ${job.id}: ${job.error}`;
      run.state = "failed";
      await saveRun(run).catch(() => {});
    }
  });

  await Promise.all(workerPromises);

  // Check for cancellation
  try {
    const onDisk = await loadRun(run.runId, run.stateDir);
    if (onDisk.cancelRequested) {
      run.cancelRequested = true;
    }
  } catch {}

  if (run.cancelRequested) {
    run.state = "cancelled";
    for (const job of writeBatch) {
      if (job.isolatedWorkspace) {
        await cleanupIsolatedWorkspace(job.isolatedWorkspace);
      }
    }
    await saveRun(run);
    return run;
  }

  // Check worker outcomes
  const failedJob = writeBatch.find((j) => j.status === "failed" || j.status === "blocked");
  if (failedJob || run.state === "failed") {
    if (!run.error && failedJob) {
      run.error = `Worker ${failedJob.id} failed: ${failedJob.error || failedJob.resultSummary}`;
    }
    run.state = "failed";
    for (const job of writeBatch) {
      if (job.isolatedWorkspace) {
        await cleanupIsolatedWorkspace(job.isolatedWorkspace);
      }
    }
    await saveRun(run);
    return run;
  }

  // 3. Independent Peer Review
  try {
    const reviewPromises = writeBatch.map((targetJob) => {
      return executePeerReview(run, targetJob, agent);
    });
    const reviews = await Promise.all(reviewPromises);

    for (let idx = 0; idx < reviews.length; idx++) {
      const review = reviews[idx]!;
      const targetJob = writeBatch[idx]!;
      if (review.verdict !== "pass") {
        targetJob.status = "failed";
        targetJob.error = `Peer review rejected changes (${review.verdict}): ${review.summary}`;
        run.state = "failed";
        run.error = `Peer review failed for ${targetJob.id}: ${review.summary}`;
        for (const job of writeBatch) {
          if (job.isolatedWorkspace) {
            await cleanupIsolatedWorkspace(job.isolatedWorkspace);
          }
        }
        await saveRun(run);
        return run;
      }
    }
  } catch (reviewErr) {
    const errText = reviewErr instanceof Error ? reviewErr.message : String(reviewErr);
    run.state = "failed";
    run.error = `Peer review execution failed: ${errText}`;
    for (const job of writeBatch) {
      if (job.isolatedWorkspace) {
        await cleanupIsolatedWorkspace(job.isolatedWorkspace);
      }
    }
    await saveRun(run);
    return run;
  }

  // 4. Safe Integration with conflict detection
  const changesets: WorkerChangeset[] = [];
  for (const job of writeBatch) {
    const cs = await detectWorkerChanges(baselineSnapshot, job.isolatedWorkspace!);
    cs.jobId = job.id;
    changesets.push(cs);
  }

  const liveSnapshot = await takeWorkspaceSnapshot(run.workspace);
  const conflictReport = detectIntegrationConflicts(baselineSnapshot, liveSnapshot, changesets);
  if (conflictReport.hasConflict) {
    const conflictMsg = `Safe integration aborted due to conflicts:\n${conflictReport.conflicts.join("\n")}`;
    run.state = "failed";
    run.error = conflictMsg;
    for (const job of writeBatch) {
      job.status = "failed";
      job.error = conflictMsg;
    }
    for (const job of writeBatch) {
      if (job.isolatedWorkspace) {
        await cleanupIsolatedWorkspace(job.isolatedWorkspace);
      }
    }
    await saveRun(run);
    return run;
  }

  // 5. Apply integration with rollback safety
  try {
    await applyIntegration(run.workspace, changesets, baselineSnapshot);
  } catch (applyErr) {
    const applyMsg = applyErr instanceof Error ? applyErr.message : String(applyErr);
    run.state = "failed";
    run.error = `Integration failed during file write: ${applyMsg}`;
    for (const job of writeBatch) {
      job.status = "failed";
      job.error = run.error;
    }
    for (const job of writeBatch) {
      if (job.isolatedWorkspace) {
        await cleanupIsolatedWorkspace(job.isolatedWorkspace);
      }
    }
    await saveRun(run);
    return run;
  }

  // Sync actual changed files metadata
  for (const cs of changesets) {
    const job = writeBatch.find((j) => j.id === cs.jobId);
    if (job) {
      const combined = Array.from(
        new Set([...job.changedFiles, ...cs.modifiedFiles, ...cs.addedFiles, ...cs.deletedFiles])
      );
      job.changedFiles = combined;
    }
  }

  // Clean up isolated workspaces
  for (const job of writeBatch) {
    if (job.isolatedWorkspace) {
      await cleanupIsolatedWorkspace(job.isolatedWorkspace);
    }
  }

  run.summary = summarizeCompletedJobs(run);
  await saveRun(run);
  return run;
}

async function executePendingJobs(
  run: BridgeRun,
  source: AgentSource,
  options: RunOptions
): Promise<BridgeRun> {
  const activeJobs = new Map<string, Promise<void>>();

  while (true) {
    if (run.cancelRequested) {
      await Promise.all(activeJobs.values());
      run.state = "cancelled";
      await saveRun(run);
      return run;
    }

    if (run.state === "failed") {
      await Promise.all(activeJobs.values());
      await saveRun(run);
      return run;
    }

    try {
      const onDisk = await loadRun(run.runId, run.stateDir);
      if (onDisk.cancelRequested) {
        run.cancelRequested = true;
        await Promise.all(activeJobs.values());
        run.state = "cancelled";
        await saveRun(run);
        return run;
      }
    } catch {
      // Ignore intermediate disk read errors
    }

    const pendingJobs = run.jobs
      .filter(isExecutionJobPending)
      .sort((a, b) => a.priority - b.priority || run.jobs.indexOf(a) - run.jobs.indexOf(b));

    if (pendingJobs.length === 0 && activeJobs.size === 0) {
      if (run.cancelRequested) {
        run.state = "cancelled";
        await saveRun(run);
      }
      return run;
    }

    if (pendingJobs.length === 0) {
      await Promise.race(activeJobs.values());
      continue;
    }

    const nextJob = pendingJobs[0];
    if (!nextJob) {
      if (activeJobs.size > 0) {
        await Promise.race(activeJobs.values());
      }
      continue;
    }

    if (isExclusiveJob(nextJob)) {
      if (activeJobs.size > 0) {
        // Wait for all currently active read jobs to complete before running exclusive job
        await Promise.race(activeJobs.values());
        continue;
      }

      if (writeApprovalRequired(run, nextJob, options)) {
        run.state = "pending";
        run.summary = "Plan ready. Write approval is required before execution can continue.";
        await saveRun(run);
        return run;
      }

      // All write-capable jobs (canWrite === true) and dependent follow-up jobs execute strictly
      // sequentially with exclusive workspace access.
      // Parallel writer dispatch and automatic integration are disabled because directory copies
      // provide no OS-level security boundary against unrestricted host access under
      // --dangerously-skip-permissions, and applyIntegration suffers from TOCTOU races.
      const jobPromise = (async () => {
        try {
          await executeJob(run, nextJob, source, options);
        } catch (err) {
          nextJob.status = "failed";
          nextJob.finishedAt = nowIso();
          nextJob.error = err instanceof Error ? err.message : String(err);
          run.error = `Execution failed in ${nextJob.id}: ${nextJob.error}`;
          run.state = "failed";
          await saveRun(run).catch(() => {});
        } finally {
          activeJobs.delete(nextJob.id);
        }
      })();
      activeJobs.set(nextJob.id, jobPromise);
      await jobPromise;
      continue;
    }

    // nextJob is parallelizable (read-only, independent)
    if (activeJobs.size >= MAX_CONCURRENT_READ_JOBS) {
      await Promise.race(activeJobs.values());
      continue;
    }

    for (const job of pendingJobs) {
      if (activeJobs.size >= MAX_CONCURRENT_READ_JOBS) {
        break;
      }
      if (isExclusiveJob(job)) {
        // Stop before the first exclusive job; cannot execute it or anything after it yet
        break;
      }
      if (activeJobs.has(job.id)) {
        continue;
      }

      const jobPromise = (async () => {
        try {
          await executeJob(run, job, source, options);
        } catch (err) {
          job.status = "failed";
          job.finishedAt = nowIso();
          job.error = err instanceof Error ? err.message : String(err);
          run.error = `Execution failed in ${job.id}: ${job.error}`;
          run.state = "failed";
          await saveRun(run).catch(() => {});
        } finally {
          activeJobs.delete(job.id);
        }
      })();
      activeJobs.set(job.id, jobPromise);
    }

    if (activeJobs.size > 0) {
      await Promise.race(activeJobs.values());
    }
  }
}

function createReviewJob(run: BridgeRun, passNumber: number): BridgeJob {
  const engine = reviewEngineFor(run);
  return createJob("review", nextJobSequence(run), {
    title: `Review pass ${passNumber}`,
    objective: "Review the workspace against the full run goal and success criteria.",
    successCriteria: ["The final review verdict is available."],
    canWrite: false,
    priority: 100 + passNumber,
    engine,
    account: accountForEngine(run, engine, null)
  });
}

function createReviewFollowUpJob(run: BridgeRun, review: ReviewResponse, passNumber: number): BridgeJob {
  return createJob("execution", nextJobSequence(run), {
    title: `Close review gaps ${passNumber}`,
    objective: review.next_action,
    successCriteria: review.remaining_gaps.length > 0 ? review.remaining_gaps : run.spec.success_criteria,
    canWrite: run.spec.allow_write,
    priority: 50 + passNumber,
    isFollowUp: true,
    engine: run.spec.engine,
    account: accountForEngine(run, run.spec.engine, null)
  });
}

async function executeReviewCycle(
  run: BridgeRun,
  source: AgentSource,
  passNumber: number,
  options: RunOptions
): Promise<BridgeRun> {
  const reviewJob = createReviewJob(run, passNumber);
  run.jobs.push(reviewJob);
  await saveRun(run);

  const engine = reviewJob.engine ?? run.spec.engine;
  const prompt = buildReviewPrompt(run, passNumber);
  reviewJob.status = "running";
  reviewJob.startedAt = nowIso();
  reviewJob.attempts += 1;
  await saveRun(run);

  const paths = await writeArtifacts(run, reviewJob, prompt, "");
  reviewJob.promptPath = paths.promptPath;
  reviewJob.responsePath = paths.responsePath;
  reviewJob.logPath = paths.logPath;
  await saveRun(run);

  try {
    const result = await dispatch(run, source, engine, {
      prompt,
      workspace: run.workspace,
      timeoutMs: run.spec.timeout_minutes * 60_000,
      logPath: paths.logPath,
      runLabel: reviewJob.id,
      autoApprove: engine === "agy",
      canWrite: false,
      model: run.spec.model,
      effort: run.spec.effort ?? "highest",
      account: reviewJob.account ?? null
    });
    reviewJob.runtime = result.runtime ?? null;
    await writeText(paths.responsePath, result.combinedOutput);
    if (result.exitCode !== 0) {
      throw new Error(summarizeAgentFailure(result.combinedOutput));
    }
    const parsed = await parseAgentJson(reviewResponseSchema, result.combinedOutput);
    reviewJob.finishedAt = nowIso();
    reviewJob.checksRun = parsed.checks_run;
    reviewJob.resultSummary = parsed.summary;
    run.finalReport = parsed;
    run.summary = parsed.summary;

    if (parsed.verdict === "pass") {
      reviewJob.status = "completed";
      run.state = "completed";
      await saveRun(run);
      return run;
    }

    if (parsed.verdict === "blocked") {
      reviewJob.status = "blocked";
      reviewJob.error = parsed.summary;
      run.state = "failed";
      run.error = parsed.summary;
      await saveRun(run);
      return run;
    }

    reviewJob.status = "completed";
    if (passNumber >= run.spec.review_pass_limit) {
      run.state = "failed";
      run.error = parsed.summary;
      await saveRun(run);
      return run;
    }

    run.jobs.push(createReviewFollowUpJob(run, parsed, passNumber));
    await saveRun(run);
    return run;
  } catch (error) {
    reviewJob.status = "failed";
    reviewJob.finishedAt = nowIso();
    reviewJob.error = error instanceof Error ? error.message : String(error);
    run.state = "failed";
    run.error = `Review failed: ${reviewJob.error}`;
    await saveRun(run);
    return run;
  }
}

async function continueRunInternal(
  run: BridgeRun,
  source: AgentSource,
  options: RunOptions = {}
): Promise<BridgeRun> {
  run.state = "running";
  await saveRun(run);

  const hasPlanningJob = run.jobs.some((job) => job.kind === "planning");
  if (!hasPlanningJob) {
    run = await executePlanning(run, source, options);
    if (run.state === "failed" || run.state === "pending") {
      return run;
    }
  }

  run = await executePendingJobs(run, source, options);
  if (run.state === "failed" || run.state === "cancelled" || run.state === "pending" || run.cancelRequested) {
    if (run.cancelRequested && run.state !== "cancelled") {
      run.state = "cancelled";
      await saveRun(run);
    }
    return run;
  }

  const existingReviewPasses = run.jobs.filter((job) => job.kind === "review").length;
  let passNumber = existingReviewPasses + 1;

  while (passNumber <= run.spec.review_pass_limit) {
    run = await executeReviewCycle(run, source, passNumber, options);
    if (run.state === "completed" || run.state === "failed" || run.state === "cancelled" || run.cancelRequested) {
      if (run.cancelRequested && run.state !== "cancelled") {
        run.state = "cancelled";
        await saveRun(run);
      }
      return run;
    }
    run = await executePendingJobs(run, source, options);
    if (run.state === "failed" || run.state === "cancelled" || run.state === "pending" || run.cancelRequested) {
      if (run.cancelRequested && run.state !== "cancelled") {
        run.state = "cancelled";
        await saveRun(run);
      }
      return run;
    }
    passNumber += 1;
  }

  return run;
}

export async function startRun(
  runSpec: RunSpec,
  source: AgentSource,
  options: RunOptions = {}
): Promise<BridgeRun> {
  await ensureWorkspaceExists(runSpec);
  await ensureDir(runSpec.state_dir);
  const run = await createRun(runSpec);
  if (options.allowWrite) {
    run.writeApproval = { at: nowIso(), source: "user" };
    await saveRun(run);
  }
  return continueRunInternal(run, source, options);
}

export async function resumeRun(
  runId: string,
  stateDir: string,
  source: AgentSource,
  options: RunOptions = {}
): Promise<BridgeRun> {
  const run = await loadRun(runId, stateDir);
  if (run.state === "completed" || run.state === "cancelled") {
    return run;
  }
  if (options.allowWrite) {
    run.writeApproval = { at: nowIso(), source: "user" };
    await saveRun(run);
  }
  return continueRunInternal(run, source, options);
}
