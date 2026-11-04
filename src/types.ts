export type EngineName = "agy" | "claude" | "codex";
export type ReportFormat = "summary" | "full" | "json";
export type RunState = "pending" | "running" | "completed" | "failed" | "cancelled";
export type JobStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "cancelled";
export type JobKind = "planning" | "execution" | "review";
export type ExecutionOutcome = "done" | "needs_followup" | "blocked";
export type ReviewVerdict = "pass" | "needs_followup" | "blocked";
export type ReviewEngine = EngineName | "auto";

export interface EngineCapabilities {
  readOnlyMode: boolean;
  structuredOutput: boolean;
  jsonSchema: boolean;
  effortControl: boolean;
  accountIsolation: "home" | "config-dir" | "state-dir";
}

export interface RunSpec {
  goal: string;
  workspace: string;
  constraints: string[];
  success_criteria: string[];
  allow_write: boolean;
  max_subjobs: number;
  timeout_minutes: number;
  report_format: ReportFormat;
  state_dir: string;
  engine: EngineName;
  planning_engine: EngineName;
  review_engine: ReviewEngine;
  allowed_engines: EngineName[];
  fallback_engines: EngineName[];
  model: string | null;
  effort: string;
  account: string | null;
  review_pass_limit: number;
  max_accounts_per_engine: number;
}

export interface AccountInfo {
  id: string;
  engine: EngineName;
  dir: string;
  authenticated: boolean;
  email: string | null;
  maskedEmail?: string | null;
  lastUsedAt?: string | null;
  cooldownUntil?: string | null;
  authStatus?: "ok" | "auth_required" | "unknown";
  lastError?: string | null;
  ignored?: boolean;
}

export interface PlannedJob {
  title: string;
  objective: string;
  success_criteria: string[];
  can_write: boolean;
  priority: number;
  engine?: EngineName | undefined;
  account?: string | null | undefined;
}

export interface PlanningResponse {
  summary: string;
  jobs: PlannedJob[];
  risks: string[];
  assumptions: string[];
}

export interface ExecutionResponse {
  summary: string;
  outcome: ExecutionOutcome;
  changed_files: string[];
  checks_run: string[];
  open_questions: string[];
  follow_up_instructions: string | null;
}

export interface ReviewResponse {
  summary: string;
  verdict: ReviewVerdict;
  checks_run: string[];
  remaining_gaps: string[];
  next_action: string;
}

export interface BridgeJob {
  id: string;
  kind: JobKind;
  title: string;
  objective: string;
  successCriteria: string[];
  canWrite: boolean;
  priority: number;
  engine?: EngineName;
  account?: string | null;
  isFollowUp?: boolean | undefined;
  isolated?: boolean | undefined;
  isolatedWorkspace?: string | undefined;
  peerReview?: ReviewResponse | null | undefined;
  status: JobStatus;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  promptPath: string | null;
  responsePath: string | null;
  logPath: string | null;
  resultSummary: string;
  changedFiles: string[];
  checksRun: string[];
  openQuestions: string[];
  followUpInstructions: string | null;
  error: string | null;
  runtime?: AgentRuntime | null;
}

export interface WriteApproval {
  at: string;
  source: "user" | "ci";
}

export interface BridgeRun {
  runId: string;
  version: 1;
  engine: EngineName;
  state: RunState;
  createdAt: string;
  updatedAt: string;
  workspace: string;
  stateDir: string;
  runDir: string;
  artifactsDir: string;
  logsDir: string;
  spec: RunSpec;
  planSummary: string;
  planningRisks: string[];
  planningAssumptions: string[];
  finalReport: ReviewResponse | null;
  summary: string;
  error: string | null;
  cancelRequested: boolean;
  writeApproval?: WriteApproval | null;
  jobs: BridgeJob[];
}

export interface AgentInvocation {
  prompt: string;
  workspace: string;
  timeoutMs: number;
  logPath: string;
  runLabel: string;
  /**
   * Legacy permission flag. New code should set `canWrite` and may keep this
   * field for backward compatibility.
   */
  autoApprove?: boolean;
  canWrite?: boolean;
  model: string | null;
  effort?: string;
  geminiOnly?: boolean;
  account?: string | null;
  responseSchema?: object;
}

export interface AgentResult {
  rawOutput: string;
  combinedOutput: string;
  exitCode: number;
  durationMs: number;
  timedOut?: boolean;
  runtime?: AgentRuntime;
}

export interface AgentRuntime {
  engine?: EngineName;
  requestedModel: string;
  requestedEffort: string;
  selectedModel: string;
  effectiveModel: string | null;
  effectiveEffort: string;
  effortAdjustable: boolean;
  verified: boolean;
  effortVerified?: boolean;
  readOnlyEnforced?: boolean;
  fallbackFrom?: string;
  fallbackReason?: string;
  account: string | null;
}

export interface AgentAdapter {
  readonly name: EngineName;
  readonly capabilities?: EngineCapabilities;
  run(invocation: AgentInvocation): Promise<AgentResult>;
}

export type AgentResolver = (engine: EngineName) => AgentAdapter;
