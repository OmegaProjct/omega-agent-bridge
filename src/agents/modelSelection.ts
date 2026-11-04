import type { AgentRuntime } from "../types.js";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const GEMINI_ONLY_FROM = Date.parse("2026-11-02T00:00:00+01:00"); // User's access change at midnight in Europe/Berlin.

export function selectStrongestModel(catalog: string, requested: string | null, now = new Date(), geminiOnly = false): string {
  const models = catalog.split(/\r?\n/).map(line => line.split(/\t|\\t/)[0]?.trim() ?? "");
  const opus = models.filter(model => /^claude-opus-\d+(?:-\d+)*-thinking$/.test(model));
  const flash = models.filter(model => /^gemini-\d+(?:\.\d+)*-flash-(low|medium|high|xhigh|max)$/.test(model));
  const candidates = !geminiOnly && now.getTime() < GEMINI_ONLY_FROM && opus.length > 0 ? opus : flash;
  candidates.sort((left, right) => {
    const a = left.match(/\d+/g)!.map(Number);
    const b = right.match(/\d+/g)!.map(Number);
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      if ((a[index] ?? 0) !== (b[index] ?? 0)) return (b[index] ?? 0) - (a[index] ?? 0);
    }
    return EFFORTS.indexOf(right.split("-").at(-1)!) - EFFORTS.indexOf(left.split("-").at(-1)!);
  });
  const selected = candidates[0];
  if (!selected) throw new Error("No supported model is available for the date policy (Gemini Flash only from 2026-11-02 Europe/Berlin); refusing an unknown model or default fallback.");
  if (requested && requested !== "strongest" && requested !== selected) {
    throw new Error(`Model policy requires ${selected}; requested ${requested}. Use model: strongest.`);
  }
  return selected;
}

export function selectHighestEffort(output: string, requested = "highest"): { effort: string; adjustable: boolean } {
  const response = JSON.parse(output) as { status?: string; command?: { name?: string; data?: { adjustable?: boolean; current?: string; available?: string[] } } };
  const data = response.command?.data;
  if (response.status !== "SUCCESS" || response.command?.name !== "effort" || typeof data?.adjustable !== "boolean") {
    throw new Error("Cannot verify the model's reasoning capabilities; refusing to run.");
  }
  if (!data.adjustable) {
    if (requested !== "highest") throw new Error(`The selected Thinking model has fixed reasoning; effort ${requested} cannot be enforced.`);
    return { effort: "fixed-thinking", adjustable: false };
  }
  const available = data.available;
  if (!Array.isArray(available) || available.length === 0 || available.some(level => !EFFORTS.includes(level))) {
    throw new Error("Unknown reasoning effort levels; refusing to guess the highest level.");
  }
  const effort = EFFORTS.filter(level => available.includes(level)).at(-1)!;
  if (requested !== "highest" && requested !== effort) throw new Error(`Effort policy requires ${effort}; requested ${requested}.`);
  return { effort, adjustable: true };
}

export interface AgyEvent {
  event?: string;
  init?: { model?: string };
  result?: { status?: string; response?: string; error?: string };
}

export function readAgyResult(output: string, runtime: AgentRuntime): { rawOutput: string; error: string | null } {
  let response: AgyEvent["result"];
  let initCount = 0;
  let mismatch = false;
  for (const line of output.split(/\r?\n/).filter(line => line.trim())) {
    const event = JSON.parse(line) as AgyEvent;
    if (event.event === "init") {
      initCount++;
      runtime.effectiveModel = event.init?.model ?? null;
      if (runtime.effectiveModel !== runtime.selectedModel) mismatch = true;
    }
    if (event.event === "result") response = event.result;
  }
  runtime.verified = initCount === 1 && !mismatch && runtime.effectiveModel === runtime.selectedModel;
  if (!runtime.verified) return { rawOutput: response?.response ?? "", error: [response?.error, "No matching CLI init model confirmation; refusing an unverified result or model fallback."].filter(Boolean).join("\n") };
  if (response?.status !== "SUCCESS") return { rawOutput: response?.response ?? "", error: response?.error || "The CLI did not return a successful structured result." };
  return { rawOutput: response.response ?? "", error: null };
}
