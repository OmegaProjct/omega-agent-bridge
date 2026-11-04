import { describe, expect, it } from "vitest";
import { readAgyResult, selectHighestEffort, selectStrongestModel as chooseModel } from "../src/agents/modelSelection.js";
import { parseRunSpec } from "../src/schema.js";
import type { AgentRuntime } from "../src/types.js";

const catalog = "gemini-3.8-flash-high\tFlash High\nclaude-sonnet-4-6\tSonnet Thinking\nclaude-opus-4-6-thinking\tOpus Thinking\n";
const fixed = JSON.stringify({ status: "SUCCESS", command: { name: "effort", data: { adjustable: false } } });
const adjustable = (levels: string[]) => JSON.stringify({ status: "SUCCESS", command: { name: "effort", data: { adjustable: true, current: "high", available: levels } } });
const runtime = (): AgentRuntime => ({ requestedModel: "strongest", requestedEffort: "highest", selectedModel: "claude-opus-4-6-thinking", effectiveModel: null, effectiveEffort: "fixed-thinking", effortAdjustable: false, verified: false, account: "account-2" });
const init = (model = "claude-opus-4-6-thinking") => JSON.stringify({ event: "init", init: { model } });
const result = JSON.stringify({ event: "result", result: { status: "SUCCESS", response: '{"ok":true}' } });
const selectStrongestModel = (models: string, requested: string | null) => chooseModel(models, requested, new Date("2026-10-25T12:00:00Z"));

describe("model policy", () => {
  it("defaults all new runs to strongest/highest", () => {
    const spec = parseRunSpec({ goal: "test", workspace: "." });
    expect(spec.model).toBe("strongest");
    expect(spec.effort).toBe("highest");
  });
  it("selects the newest advertised Opus Thinking version numerically", () => {
    expect(selectStrongestModel(catalog + "claude-opus-5-5-thinking\tOpus 5.5\nclaude-opus-4-10-thinking\tOpus 4.10", "strongest")).toBe("claude-opus-5-5-thinking");
    expect(selectStrongestModel(catalog + "claude-opus-4-10-thinking\tOpus 4.10", null)).toBe("claude-opus-4-10-thinking");
  });
  it("also accepts escaped tab catalog output", () => {
    expect(selectStrongestModel(catalog.replaceAll("\t", "\\t"), "strongest")).toBe("claude-opus-4-6-thinking");
  });
  it("rejects lower models, display names and unknown catalog responses", () => {
    for (const model of ["gemini-3.8-flash-high", "Gemini 3.8 Flash (Low)", "claude-sonnet-4-6"]) expect(() => selectStrongestModel(catalog, model)).toThrow("Model policy requires");
    expect(() => selectStrongestModel("claude-sonnet-4-6\tSonnet", null)).toThrow("refusing");
    expect(() => selectStrongestModel("", null)).toThrow("refusing");
  });
  it("does not silently retain an older explicit Opus pin", () => {
    expect(() => selectStrongestModel(catalog + "claude-opus-5-5-thinking\tOpus", "claude-opus-4-6-thinking")).toThrow("Model policy requires");
  });
  it("switches at midnight Berlin on November 2, even if Claude remains advertised", () => {
    expect(chooseModel(catalog, "strongest", new Date("2026-11-01T22:59:59.999Z"))).toBe("claude-opus-4-6-thinking");
    expect(chooseModel(catalog, "strongest", new Date("2026-11-01T23:00:00.000Z"))).toBe("gemini-3.8-flash-high");
    expect(chooseModel(catalog, null, new Date("2027-01-01T12:00:00Z"))).toBe("gemini-3.8-flash-high");
  });
  it("chooses the newest Flash version and its highest advertised effort", () => {
    const models = catalog + "gemini-3.8-flash-low\tLow\ngemini-3.10-flash-medium\tMedium\ngemini-3.10-flash-high\tHigh\ngemini-3.10-flash-max\tMax";
    expect(chooseModel(models, "strongest", new Date("2026-11-02T00:00:00Z"))).toBe("gemini-3.10-flash-max");
  });
  it("uses Flash earlier if Opus is already unavailable, never another family", () => {
    expect(selectStrongestModel("gemini-3.8-flash-medium\tMedium\ngemini-3.8-flash-high\tHigh", null)).toBe("gemini-3.8-flash-high");
    expect(() => chooseModel("claude-opus-4-6-thinking\tOpus\ngpt-oss-120b-medium\tOSS", "strongest", new Date("2026-11-02T00:00:00Z"))).toThrow("Gemini Flash only");
  });
  it("allows the explicit quota fallback to Flash before the date switch", () => {
    expect(chooseModel(catalog, "strongest", new Date("2026-10-25T12:00:00Z"), true)).toBe("gemini-3.8-flash-high");
    expect(() => chooseModel("claude-opus-4-6-thinking\tOpus", "strongest", new Date("2026-10-25T12:00:00Z"), true)).toThrow("refusing");
  });
  it("rejects stale Claude pins and lower Flash variants after the switch", () => {
    const models = catalog + "gemini-3.8-flash-low\tLow";
    for (const model of ["claude-opus-4-6-thinking", "gemini-3.8-flash-low"]) expect(() => chooseModel(models, model, new Date("2026-11-02T00:00:00Z"))).toThrow("Model policy requires gemini-3.8-flash-high");
  });
  it("reports fixed reasoning honestly and never labels it max", () => {
    expect(selectHighestEffort(fixed)).toEqual({ effort: "fixed-thinking", adjustable: false });
    expect(() => selectHighestEffort(fixed, "max")).toThrow("cannot be enforced");
  });
  it("chooses the highest supported effort rather than assuming max", () => {
    expect(selectHighestEffort(adjustable(["low", "medium", "high"]))).toEqual({ effort: "high", adjustable: true });
    expect(selectHighestEffort(adjustable(["max", "high", "xhigh"]))).toEqual({ effort: "max", adjustable: true });
    expect(() => selectHighestEffort(adjustable(["low", "high"]), "low")).toThrow("policy requires high");
    expect(() => selectHighestEffort(adjustable(["turbo"]))).toThrow("refusing");
    expect(() => selectHighestEffort('{}')).toThrow("Cannot verify");
  });
});

describe("CLI runtime confirmation", () => {
  it("requires the structured init model and unwraps only this invocation's result", () => {
    const details = runtime();
    expect(readAgyResult(init() + "\n" + result, details)).toEqual({ rawOutput: '{"ok":true}', error: null });
    expect(details.verified).toBe(true);
    expect(details.effectiveModel).toBe(details.selectedModel);
  });
  it("rejects missing, duplicate and mismatched model confirmations", () => {
    for (const stream of [result, init("gemini-3.8-flash-low") + "\n" + result, init() + "\n" + init() + "\n" + result]) {
      const details = runtime();
      expect(readAgyResult(stream, details).error).toContain("refusing");
      expect(details.verified).toBe(false);
    }
  });
  it("preserves a structured quota error for account failover", () => {
    const stream = init() + "\n" + JSON.stringify({ event: "result", result: { status: "ERROR", error: "RESOURCE_EXHAUSTED" } });
    expect(readAgyResult(stream, runtime()).error).toBe("RESOURCE_EXHAUSTED");
    const unverified = runtime();
    expect(readAgyResult(stream.split("\n")[1]!, unverified).error).toContain("RESOURCE_EXHAUSTED");
    expect(unverified.verified).toBe(false);
  });
});
