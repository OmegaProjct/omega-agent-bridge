import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const catalog = "claude-opus-4-6-thinking\tOpus\ngemini-3.8-flash-high\tFlash High";
const state = vi.hoisted(() => ({
  catalog: "",
  failures: [] as Array<string | null>,
  calls: [] as Array<{ model: string; effort: string | null; prompt: string; account: string | null }>
}));

vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const execute = async (_binary: string, args: string[]) => {
    if (args[0] === "models") return { stdout: state.catalog, stderr: "" };
    const model = args[args.indexOf("--model") + 1]!;
    const data = model.startsWith("claude-") ? { adjustable: false } : { adjustable: true, current: "high", available: ["low", "medium", "high"] };
    return { stdout: JSON.stringify({ status: "SUCCESS", command: { name: "effort", data } }), stderr: "" };
  };
  return {
    ...original,
    execFile: Object.assign(() => {}, { [promisify.custom]: execute }),
    spawn: (_binary: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      const model = args[args.indexOf("--model") + 1]!;
      const effortIndex = args.indexOf("--effort");
      state.calls.push({ model, effort: effortIndex < 0 ? null : args[effortIndex + 1]!, prompt: args[args.indexOf("--print") + 1]!, account: options?.env?.USERPROFILE ? path.basename(options.env.USERPROFILE) : null });
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => child.emit("close", 1) });
      const error = state.failures.shift() ?? null;
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ event: "init", init: { model } }) + "\n");
        child.stdout.write(JSON.stringify({ event: "result", result: error ? { status: "ERROR", error } : { status: "SUCCESS", response: '{"ok":true}' } }) + "\n");
        child.emit("close", error ? 1 : 0);
      });
      return child;
    }
  };
});

import { AgyAdapter } from "../src/agents/agy.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
  delete process.env.OMEGA_AGENT_BRIDGE_ACCOUNT_HOMES;
  delete process.env.OMEGA_AGENT_BRIDGE_ACCOUNT_HOME;
  state.catalog = catalog;
  state.failures = [];
  state.calls = [];
});
afterEach(() => vi.useRealTimers());

const invocation = () => ({ prompt: "Complete the original bounded task. Read-only constraints still apply.", workspace: process.cwd(), timeoutMs: 1000, logPath: "unused.log", runLabel: "test", autoApprove: false, model: "strongest", effort: "highest", account: "account-2" });

describe("Opus quota fallback", () => {
  it("retries immediately with Flash High and keeps later jobs on Flash", async () => {
    state.failures = ["RESOURCE_EXHAUSTED: Opus quota reached", null, null];
    const adapter = new AgyAdapter("fake-agy");
    const result = await adapter.run(invocation());
    expect(result.exitCode).toBe(0);
    expect(result.runtime).toMatchObject({ effectiveModel: "gemini-3.8-flash-high", effectiveEffort: "high", fallbackFrom: "claude-opus-4-6-thinking", fallbackReason: "opus_quota_exhausted", verified: true, account: "account-2" });
    expect(state.calls[1]?.effort).toBe("high");
    expect(state.calls[1]?.prompt).toContain("Inspect the current workspace");
    expect(state.calls[1]?.prompt).toContain("original bounded task");
    expect((await adapter.run(invocation())).runtime?.fallbackReason).toBe("opus_quota_exhausted");
    expect(state.calls.map(call => call.model)).toEqual(["claude-opus-4-6-thinking", "gemini-3.8-flash-high", "gemini-3.8-flash-high"]);
  });
  it("tries Opus on every configured account before falling back to Gemini", async () => {
    const account1 = path.join(process.cwd(), "account-1");
    const account2 = path.join(process.cwd(), "account-2");
    process.env.OMEGA_AGENT_BRIDGE_ACCOUNT_HOMES = `${account1}${path.delimiter}${account2}`;
    state.failures = ["RESOURCE_EXHAUSTED: Opus quota reached", "RESOURCE_EXHAUSTED: Opus quota reached", null];

    const result = await new AgyAdapter("fake-agy").run({ ...invocation(), account: null });

    expect(result.exitCode).toBe(0);
    expect(result.runtime).toMatchObject({ account: "account-1", fallbackFrom: "claude-opus-4-6-thinking", fallbackReason: "opus_quota_exhausted" });
    expect(state.calls.map(({ account, model }) => [account, model])).toEqual([
      ["account-1", "claude-opus-4-6-thinking"],
      ["account-2", "claude-opus-4-6-thinking"],
      ["account-1", "gemini-3.8-flash-high"]
    ]);
  });
  it("continues with Opus on the next account when it still has quota", async () => {
    process.env.OMEGA_AGENT_BRIDGE_ACCOUNT_HOMES = ["account-1", "account-2"].map(name => path.join(process.cwd(), name)).join(path.delimiter);
    state.failures = ["RESOURCE_EXHAUSTED: Opus quota reached", null];

    const result = await new AgyAdapter("fake-agy").run({ ...invocation(), account: null });

    expect(result.exitCode).toBe(0);
    expect(result.runtime?.account).toBe("account-2");
    expect(result.runtime?.fallbackReason).toBeUndefined();
    expect(state.calls.map(({ account, model }) => [account, model])).toEqual([
      ["account-1", "claude-opus-4-6-thinking"],
      ["account-2", "claude-opus-4-6-thinking"]
    ]);
  });
  it("does not change model on network or other non-quota errors", async () => {
    state.failures = ["NETWORK_ERROR: connection reset"];
    expect((await new AgyAdapter("fake-agy").run(invocation())).exitCode).toBe(1);
    expect(state.calls.map(call => call.model)).toEqual(["claude-opus-4-6-thinking"]);
  });
  it("stops if Flash is exhausted too, without retry loops or returning to Opus", async () => {
    state.failures = ["RESOURCE_EXHAUSTED", "RESOURCE_EXHAUSTED"];
    const result = await new AgyAdapter("fake-agy").run(invocation());
    expect(result.exitCode).toBe(1);
    expect(result.runtime?.effectiveModel).toBe("gemini-3.8-flash-high");
    expect(state.calls).toHaveLength(2);
  });
  it("leaves healthy Opus runs unchanged", async () => {
    const result = await new AgyAdapter("fake-agy").run(invocation());
    expect(result.runtime?.effectiveModel).toBe("claude-opus-4-6-thinking");
    expect(result.runtime?.fallbackReason).toBeUndefined();
    expect(state.calls).toHaveLength(1);
  });
  it("still starts directly on Flash after the November cutoff", async () => {
    vi.setSystemTime(new Date("2026-11-02T00:00:00+01:00"));
    const result = await new AgyAdapter("fake-agy").run(invocation());
    expect(result.runtime).toMatchObject({ effectiveModel: "gemini-3.8-flash-high", effectiveEffort: "high", verified: true });
    expect(result.runtime?.fallbackReason).toBeUndefined();
    expect(state.calls).toHaveLength(1);
  });
  it("fails visibly if no allowed Flash model is available", async () => {
    state.catalog = "claude-opus-4-6-thinking\tOpus";
    state.failures = ["RESOURCE_EXHAUSTED"];
    await expect(new AgyAdapter("fake-agy").run(invocation())).rejects.toThrow("No supported model");
    expect(state.calls).toHaveLength(1);
  });
});
