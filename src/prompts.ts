import type { BridgeJob, BridgeRun, RunSpec } from "./types.js";

function section(title: string, body: string): string {
  return `${title}\n${body.trim()}\n`;
}

function renderList(items: string[]): string {
  if (items.length === 0) {
    return "- none";
  }
  return items.map((item) => `- ${item}`).join("\n");
}

function renderPreviousJobContext(run: BridgeRun): string {
  const completed = run.jobs.filter((job) => job.kind === "execution" && job.status === "completed");
  if (completed.length === 0) {
    return "- none";
  }

  return completed
    .map((job) => `- ${job.title}: ${job.resultSummary || "completed"}`)
    .join("\n");
}

export function buildPlanningPrompt(spec: RunSpec): string {
  return [
    "You are the execution engine inside Omega Agent Bridge.",
    "Inspect the workspace and produce a compact job plan.",
    "For this planning step, do not change files.",
    "",
    section("Goal", spec.goal),
    section("Constraints", renderList(spec.constraints)),
    section("Success Criteria", renderList(spec.success_criteria)),
    section("Limits", [
      `- Max subjobs: ${spec.max_subjobs}`,
      `- Workspace: ${spec.workspace}`,
      `- Default execution engine: ${spec.engine}`,
      `- Allowed engines for jobs: ${spec.allowed_engines.join(", ")}`,
      "- Return JSON only.",
      "- Keep the number of jobs minimal and practical."
    ].join("\n")),
    `Return exactly this JSON shape:
{
  "summary": "string",
  "jobs": [
    {
      "title": "string",
      "objective": "string",
      "success_criteria": ["string"],
      "can_write": true,
      "priority": 1,
      "engine": "agy",
      "account": null
    }
  ],
  "risks": ["string"],
  "assumptions": ["string"]
}`,
    "Rules:",
    "- Prefer no more than the allowed max subjobs.",
    "- Each job must have a concrete outcome.",
    "- For implementation requiring file changes, include at least one writing job (can_write: true).",
    "- Parallel writing across multiple workers is unsupported and disabled: directory copies provide no OS-level security boundary against unrestricted host access under --dangerously-skip-permissions, and auto-integration suffers from TOCTOU races. All write-capable jobs execute strictly sequentially with exclusive workspace access.",
    "- Independent read-only inspection or verification tasks can execute concurrently in parallel (can_write: false).",
    "- Set can_write to true only when the job needs file changes.",
    "- Order jobs by execution priority (lower number executes first; dependent/follow-up jobs must have higher priority numbers).",
    `- engine is optional. Omit it to use the default engine (${spec.engine}). If set, it must be one of: ${spec.allowed_engines.join(", ")}.`,
    "- account is optional. Omit it to let the bridge rotate accounts. Only pin an account when reproducibility requires it.",
    "- Do not assign a job to an engine that is not listed. Do not invent account IDs."
  ].join("\n");
}

export function buildPeerReviewPrompt(
  run: BridgeRun,
  targetJob: BridgeJob
): string {
  return [
    "You are a fresh, independent reviewer invocation inside Omega Agent Bridge.",
    `You are conducting an independent peer review of the work completed by worker '${targetJob.title}' (${targetJob.id}).`,
    "You are not another writer and you have strictly read-only access to inspect the target worker's isolated workspace.",
    "You have no access to shared writable data, and you must not create, modify, or delete any files in this review step.",
    "",
    section("Run Goal", run.spec.goal),
    section("Target Worker Job Title", targetJob.title),
    section("Target Worker Objective", targetJob.objective),
    section("Target Worker Success Criteria", renderList(targetJob.successCriteria)),
    section("Target Worker Summary", targetJob.resultSummary || "No summary provided."),
    section("Target Worker Changed Files", renderList(targetJob.changedFiles)),
    section("Target Worker Checks Run", renderList(targetJob.checksRun)),
    section("Global Constraints", renderList(run.spec.constraints)),
    section("Review Instructions", [
      "- Verify that the worker's changes fulfill its stated objective and success criteria.",
      "- Check for syntax errors, regressions, logic bugs, or unintended file modifications.",
      "- Ensure global constraints were respected.",
      "- This is a strictly read-only inspection. Do not touch or modify any files.",
      "- Return JSON only."
    ].join("\n")),
    `Return exactly this JSON shape:
{
  "summary": "string",
  "verdict": "pass",
  "checks_run": ["string"],
  "remaining_gaps": ["string"],
  "next_action": "string"
}`,
    "Use verdict pass if the changes are sound and meet criteria.",
    "Use verdict needs_followup if improvements are required before integration.",
    "Use verdict blocked if the changes are fundamentally flawed or violate constraints."
  ].join("\n");
}

export function buildExecutionPrompt(run: BridgeRun, job: BridgeJob): string {
  return [
    "You are executing one bounded job inside Omega Agent Bridge.",
    job.canWrite
      ? "You may change files in the workspace if needed for this job."
      : "This job is read-only. You may run read commands such as reading files, listing directories, grep searches and git status, git ls-files, git log or git show. You must not create, modify, delete, move or rename any file, and you must not run git add, git commit, git checkout, git reset, git stash or git clean. Doing so fails this job.",
    "",
    section("Run Goal", run.spec.goal),
    section("Job Runtime", [
      `- Job ID: ${job.id}`,
      `- Engine: ${job.engine ?? run.spec.engine}`,
      `- Account: ${job.account ? "pinned" : "automatic rotation"}`
    ].join("\n")),
    section("Job Title", job.title),
    section("Job Objective", job.objective),
    section("Job Success Criteria", renderList(job.successCriteria)),
    section("Global Constraints", renderList(run.spec.constraints)),
    section("Completed Job Context", renderPreviousJobContext(run)),
    section("Reporting Rules", [
      "- Return JSON only.",
      "- changed_files must be relative paths when practical.",
      "- checks_run should list real checks or inspections you performed.",
      "- outcome must be one of done, needs_followup, blocked."
    ].join("\n")),
    `Return exactly this JSON shape:
{
  "summary": "string",
  "outcome": "done",
  "changed_files": ["string"],
  "checks_run": ["string"],
  "open_questions": ["string"],
  "follow_up_instructions": null
}`
  ].join("\n");
}

export function buildReviewPrompt(run: BridgeRun, passNumber: number): string {
  return [
    "You are the final reviewer inside Omega Agent Bridge.",
    "Inspect the workspace against the run goal and success criteria.",
    "Do not change files in this review step.",
    "",
    section("Run Goal", run.spec.goal),
    section("Success Criteria", renderList(run.spec.success_criteria)),
    section("Constraints", renderList(run.spec.constraints)),
    section("Execution Summary", renderPreviousJobContext(run)),
    section("Review Context", [
      `- Review pass: ${passNumber}`,
      `- Review engine: ${run.spec.review_engine}`,
      `- Workspace: ${run.workspace}`,
      "- This review is read-only. Do not create, modify, delete, move, or rename files."
    ].join("\n")),
    `Return exactly this JSON shape:
{
  "summary": "string",
  "verdict": "pass",
  "checks_run": ["string"],
  "remaining_gaps": ["string"],
  "next_action": "string"
}`,
    "Use verdict needs_followup when the run is close but incomplete.",
    "Use verdict blocked only when the remaining issue cannot be resolved from the current workspace and prompt context."
  ].join("\n");
}
