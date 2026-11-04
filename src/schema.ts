import os from "node:os";
import path from "node:path";
import { z } from "zod";

import type { RunSpec } from "./types.js";

const reportFormatSchema = z.enum(["summary", "full", "json"]);
export const engineSchema = z.enum(["agy", "claude", "codex"]);
export const reviewEngineSchema = z.union([engineSchema, z.literal("auto")]);

export function defaultStateDir(): string {
  return path.join(os.homedir(), ".omega-agent-bridge");
}

export function accountsDir(stateDir?: string): string {
  return path.join(stateDir || defaultStateDir(), "accounts");
}

export function engineAccountsDir(stateDir: string | undefined, engine: string): string {
  return path.join(accountsDir(stateDir), engine);
}

const rawRunSpecSchema = z.object({
  goal: z.string().trim().min(1),
  workspace: z.string().trim().min(1),
  constraints: z.array(z.string().trim().min(1)).default([]),
  success_criteria: z.array(z.string().trim().min(1)).default([]),
  allow_write: z.boolean().default(false),
  max_subjobs: z.number().int().min(1).max(12).default(4),
  timeout_minutes: z.number().int().min(1).max(240).default(30),
  report_format: reportFormatSchema.default("summary"),
  state_dir: z.string().trim().min(1).optional(),
  engine: engineSchema.default("agy"),
  planning_engine: engineSchema.optional(),
  review_engine: reviewEngineSchema.optional(),
  allowed_engines: z.array(engineSchema).min(1).optional(),
  fallback_engines: z.array(engineSchema).default([]),
  model: z.string().trim().min(1).nullable().optional().default("strongest"),
  effort: z.enum(["highest", "low", "medium", "high", "xhigh", "max"]).default("highest"),
  account: z.string().trim().min(1).nullable().optional().default(null),
  review_pass_limit: z.number().int().min(1).max(3).default(2),
  max_accounts_per_engine: z.number().int().min(1).max(100).default(20)
});

export const planningResponseSchema = z.object({
  summary: z.string().trim().min(1),
  jobs: z.array(z.object({
    title: z.string().trim().min(1),
    objective: z.string().trim().min(1),
    success_criteria: z.array(z.string().trim().min(1)).min(1),
    can_write: z.boolean(),
    priority: z.number().int().min(1).max(99),
    engine: engineSchema.optional(),
    account: z.string().trim().min(1).nullable().optional()
  })).max(12),
  risks: z.array(z.string().trim().min(1)).default([]),
  assumptions: z.array(z.string().trim().min(1)).default([])
});

export const executionResponseSchema = z.object({
  summary: z.string().trim().min(1),
  outcome: z.enum(["done", "needs_followup", "blocked"]),
  changed_files: z.array(z.string().trim().min(1)).default([]),
  checks_run: z.array(z.string().trim().min(1)).default([]),
  open_questions: z.array(z.string().trim().min(1)).default([]),
  follow_up_instructions: z.string().trim().min(1).nullable().default(null)
});

export const reviewResponseSchema = z.object({
  summary: z.string().trim().min(1),
  verdict: z.enum(["pass", "needs_followup", "blocked"]),
  checks_run: z.array(z.string().trim().min(1)).default([]),
  remaining_gaps: z.array(z.string().trim().min(1)).default([]),
  next_action: z.string().trim().min(1)
});

export function parseRunSpec(input: unknown, baseDir: string = process.cwd()): RunSpec {
  const parsed = rawRunSpecSchema.parse(input);
  const workspace = path.resolve(baseDir, parsed.workspace);
  const stateDir = parsed.state_dir
    ? path.resolve(baseDir, parsed.state_dir)
    : defaultStateDir();
  const allowedEngines = parsed.allowed_engines ?? [parsed.engine];

  if (!allowedEngines.includes(parsed.engine)) {
    throw new Error(
      `allowed_engines must include the default execution engine '${parsed.engine}'.`
    );
  }
  for (const engine of parsed.fallback_engines) {
    if (!allowedEngines.includes(engine)) {
      throw new Error(
        `fallback_engines contains '${engine}', which is not in allowed_engines.`
      );
    }
  }

  return {
    ...parsed,
    workspace,
    state_dir: stateDir,
    planning_engine: parsed.planning_engine ?? parsed.engine,
    review_engine: parsed.review_engine ?? parsed.engine,
    allowed_engines: allowedEngines
  };
}
